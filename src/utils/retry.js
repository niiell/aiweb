// Generic retry utility for async functions
// Usage: await retry(() => myAsyncCall(), { retries: 3, minDelay: 500, factor: 2 })

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retry(fn, opts = {}) {
  const retries = typeof opts.retries === 'number' ? opts.retries : 3;
  const minDelay = typeof opts.minDelay === 'number' ? opts.minDelay : 500;
  const factor = typeof opts.factor === 'number' ? opts.factor : 2;

  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt > retries) break;
      const delay = Math.floor(minDelay * Math.pow(factor, attempt - 1));
      await wait(delay);
    }
  }
  throw lastErr;
}

module.exports = { retry };
