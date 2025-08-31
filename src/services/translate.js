// Translation service (pluggable)
// Exports: translateText(text, target) -> Promise<string>

const { Translate } = require('@google-cloud/translate').v2;
const translateClient = new Translate();
const { retry } = require('../utils/retry');

async function translateMock(text, target) {
  return `TRANSLATION MOCK to=${target}\n${text}`;
}

async function translateText(text, target = 'id') {
  const provider = (process.env.TRANSLATE_PROVIDER || 'google').toLowerCase();
  if (provider === 'mock') return translateMock(text, target);

  if (provider === 'google') {
    // Uses GOOGLE_APPLICATION_CREDENTIALS env var for auth
    const doTranslate = async () => {
      const [translation] = await translateClient.translate(text, target);
      return translation;
    };
    return await retry(doTranslate, { retries: 3, minDelay: 300, factor: 2 });
  }

  throw new Error(`Unknown TRANSLATE_PROVIDER=${provider}`);
}

module.exports = { translateText };
