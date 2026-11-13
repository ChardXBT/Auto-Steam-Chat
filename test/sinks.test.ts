import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, postJson, withRetry, type FetchLike, type HttpResult } from '../src/http.js';
import { DiscordSink } from '../src/sinks/discord.js';
import { TelegramSink } from '../src/sinks/telegram.js';
import { makeDm } from './helpers.js';

const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${'s'.repeat(68)}`;
const BOT_TOKEN = `1234567890:${'T'.repeat(35)}`;

function scripted(responses: Array<Response | Error>): { fetchImpl: FetchLike; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error('no more scripted responses');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('withRetry', () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => { sleeps.push(ms); };
  const result = (status: number, retryAfterMs: number | null = null): HttpResult => ({ status, json: null, retryAfterMs });

  it('honours 429 retry_after (capped at 30 s), then succeeds', async () => {
    sleeps.length = 0;
    const seq = [result(429, 1500), result(429, 120_000), result(204)];
    const outcome = await withRetry(async () => seq.shift()!, (r) => r.status < 300, sleep);
    expect(outcome).toEqual({ ok: true, attempts: 3, status: 204 });
    expect(sleeps).toEqual([1500, 30_000]);
  });

  it('retries 5xx and network errors with 2 s then 5 s, and gives up after the cap', async () => {
    sleeps.length = 0;
    let n = 0;
    const outcome = await withRetry(async () => { n++; if (n === 2) throw new TypeError('fetch failed'); return result(502); }, () => false, sleep);
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(MAX_ATTEMPTS);
    expect(sleeps).toEqual([2000, 5000]);
  });

  it('does not retry other 4xx (a configuration error)', async () => {
    let n = 0;
    const outcome = await withRetry(async () => { n++; return result(404); }, (r) => r.status < 300, sleep);
    expect(outcome).toMatchObject({ ok: false, attempts: 1, status: 404 });
    expect(n).toBe(1);
  });

  it('reports a timeout by name, never the URL', async () => {
    const outcome = await withRetry(async () => { throw new DOMException(`aborted ${WEBHOOK}`, 'TimeoutError'); }, () => true, async () => {});
    expect(outcome.error).toBe('timeout');
  });

  it('postJson aborts a request that never answers', async () => {
    const hanging: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
    await expect(postJson(hanging, 'https://example.invalid', {}, 20)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('DiscordSink', () => {
  it('posts one payload per chunk with the mention, and reads Discord retry_after', async () => {
    const { fetchImpl, calls } = scripted([json(429, { retry_after: 0.25 }), new Response(null, { status: 204 })]);
    const waits: number[] = [];
    const sink = new DiscordSink({ webhookUrl: WEBHOOK, mentionUserId: '123456789012345678', username: 'Auto-Steam-Chat', fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    const outcome = await sink.send(makeDm());
    expect(outcome).toEqual({ ok: true, attempts: 2 });
    expect(waits).toEqual([250]);
    expect(calls[1]!.url).toBe(WEBHOOK);
    expect((calls[1]!.body as { content: string }).content).toContain('<@123456789012345678>');
  });

  it('fails with the part number and without leaking the webhook', async () => {
    const { fetchImpl } = scripted([json(401, { message: 'Invalid Webhook Token' })]);
    const sink = new DiscordSink({ webhookUrl: WEBHOOK, mentionUserId: null, username: 'x', fetchImpl, sleep: async () => {} });
    const outcome = await sink.send(makeDm());
    expect(outcome).toMatchObject({ ok: false, status: 401, error: 'HTTP 401 (part 1/1)' });
    expect(JSON.stringify(outcome)).not.toContain('sss');
  });
});

describe('TelegramSink', () => {
  it('calls sendMessage with plain text and requires ok:true', async () => {
    const { fetchImpl, calls } = scripted([json(200, { ok: false }), json(200, { ok: true, result: {} })]);
    const sink = new TelegramSink({ botToken: BOT_TOKEN, chatId: '-100123', timeZone: 'America/Toronto', fetchImpl, sleep: async () => {} });
    const first = await sink.send(makeDm());
    expect(first.ok).toBe(false);
    const second = await sink.send(makeDm());
    expect(second.ok).toBe(true);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ chat_id: '-100123', disable_web_page_preview: true });
    expect(body['parse_mode']).toBeUndefined();
  });

  it('honours Telegram parameters.retry_after', async () => {
    const { fetchImpl } = scripted([json(429, { ok: false, parameters: { retry_after: 3 } }), json(200, { ok: true })]);
    const waits: number[] = [];
    const sink = new TelegramSink({ botToken: BOT_TOKEN, chatId: '1', timeZone: 'UTC', fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    expect((await sink.send(makeDm())).ok).toBe(true);
    expect(waits).toEqual([3000]);
  });
});
