require('dotenv').config();
const { Worker, QueueScheduler } = require('bullmq');
const IORedis = require('ioredis');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { transcribe } = require('./services/asr');
const { synthesize } = require('./services/tts');
const { translateText } = require('./services/translate');
const { enhanceAudio } = require('./services/enhance');
const { retry } = require('./utils/retry');

// If ffmpeg is not in PATH, set path here (uncomment and edit):
// ffmpeg.setFfmpegPath('C:/ffmpeg/bin/ffmpeg.exe');

// If OPENAI_API_KEY_FILE is provided via Docker secret, load it into env for asr service
if (!process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY_FILE) {
  try {
    const key = fs.readFileSync(process.env.OPENAI_API_KEY_FILE, 'utf8').trim();
    if (key) process.env.OPENAI_API_KEY = key;
  } catch (e) {
    // ignore
  }
}

const connection = new IORedis(process.env.REDIS_URL);
new QueueScheduler('media-jobs', { connection });

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';

// Configurable SRT grouping params (can be set via .env)
const SRT_MAX_WORDS = parseInt(process.env.SRT_MAX_WORDS || '7', 10);
const SRT_MAX_LINE_DURATION = parseFloat(process.env.SRT_MAX_LINE_DURATION || '4.0');
const SRT_MAX_CHARS = parseInt(process.env.SRT_MAX_CHARS || '80', 10);

// Normalize/parse various ASR response formats into a common shape: { text: string, segments: [{text,start,end,words?}] }
function normalizeAsrResponse(asrResp) {
  if (!asrResp) return { text: '', segments: [] };
  if (typeof asrResp === 'string') return { text: asrResp, segments: [] };

  // OpenAI verbose_json or similar
  if (typeof asrResp.text === 'string' && Array.isArray(asrResp.segments)) {
    return { text: asrResp.text, segments: asrResp.segments.map(s => ({ text: s.text || '', start: Number(s.start || 0), end: Number(s.end || 0), words: s.words })) };
  }

  // Generic segments array (whisper.cpp, whispr-derived formats)
  if (Array.isArray(asrResp.segments)) {
    const segments = asrResp.segments.map(s => {
      const text = s.text || s.transcript || '';
      const start = Number(s.start || s.begin || s.seek || 0);
      const end = Number(s.end || (s.start && s.duration ? Number(s.start) + Number(s.duration) : 0));
      const words = Array.isArray(s.words) ? s.words.map(w => ({ word: w.word || w.text || w.token, start: Number(w.start || w.startTime || 0), end: Number(w.end || w.endTime || 0) })) : undefined;
      return { text, start, end, words };
    });
    const text = (asrResp.text && typeof asrResp.text === 'string') ? asrResp.text : segments.map(s => s.text).join(' ').trim();
    return { text, segments };
  }

  // Google Speech-to-Text style responses
  if (Array.isArray(asrResp.results)) {
    let text = '';
    const words = [];
    asrResp.results.forEach(result => {
      if (Array.isArray(result.alternatives) && result.alternatives[0]) {
        const alt = result.alternatives[0];
        if (alt.transcript) text += (text ? ' ' : '') + alt.transcript;
        if (Array.isArray(alt.words)) {
          alt.words.forEach(w => {
            // Google returns startTime/endTime as objects {seconds,nanos}
            let start = 0, end = 0;
            if (w.startTime && (w.startTime.seconds || w.startTime.nanos)) {
              start = Number(w.startTime.seconds || 0) + Number(w.startTime.nanos || 0) / 1e9;
            } else if (typeof w.startTime === 'number') start = w.startTime;
            if (w.endTime && (w.endTime.seconds || w.endTime.nanos)) {
              end = Number(w.endTime.seconds || 0) + Number(w.endTime.nanos || 0) / 1e9;
            } else if (typeof w.endTime === 'number') end = w.endTime;
            words.push({ word: w.word, start, end });
          });
        }
      }
    });
    // turn words into simple segments (one-word segments) so downstream code can use timing
    const segments = words.map(w => ({ text: w.word, start: w.start, end: w.end, words: [{ word: w.word, start: w.start, end: w.end }] }));
    return { text: text.trim(), segments };
  }

  // Unknown shape -> best-effort stringify
  try { return { text: String(asrResp), segments: [] }; } catch (e) { return { text: '', segments: [] }; }
}

const worker = new Worker('media-jobs', async (job) => {
  if (job.name !== 'process-video') return;
  const { id, path: filePath, originalname } = job.data;
  if (!fs.existsSync(filePath)) throw new Error('source file not found');

  const baseName = path.parse(filePath).name;
  const outAudio = path.join(UPLOAD_DIR, `${baseName}-audio.wav`);
  const outTranscript = path.join(UPLOAD_DIR, `${baseName}-transcript.txt`);
  const outTranslated = path.join(UPLOAD_DIR, `${baseName}-translated.txt`);
  const outTts = path.join(UPLOAD_DIR, `${baseName}-tts.mp3`);

  // Step 1: extract audio
  await new Promise((resolve, reject) => {
    let lastProgress = 0;
    ffmpeg(filePath)
      .noVideo()
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('progress', progress => {
        const p = Math.min(20, Math.floor((progress.percent || 0) / 5));
        if (p > lastProgress) {
          lastProgress = p;
          job.updateProgress(p).catch(() => {});
        }
      })
      .on('end', () => resolve())
      .on('error', err => reject(err))
      .save(outAudio);
  });

  // Optional Step: enhance audio (denoise) before ASR
  const enhanceFlag = (process.env.ENHANCE === 'true') || (job.data && job.data.enhance && (job.data.enhance === 'true' || job.data.enhance === true));
  const outAudioEnhanced = path.join(UPLOAD_DIR, `${baseName}-audio-enhanced.wav`);
  let audioForAsr = outAudio;
  if (enhanceFlag) {
    try {
      job.updateProgress(15).catch(() => {});
      await enhanceAudio(outAudio, outAudioEnhanced);
      audioForAsr = outAudioEnhanced;
      job.updateProgress(20).catch(() => {});
    } catch (err) {
      // enhancement failed; write marker and continue with original audio
      fs.writeFileSync(path.join(UPLOAD_DIR, `${baseName}-enhance.error.txt`), `Enhance error: ${err && err.message}`,'utf8');
      audioForAsr = outAudio;
    }
  }

  // Step 2: real transcription using configured ASR provider
  job.updateProgress(25).catch(() => {});
  let transcriptText = '';
  let asrStructured = null; // populated when ASR returns verbose_json with timing
  try {
    const asrResp = await transcribe(audioForAsr);
    const norm = normalizeAsrResponse(asrResp);
    asrStructured = norm; // normalized structure
    transcriptText = norm.text || (Array.isArray(norm.segments) ? norm.segments.map(s => s.text).join(' ').trim() : '');
    // write structured JSON for debugging/inspection
    try { fs.writeFileSync(outTranscript + '.json', JSON.stringify(norm, null, 2), 'utf8'); } catch (e) {}
  } catch (err) {
    transcriptText = `ASR error: ${err.message}`;
  }
  const transcriptFull = `TRANSCRIPT\nSource: ${originalname}\nGenerated at: ${new Date().toISOString()}\n\n${transcriptText}\n`;
  fs.writeFileSync(outTranscript, transcriptFull, 'utf8');

  // Step 3: translate transcript using configured provider
  job.updateProgress(45).catch(() => {});
  let translatedText = '';
  const targetLang = process.env.TRANSLATE_TARGET || 'id';
  try {
    // translateText expects plain text and a target language code like 'id' or 'en'
    translatedText = await translateText(transcriptText, targetLang);
  } catch (err) {
    translatedText = `TRANSLATION error: ${err.message}`;
  }
  fs.writeFileSync(outTranslated, translatedText, 'utf8');

  // Step 4: synthesize translated text to speech (Google Cloud TTS)
  try {
    job.updateProgress(55).catch(() => {});
    // determine TTS language code from targetLang (basic mapping)
    const langMap = { id: 'id-ID', en: 'en-US' };
    const ttsLang = langMap[targetLang] || (process.env.TTS_LANGUAGE || 'id-ID');
    // use translatedText as input; fallback to transcriptText
    const ttsInput = (translatedText && !translatedText.startsWith('TRANSLATION error')) ? translatedText : transcriptText;
    await synthesize(ttsInput, outTts, { audioEncoding: 'MP3', languageCode: ttsLang });
    job.updateProgress(85).catch(() => {});
  } catch (err) {
    // if TTS fails, write an error placeholder file
    const errMsg = `TTS error: ${err.message}`;
    fs.writeFileSync(outTts + '.error.txt', errMsg, 'utf8');
  }

  // Step 5: merge TTS audio into original video (overdub)
  // Validate input: ensure original file actually contains a video stream before attempting merge
  async function hasVideoStream(file) {
    return await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(file, (err, data) => {
        if (err) return reject(err);
        const streams = (data && data.streams) || [];
        const found = streams.some(s => s.codec_type === 'video');
        resolve(found);
      });
    });
  }

  // Modes: MERGE_MODE=replace -> replace original audio with TTS
  //        MERGE_MODE=mix     -> mix original audio + TTS (amix)
  // Optional: BURN_SUBTITLES=true -> burn a simple full-duration SRT containing the translated text
  // allow per-job override from job data (submitted via upload form)
  const mergeMode = ((job.data && job.data.mergeMode) || process.env.MERGE_MODE || 'replace').toString().toLowerCase();
  const burnRaw = (job.data && typeof job.data.burnSubtitles !== 'undefined') ? job.data.burnSubtitles : process.env.BURN_SUBTITLES;
  const burnSubtitles = (typeof burnRaw === 'string' ? burnRaw.toLowerCase() === 'true' : Boolean(burnRaw));
  const outDubbed = path.join(UPLOAD_DIR, `${baseName}-dubbed.mp4`);
  let dubbedCreated = false;

  async function getDurationSeconds(file) {
    return await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(file, (err, data) => {
        if (err) return reject(err);
        const d = data && data.format && data.format.duration ? Number(data.format.duration) : 0;
        resolve(d);
      });
    });
  }

  function formatSrtTime(sec) {
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = Math.floor(sec % 60);
    const ms = Math.floor((sec - Math.floor(sec)) * 1000);
    return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
  }

  // Segment transcript into timed SRT entries by splitting into sentences and distributing durations proportionally
  function segmentTranscriptToSrt(text, totalSeconds) {
    if (!text) return '';
    // naive sentence split
    const parts = text
      .replace(/\n+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (!parts.length) return '';
    const totalChars = parts.reduce((s, p) => s + p.length, 0);
    let cursor = 0;
    let srt = '';
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const chars = p.length;
      const duration = totalSeconds * (chars / totalChars);
      const start = cursor;
      const end = cursor + duration;
      srt += `${i+1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${p}\n\n`;
      cursor = end;
    }
    return srt;
  }

  try {
    // Only attempt merge if original input is a video container (has video stream)
    const isVideo = await hasVideoStream(filePath);
    if (!isVideo) {
      // skip merge for audio-only inputs; write a small marker for visibility
      fs.writeFileSync(path.join(UPLOAD_DIR, `${baseName}-merge.skip.txt`), 'No video stream found; skipping merge.', 'utf8');
      job.updateProgress(95).catch(() => {});
    } else {
      const dur = await getDurationSeconds(filePath);
      // create timed SRT if requested
      let srtPath = null;
      if (burnSubtitles) {
        srtPath = path.join(UPLOAD_DIR, `${baseName}.srt`);
        // Prefer word-level timestamps from ASR if available
        let srtContent = '';
        const srcText = (translatedText && !translatedText.startsWith('TRANSLATION error')) ? translatedText : transcriptText;
        if (asrStructured && Array.isArray(asrStructured.segments) && asrStructured.segments.length) {
          // If word-level timings are available in segments, build compact subtitle chunks
          const hasWords = Array.isArray(asrStructured.segments[0].words);
          if (hasWords) {
            // flatten words across segments
            const words = [];
            asrStructured.segments.forEach(seg => {
              (seg.words || []).forEach(w => {
                // expected word object: { word: 'text', start: x, end: y }
                words.push(w);
              });
            });
            // group words into lines according to configurable rules
            const maxWords = SRT_MAX_WORDS;
            const maxDur = SRT_MAX_LINE_DURATION;
            const maxChars = SRT_MAX_CHARS;
            let i = 0;
            let idx = 1;
            while (i < words.length) {
              const start = Number(words[i].start) || 0;
              let j = i;
              let end = Number(words[i].end) || start;
              const parts = [];
              let chars = 0;
              while (j < words.length && parts.length < maxWords) {
                const w = words[j];
                const wStart = Number(w.start) || end;
                const wEnd = Number(w.end) || wStart;
                // if adding this word exceeds maxDur and we already have at least one word, break
                if ((wEnd - start) > maxDur && parts.length > 0) break;
                // if adding this word exceeds maxChars and we already have at least one word, break
                const wordLen = String(w.word || '').length + 1;
                if ((chars + wordLen) > maxChars && parts.length > 0) break;
                parts.push(w.word);
                chars += wordLen;
                end = wEnd;
                j++;
              }
              srtContent += `${idx}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${parts.join(' ')}\n\n`;
              idx++;
              i = j;
            }
          } else {
            // use segment-level timing
            let idx = 1;
            asrStructured.segments.forEach(s => {
              const st = Number(s.start) || 0;
              const ed = Number(s.end) || (st + (s.duration || 0));
              srtContent += `${idx}\n${formatSrtTime(st)} --> ${formatSrtTime(ed)}\n${(s.text || '').trim()}\n\n`;
              idx++;
            });
          }
        }

        // fallback: if we didn't build srtContent from ASR timestamps, use naive segmentation on source text
        if (!srtContent) {
          const srtText = srcText;
          srtContent = segmentTranscriptToSrt(srtText, dur || 1);
        }

        fs.writeFileSync(srtPath, srtContent, 'utf8');
      }

      // Pre-probe TTS duration when mixing so we can build fade filters (must await outside the non-async Promise callback)
      let ttsDurationSec = 0;
      if (mergeMode === 'mix') {
        try { ttsDurationSec = await getDurationSeconds(outTts); } catch (e) { ttsDurationSec = 0; }
      }

      await new Promise((resolve, reject) => {
        let command = ffmpeg(filePath);
        // input TTS audio as second input
        command = command.input(outTts);

        if (mergeMode === 'mix') {
          // Build filter chain: reduce original volume, apply short fade to TTS, mix and normalize
          const fadeDur = Math.min(0.3, ttsDurationSec / 5);
          const fadeOutStart = Math.max(0, (ttsDurationSec - fadeDur));
          const amixFilter = `[0:a]volume=0.7[a0];[1:a]afade=t=in:st=0:d=${fadeDur},afade=t=out:st=${fadeOutStart}:d=${fadeDur}[a1];[a0][a1]amix=inputs=2:duration=shortest:dropout_transition=0, dynaudnorm[aout]`;
          command = command.complexFilter([amixFilter], ['aout']);
          // map video and mixed audio
          command = command.outputOptions(['-map 0:v', '-map [aout]', '-c:v copy', '-c:a aac', '-shortest']);
        } else {
          // default replace: map video from input 0 and audio from input 1
          command = command.outputOptions(['-map 0:v', '-map 1:a', '-c:v copy', '-c:a aac', '-shortest']);
        }

        // burn subtitles if requested
        if (burnSubtitles && srtPath) {
          // apply subtitles filter; note: path must be absolute and escaped
          const absSrt = path.resolve(srtPath);
          command = command.outputOptions([`-vf subtitles=${absSrt}`]);
        }

        command
          .on('start', () => job.updateProgress(90).catch(() => {}))
          .on('end', () => resolve())
          .on('error', err => reject(err))
          .save(outDubbed);
      });

      // include dubbed path in result
      dubbedCreated = true;
      job.updateProgress(95).catch(() => {});
    }
  } catch (err) {
    // merging failed; write an error note
    const errMsg = `Merge error: ${err && err.message}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, `${baseName}-merge.error.txt`), errMsg, 'utf8');
  }

  // Finalize
  job.updateProgress(100).catch(() => {});
  const result = { audio: outAudio, transcript: outTranscript, translated: outTranslated, tts: outTts, dubbed: dubbedCreated ? outDubbed : null };
  if (fs.existsSync(outAudioEnhanced)) result.enhancedAudio = outAudioEnhanced;
  return result;
}, { connection });

worker.on('completed', (job, returnvalue) => {
  console.log(`Job ${job.id} completed. Outputs:`, returnvalue);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed: ${err && err.message}`);
});