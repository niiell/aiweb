// ASR service (pluggable)
// Exports: transcribe(filePath) -> Promise<string|object>

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const FormData = require('form-data');
const { retry } = require('../utils/retry');

async function transcribeMock(filePath) {
  // read file metadata and return placeholder text
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  return `TRANSCRIPT MOCK - file=${path.basename(filePath)} size=${stat ? stat.size : 'n/a'}`;
}

async function transcribeOpenAI(filePath) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set in environment');

  const model = process.env.OPENAI_ASR_MODEL || 'whisper-1';
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('model', model);
  // if caller requests timestamps, ask for verbose_json which returns segments with timing
  if (process.env.ASR_TIMESTAMPS === 'true') {
    form.append('response_format', 'verbose_json');
  }
  if (process.env.ASR_LANGUAGE) form.append('language', process.env.ASR_LANGUAGE);

  const headers = Object.assign({ Authorization: `Bearer ${key}` }, form.getHeaders());

  const doPost = async () => {
    const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 5 * 60 * 1000 // 5 minutes
    });

    if (resp.data) {
      // If verbose_json requested, OpenAI returns an object with segments and text
      if (typeof resp.data === 'object') return resp.data;
      if (typeof resp.data === 'string') return resp.data;
      if (resp.data.text) return resp.data.text;
      if (resp.data.transcript) return resp.data.transcript;
    }
    throw new Error('Unexpected response from OpenAI ASR');
  };

  return await retry(doPost, { retries: 3, minDelay: 500, factor: 2 });
}

// Google Cloud Speech-to-Text provider implementation
async function transcribeGoogle(filePath) {
  let SpeechClient;
  try {
    // require lazily so the module is optional unless the provider is used
    ({ SpeechClient } = require('@google-cloud/speech'));
  } catch (err) {
    throw new Error('Missing @google-cloud/speech package. Install it with: npm install @google-cloud/speech');
  }

  // Build client options based on environment variables
  const clientOptions = {};
  if (process.env.GOOGLE_CREDENTIALS) {
    // GOOGLE_CREDENTIALS may contain a JSON service account payload
    try {
      clientOptions.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } catch (e) {
      throw new Error('Failed to parse GOOGLE_CREDENTIALS environment variable as JSON');
    }
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (fs.existsSync(keyPath)) clientOptions.keyFilename = keyPath; // client will use this file
    else console.warn('GOOGLE_APPLICATION_CREDENTIALS is set but file does not exist:', keyPath);
  }

  const client = new SpeechClient(clientOptions);

  // Optional: convert audio to LINEAR16 WAV PCM 16k mono to improve compatibility
  let convertedPath = null;
  // Determine whether we can perform ffmpeg-based conversion. We treat fluent-ffmpeg as optional.
  // If fluent-ffmpeg is installed but no ffmpeg binary is available, surface a clearer error message
  // (instead of a low-level spawn ENOENT) with Windows-specific installation notes.
  let useConversion = false;
  let ffmpeg; // will hold fluent-ffmpeg if present
  try {
    ffmpeg = require('fluent-ffmpeg');
    // Priority for ffmpeg binary path:
    // 1) FFMPEG_PATH env var
    // 2) ffmpeg-static package
    // 3) system ffmpeg reachable in PATH
    const envFfmpeg = process.env.FFMPEG_PATH || process.env.FFMPEG;

    // Try to locate a usable ffmpeg executable from several candidates. If we find one,
    // configure fluent-ffmpeg to use it. If not, surface a friendly, actionable error
    // (only when fluent-ffmpeg itself is installed — if fluent-ffmpeg is not present
    // we simply won't perform conversion).
    const { spawnSync } = require('child_process');
    let ffmpegStatic = null;
    try {
      ffmpegStatic = require('ffmpeg-static');
    } catch (e) {
      // ffmpeg-static not installed; that's fine — we'll try other candidates
    }

    const candidates = [];
    if (envFfmpeg) candidates.push({ type: 'env', path: envFfmpeg });
    if (ffmpegStatic) candidates.push({ type: 'static', path: ffmpegStatic });
    // 'system' will attempt to call 'ffmpeg' on PATH
    candidates.push({ type: 'system', path: 'ffmpeg' });

    let detectedFfmpegPath = null;
    for (const c of candidates) {
      try {
        const cmd = c.path === 'ffmpeg' ? 'ffmpeg' : c.path;
        // On Windows using shell can help resolve file associations; on POSIX we avoid shell.
        const res = spawnSync(cmd, ['-version'], { shell: process.platform === 'win32', encoding: 'utf8' });
        if (res && (res.status === 0 || (res.stdout && res.stdout.toLowerCase().includes('ffmpeg version')))) {
          detectedFfmpegPath = c.path === 'ffmpeg' ? 'ffmpeg' : c.path;
          break;
        }
      } catch (e) {
        // ignore and try next candidate
      }
    }

    if (detectedFfmpegPath) {
      // If we detected a specific path (env or static), set fluent-ffmpeg to use it.
      if (detectedFfmpegPath !== 'ffmpeg') ffmpeg.setFfmpegPath(detectedFfmpegPath);
      useConversion = true;
    } else {
      // fluent-ffmpeg is present but we couldn't find an ffmpeg binary. Provide a helpful error.
      const winNote = process.platform === 'win32'
        ? 'On Windows, install ffmpeg (for example via Chocolatey: "choco install ffmpeg", Scoop: "scoop install ffmpeg", or winget), or download a static build and add the folder containing ffmpeg.exe to your PATH. Alternatively set the FFMPEG_PATH environment variable to the full path to ffmpeg.exe (e.g. C:\\ffmpeg\\bin\\ffmpeg.exe) and restart your terminal/app so environment changes take effect.'
        : 'Install ffmpeg on your system and ensure the ffmpeg executable is available on your PATH, or install the "ffmpeg-static" npm package.';
      throw new Error('ffmpeg executable not found. fluent-ffmpeg requires the ffmpeg binary to convert audio. ' + winNote);
    }
  } catch (e) {
    // If fluent-ffmpeg isn't installed at all, we simply won't perform conversion and will send the original file.
    if (e && e.code === 'MODULE_NOT_FOUND') {
      useConversion = false;
      convertedPath = null;
    } else {
      // Re-throw friendly errors (like missing ffmpeg binary) or other unexpected failures
      throw e;
    }
  }

  // If we can convert, actually perform conversion to 16k mono PCM WAV and write to a temp file.
  if (useConversion) {
    try {
      const tmpName = `asr-conv-${Date.now()}-${Math.random().toString(36).slice(2,8)}.wav`;
      const tmpPath = path.join(os.tmpdir(), tmpName);
      await new Promise((resolve, reject) => {
        ffmpeg(filePath)
          .outputOptions(['-ac 1', '-ar 16000', '-acodec pcm_s16le'])
          .format('wav')
          .on('error', (err) => {
            // If conversion fails, log and continue using original file
            console.warn('Audio conversion failed, will use original file:', err.message || err);
            resolve();
          })
          .on('end', () => {
            convertedPath = tmpPath;
            resolve();
          })
          .save(tmpPath);
      });
    } catch (e) {
      // If anything goes wrong, just fallback to original file
      convertedPath = null;
    }
  }

  const audioPath = convertedPath || filePath;
  const fileBytes = fs.readFileSync(audioPath).toString('base64');

  const languageCode = process.env.ASR_LANGUAGE || process.env.TTS_LANGUAGE || 'en-US';
  const enableWordTimeOffsets = process.env.ASR_TIMESTAMPS === 'true';

  const request = {
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: 16000,
      languageCode,
      enableAutomaticPunctuation: true,
      enableWordTimeOffsets: enableWordTimeOffsets,
      // Allow more accurate model for longer or better quality audio
      model: process.env.GOOGLE_ASR_MODEL || 'default'
    },
    audio: { content: fileBytes }
  };

  const doRecognize = async () => {
    // Use longRunningRecognize for larger files (client will handle short sync too)
    const stats = fs.existsSync(audioPath) ? fs.statSync(audioPath) : null;
    const useLongRunning = stats && stats.size > 4 * 1024 * 1024; // >4MB

    if (useLongRunning && client.longRunningRecognize) {
      const [operation] = await client.longRunningRecognize(request);
      const [response] = await operation.promise();
      return response;
    }

    const [response] = await client.recognize(request);
    return response;
  };

  let response;
  try {
    response = await retry(doRecognize, { retries: 2, minDelay: 500, factor: 2 });
  } finally {
    // cleanup converted file if we created one
    if (convertedPath && fs.existsSync(convertedPath)) {
      try { fs.unlinkSync(convertedPath); } catch (e) { /* ignore */ }
    }
  }

  // Process response
  // response.results is an array of results; join alternatives
  if (!response || !response.results) throw new Error('No transcription result from Google Speech API');

  const transcripts = [];
  const words = [];

  for (const result of response.results) {
    if (!result.alternatives || result.alternatives.length === 0) continue;
    const alt = result.alternatives[0];
    if (alt.transcript) transcripts.push(alt.transcript.trim());
    if (enableWordTimeOffsets && alt.words) {
      for (const w of alt.words) {
        // word.startTime and endTime are objects like {seconds, nanos}
        const start = (w.startTime && (Number(w.startTime.seconds || 0) + (Number(w.startTime.nanos || 0) / 1e9))) || 0;
        const end = (w.endTime && (Number(w.endTime.seconds || 0) + (Number(w.endTime.nanos || 0) / 1e9))) || 0;
        words.push({ word: w.word, start, end });
      }
    }
  }

  const fullText = transcripts.join(' ').trim();
  if (enableWordTimeOffsets) return { text: fullText, words, raw: response };
  return fullText;
}

async function transcribe(filePath) {
  const provider = (process.env.ASR_PROVIDER || 'mock').toLowerCase();
  if (provider === 'mock') return transcribeMock(filePath);

  if (provider === 'openai') return transcribeOpenAI(filePath);

  if (provider === 'google') {
    return transcribeGoogle(filePath);
  }

  throw new Error(`Unknown ASR_PROVIDER=${provider}`);
}

module.exports = { transcribe };
