// TTS service (Google Cloud Text-to-Speech)
// Exports: synthesize(text, outPath, options) -> Promise<void>

const fs = require('fs');
const util = require('util');
const path = require('path');
const textToSpeech = require('@google-cloud/text-to-speech');
const { retry } = require('../utils/retry');

const client = new textToSpeech.TextToSpeechClient();

async function synthesize(text, outPath, options = {}) {
  if (!text) throw new Error('No text provided to TTS.synthesize');
  const voiceName = options.voiceName || process.env.TTS_VOICE || 'id-ID-Wavenet-A';
  const languageCode = options.languageCode || process.env.TTS_LANGUAGE || 'id-ID';
  const audioEncoding = options.audioEncoding || 'MP3'; // MP3 by default

  const request = {
    input: { text },
    voice: { languageCode, name: voiceName },
    audioConfig: { audioEncoding }
  };

  const doSynthesize = async () => {
    const [response] = await client.synthesizeSpeech(request);
    if (!response || !response.audioContent) throw new Error('Empty TTS response');
    return response;
  };

  const response = await retry(doSynthesize, { retries: 3, minDelay: 300, factor: 2 });

  const writeFile = util.promisify(fs.writeFile);
  // ensure parent dir exists
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, response.audioContent, 'binary');
}

module.exports = { synthesize };
