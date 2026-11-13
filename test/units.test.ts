import { describe, expect, it } from 'vitest';
import { normalizeHistory, normalizeLive } from '../src/chat-listener.js';
import { redactEvent, redactText } from '../src/logger.js';
import { DisabledSteamDmSender } from '../src/reply.js';
import { parseArgs } from '../src/accounts.js';
import { account, SENDER } from './helpers.js';

describe('chat normalisation', () => {
  const main = account('main');
  const sid = (s: string) => ({ getSteamID64: () => s });

  it('keeps the verbatim text and builds the dedupe key from Steam time and ordinal', () => {
    const r = normalizeLive(main, {
      steamid_friend: sid(SENDER), chat_entry_type: 1, message: '[url=x]y[/url]  spaced  ', message_no_bbcode: 'y  spaced  ',
      server_timestamp: new Date('2026-11-13T00:59:00.900Z'), ordinal: 2, from_limited_account: true,
    }, null);
    expect(r.kind).toBe('dm');
    if (r.kind !== 'dm') return;
    expect(r.dm.text).toBe('y  spaced  ');
    expect(r.dm.key).toBe(`${SENDER}:${Date.parse('2026-11-13T00:59:00Z') / 1000}:2`);
    expect(r.dm.msgId).toMatch(/^[0-9a-f]{16}$/);
    expect(r.dm.fromLimitedAccount).toBe(true);
    expect(r.dm.timestampSource).toBe('steam');
  });

  it('live and backfill copies of the same message share a key', () => {
    const ts = new Date('2026-11-13T00:59:00Z');
    const live = normalizeLive(main, { steamid_friend: SENDER, chat_entry_type: 1, message_no_bbcode: 'x', server_timestamp: ts, ordinal: 0 }, null);
    const hist = normalizeHistory(main, { sender: sid(SENDER), server_timestamp: ts, ordinal: 0, message: 'x' }, null);
    expect(live.kind === 'dm' && hist.kind === 'dm' && live.dm.key === hist.dm.key).toBe(true);
  });

  it('ignores echoes, typing, our own messages and missing senders', () => {
    const base = { steamid_friend: SENDER, chat_entry_type: 1, message_no_bbcode: 'x', server_timestamp: new Date() };
    expect(normalizeLive(main, { ...base, local_echo: true }, null)).toEqual({ kind: 'ignored', reason: 'echo' });
    expect(normalizeLive(main, { ...base, chat_entry_type: 2 }, null)).toEqual({ kind: 'ignored', reason: 'not_a_message' });
    expect(normalizeLive(main, { ...base, steamid_friend: main.steamId }, null)).toEqual({ kind: 'ignored', reason: 'own_message' });
    expect(normalizeLive(main, { ...base, steamid_friend: null }, null)).toEqual({ kind: 'ignored', reason: 'no_sender' });
  });

  it('still relays a message with no server time, flagged as local clock', () => {
    const r = normalizeLive(main, { steamid_friend: SENDER, chat_entry_type: 1, message_no_bbcode: 'x', server_timestamp: null }, null, 1_700_000_000_500);
    expect(r.kind === 'dm' && r.dm.timestampSource).toBe('local');
  });
});

describe('log redaction', () => {
  it('masks webhook URLs, Telegram tokens, JWTs, cookies and SteamID64s', () => {
    // Built at runtime so the CI secret scan never sees a token-shaped literal.
    const text = [
      `https://discord.com/api/webhooks/123456789012345678/${'abcdefghij'.repeat(4)}`,
      `https://api.telegram.org/bot1234567890:${'A'.repeat(35)}/sendMessage`,
      `1234567890:${'B'.repeat(35)}`,
      'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiI3NjU2MTE5OTgyNTk1MjcyNCJ9.c2ln',
      `steamLoginSecure=${'76561199825952724'}%7C%7Csecret`,
      'sender 76561198000000001',
    ].join(' ');
    const out = redactText(text);
    expect(out).not.toMatch(/abcdefghij|AAAAAAAA|BBBBBBBB|eyJzdWIi|secret|76561198000000001/);
    expect(out).toContain('[redacted-webhook]');
    expect(out).toContain('7656119**********');
  });

  it('masks secret-named fields but keeps booleans and safe ids', () => {
    expect(redactEvent({ refreshToken: 'x', webhookUrl: 'y', hasToken: true, msgId: 'abc', nested: { password: 'p' } }))
      .toEqual({ refreshToken: '[redacted]', webhookUrl: '[redacted]', hasToken: true, msgId: 'abc', nested: { password: '[redacted]' } });
  });

  it('survives cycles and BigInts', () => {
    const o: Record<string, unknown> = { n: 10n };
    o['self'] = o;
    expect(redactEvent(o)).toEqual({ n: '10', self: '[circular]' });
  });
});

describe('reply seam (v1 stub)', () => {
  it('refuses every send without touching Steam', async () => {
    expect(await new DisabledSteamDmSender().sendSteamDm()).toMatchObject({ ok: false, reason: 'replies_disabled' });
  });
});

describe('CLI arguments', () => {
  it('parses commands and account selection like the acceptor', () => {
    expect(parseArgs([])).toEqual({ command: 'start', selection: 'both' });
    expect(parseArgs(['signin', '--account', 'alt'])).toEqual({ command: 'signin', selection: 'rukia' });
    expect(parseArgs(['--account', 'main'])).toEqual({ command: 'start', selection: 'main' });
    expect(() => parseArgs(['start', '--account', 'x'])).toThrow();
    expect(() => parseArgs(['delete'])).toThrow();
  });
});
