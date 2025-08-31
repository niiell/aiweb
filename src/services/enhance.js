// Simple audio enhancement service using ffmpeg filters
// Exports: enhanceAudio(inputPath, outputPath) -> Promise<void>

const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

async function enhanceAudio(inputPath, outputPath) {
  if (!fs.existsSync(inputPath)) throw new Error('input audio not found');
  // ensure parent dir
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    // Apply FFT-based denoiser (afftdn) and a simple highpass to remove rumble
    ffmpeg(inputPath)
      .audioFilters([
        'highpass=f=200',
        'afftdn'
      ])
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('start', cmd => {})
      .on('end', () => resolve())
      .on('error', err => reject(err))
      .save(outputPath);
  });
}

module.exports = { enhanceAudio };
