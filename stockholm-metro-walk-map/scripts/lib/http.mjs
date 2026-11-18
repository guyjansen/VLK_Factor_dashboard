// fetch() with timeout, exponential backoff + jitter, and Retry-After support.
import { sleep } from './common.mjs';

export class HttpError extends Error {
  constructor(message, { status, body, retryable, code } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.retryable = !!retryable;
    this.code = code; // 'auth' | 'quota' | 'rate-limit' | 'network' | 'bad-request' | 'server' | 'timeout'
  }
}

function classify(status) {
  if (status === 401 || status === 403) return { code: 'auth', retryable: false };
  if (status === 429) return { code: 'rate-limit', retryable: true };
  if (status === 400 || status === 404 || status === 422) return { code: 'bad-request', retryable: false };
  if (status >= 500) return { code: 'server', retryable: true };
  return { code: 'http', retryable: false };
}

/**
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number, retries?: number, baseDelayMs?: number, maxDelayMs?: number, onRetry?: Function}} opts
 * @returns {Promise<any>} parsed JSON
 */
export async function fetchJsonWithRetry(url, opts = {}) {
  const { timeoutMs = 30000, retries = 5, baseDelayMs = 1000, maxDelayMs = 60000, onRetry, ...init } = opts;
  let attempt = 0;
  for (;;) {
    let err;
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if (res.ok) {
        try { return JSON.parse(text); } catch {
          throw new HttpError(`Invalid JSON from ${new URL(url).host}`, { status: res.status, code: 'server', retryable: true });
        }
      }
      const { code, retryable } = classify(res.status);
      // Daily quota exhaustion is not worth retrying (openrouteservice says so in the body).
      const quota = res.status === 429 && /quota|daily|limit exceeded/i.test(text) && !/minute/i.test(text);
      err = new HttpError(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`, {
        status: res.status, body: text, code: quota ? 'quota' : code, retryable: quota ? false : retryable
      });
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
    } catch (e) {
      if (e instanceof HttpError) err = e;
      else if (e.name === 'TimeoutError' || e.name === 'AbortError') err = new HttpError(`Timeout after ${timeoutMs} ms: ${url}`, { code: 'timeout', retryable: true });
      else err = new HttpError(`Network error contacting ${safeHost(url)}: ${e.cause?.code || e.message}`, { code: 'network', retryable: true });
    }
    if (!err.retryable || attempt >= retries) throw err;
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) * (0.75 + Math.random() * 0.5);
    const delay = Math.max(backoff, err.retryAfterMs || 0);
    attempt++;
    onRetry?.({ attempt, delay, error: err });
    await sleep(delay);
  }
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return 'remote host'; }
}

/** Serialises calls and enforces a minimum interval between them. */
export function createRateLimiter(minIntervalMs) {
  let last = 0;
  let chain = Promise.resolve();
  return function schedule(fn) {
    const run = chain.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
}
