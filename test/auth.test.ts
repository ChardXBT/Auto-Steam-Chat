import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyLogonError, inspectRefreshToken, isValidSteamSecret, loadRefreshToken, parseGuardEntry,
  reconnectDelayMs, saveRefreshToken,
} from '../src/auth.js';
import { fakeRefreshToken, useTempDir } from './helpers.js';

const RUKIA = '76561199825952724';
const ok = { iss: 'steam', aud: ['client', 'web'], sub: RUKIA, exp: Math.floor(Date.now() / 1000) + 86_400 };

describe('Steam Guard entry', () => {
  it('recognises a 5-character code and upper-cases it', () => {
    expect(parseGuardEntry(' ab3cd ')).toEqual({ code: 'AB3CD' });
  });

  it('recognises a pasted shared secret (base64 or hex) and generates a code from it', () => {
    const base64 = Buffer.alloc(20, 7).toString('base64');
    const hex = Buffer.alloc(20, 7).toString('hex');
    expect(isValidSteamSecret(base64)).toBe(true);
    expect(isValidSteamSecret(hex)).toBe(true);
    const entry = parseGuardEntry(base64, () => 'GEN42');
    expect(entry).toEqual({ code: 'GEN42', sharedSecret: base64 });
  });

  it('rejects anything else', () => {
    expect(parseGuardEntry('1234')).toBeNull();
    expect(parseGuardEntry('not a code at all')).toBeNull();
    expect(isValidSteamSecret(Buffer.alloc(19).toString('base64'))).toBe(false);
  });
});

describe('refresh token inspection', () => {
  it('accepts a client token for the configured account', () => {
    expect(inspectRefreshToken(fakeRefreshToken(ok), RUKIA)).toMatchObject({ ok: true, steamId: RUKIA });
  });

  it('rejects malformed, web-only, wrong-account and expired tokens before steam-user sees them', () => {
    expect(inspectRefreshToken('nope', RUKIA)).toEqual({ ok: false, reason: 'malformed' });
    expect(inspectRefreshToken('a.!!!.c', RUKIA)).toEqual({ ok: false, reason: 'malformed' });
    expect(inspectRefreshToken(fakeRefreshToken({ ...ok, aud: ['web'] }), RUKIA)).toEqual({ ok: false, reason: 'not_a_client_token' });
    expect(inspectRefreshToken(fakeRefreshToken({ ...ok, sub: '76561199798489148' }), RUKIA)).toEqual({ ok: false, reason: 'wrong_account' });
    expect(inspectRefreshToken(fakeRefreshToken({ ...ok, exp: 1 }), RUKIA)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('refresh token storage', () => {
  const tmp = useTempDir();
  it('saves atomically and loads back, leaving no temp files', () => {
    const file = path.join(tmp(), 'accounts', 'rukia', 'refresh_token');
    expect(loadRefreshToken(file)).toBeNull();
    saveRefreshToken(file, 'token-value');
    saveRefreshToken(file, 'token-value-2');
    expect(loadRefreshToken(file)).toBe('token-value-2');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['refresh_token']);
    expect(() => saveRefreshToken(file, '')).toThrow();
  });
});

describe('logon error classification and the ladder', () => {
  it('classifies dead tokens, throttles, session replacement and the rest', () => {
    for (const eresult of [5, 15, 26, 27, 121]) expect(classifyLogonError({ eresult })).toBe('auth_required');
    expect(classifyLogonError({ eresult: 84 })).toBe('throttled');
    expect(classifyLogonError({ eresult: 87 })).toBe('throttled');
    expect(classifyLogonError({ eresult: 34 })).toBe('session_replaced');
    expect(classifyLogonError({ eresult: 3 })).toBe('transient');
    expect(classifyLogonError(new Error('No Steam servers available'))).toBe('transient');
    expect(classifyLogonError(null)).toBe('transient');
  });

  it('walks the ladder, repeats the last rung, and slows down throttles and kicks', () => {
    const ladder = [5_000, 15_000, 30_000, 60_000, 300_000, 600_000];
    expect([1, 2, 3, 4, 5, 6, 7, 50].map((n) => reconnectDelayMs(ladder, n, 'transient')))
      .toEqual([5_000, 15_000, 30_000, 60_000, 300_000, 600_000, 600_000, 600_000]);
    expect(reconnectDelayMs(ladder, 1, 'throttled')).toBe(300_000);
    expect(reconnectDelayMs(ladder, 1, 'session_replaced')).toBe(300_000);
    expect(reconnectDelayMs(ladder, 6, 'throttled')).toBe(600_000);
    expect(reconnectDelayMs(ladder, 1, 'auth_required')).toBe(5_000);
  });
});
