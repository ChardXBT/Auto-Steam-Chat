/**
 * Outbound HTTP for the sinks. Every request has a hard timeout and its body
 * is always consumed (an unread body at exit can trip a Windows libuv
 * assertion, per Steam-Trade-Acceptor src/notifications.ts). Errors carry the
 * error name and status only, never the URL, which holds the secret.
 */

export const REQUEST_TIMEOUT_MS = 12_000;
export const MAX_ATTEMPTS = 3;
export const MAX_RETRY_AFTER_MS = 30_000;
const RETRY_DELAYS_MS = [2_000, 5_000];

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface HttpResult {
  status: number;
  /** Parsed JSON body, if it was JSON. */
  json: unknown;
  retryAfterMs: number | null;
}

export async function postJson(fetchImpl: FetchLike, url: string, body: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS): Promise<HttpResult> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  let text = '';
  try { text = await response.text(); } catch { /* body unreadable; status still counts */ }
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, retryAfterMs: retryAfterMs(response, json) };
}

/** Discord: JSON `retry_after` (seconds) or `Retry-After`; Telegram: `parameters.retry_after`. */
function retryAfterMs(response: Response, json: unknown): number | null {
  const obj = (json && typeof json === 'object') ? json as Record<string, unknown> : {};
  const params = (obj['parameters'] && typeof obj['parameters'] === 'object') ? obj['parameters'] as Record<string, unknown> : {};
  const candidates = [obj['retry_after'], params['retry_after'], response.headers.get('retry-after')];
  for (const c of candidates) {
    const n = typeof c === 'string' ? Number(c) : c;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return Math.ceil(n * 1000);
  }
  return null;
}

export interface SendOutcome {
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

/**
 * Run `attempt` up to MAX_ATTEMPTS times. 429 waits retry_after (capped),
 * 5xx and network errors wait 2 s then 5 s, any other status is final.
 * `isOk` decides success from the result (Telegram also needs `ok: true`).
 */
export async function withRetry(attempt: () => Promise<HttpResult>, isOk: (r: HttpResult) => boolean,
  sleep: Sleep = realSleep): Promise<SendOutcome> {
  let last: SendOutcome = { ok: false, attempts: 0 };
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    let delay: number | null = null;
    try {
      const result = await attempt();
      if (isOk(result)) return { ok: true, attempts: n, status: result.status };
      last = { ok: false, attempts: n, status: result.status, error: `HTTP ${result.status}` };
      if (result.status === 429) delay = Math.min(result.retryAfterMs ?? 1_000, MAX_RETRY_AFTER_MS);
      else if (result.status >= 500) delay = RETRY_DELAYS_MS[n - 1] ?? 5_000;
      else return last;
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      last = { ok: false, attempts: n, error: name === 'TimeoutError' ? 'timeout' : `request failed: ${name}` };
      delay = RETRY_DELAYS_MS[n - 1] ?? 5_000;
    }
    if (n < MAX_ATTEMPTS) await sleep(delay);
  }
  return last;
}
