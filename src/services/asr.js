// ASR service (pluggable)
// Exports: transcribe(filePath) -> Promise<string>

const fs = require('fs');
const path = require('path');
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

async function transcribe(filePath) {
  const provider = (process.env.ASR_PROVIDER || 'mock').toLowerCase();
  if (provider === 'mock') return transcribeMock(filePath);

  if (provider === 'openai') return transcribeOpenAI(filePath);

  if (provider === 'google') {
    // Placeholder for Google Cloud Speech-to-Text
    // Requires GOOGLE_API_KEY or service account credentials
    throw new Error('Google ASR provider not implemented in this starter.');
  }

  throw new Error(`Unknown ASR_PROVIDER=${provider}`);
}

module.exports = { transcribe };
