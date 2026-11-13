import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import type { AccountConfig } from '../src/config.js';
import { parseConfig } from '../src/config.js';
import type { InboundDm } from '../src/chat-listener.js';
import { dedupeKey, messageId } from '../src/chat-listener.js';
import { setLogSink, type LogEvent } from '../src/logger.js';

export const SENDER = '76561198000000001';

export function testConfig() {
  return parseConfig(undefined);
}

export function account(id: 'main' | 'rukia' = 'main'): AccountConfig {
  return testConfig().accounts[id];
}

export function makeDm(overrides: Partial<InboundDm> = {}): InboundDm {
  const ts = overrides.serverTimestamp ?? new Date('2026-11-13T00:59:00.000Z');
  const sender = overrides.senderSteamId ?? SENDER;
  const ordinal = overrides.ordinal ?? 0;
  const acct = overrides.account ?? 'main';
  const key = dedupeKey(sender, Math.floor(ts.getTime() / 1000), ordinal);
  return {
    account: acct,
    accountLabel: acct === 'main' ? 'S | Skins' : 'Rukia | Skins',
    accountSteamId: acct === 'main' ? '76561199798489148' : '76561199825952724',
    senderSteamId: sender,
    senderName: 'Buyer',
    text: 'hello, is the AK still available?',
    serverTimestamp: ts,
    timestampSource: 'steam',
    ordinal,
    fromLimitedAccount: false,
    source: 'live',
    key,
    msgId: messageId(acct, key),
    ...overrides,
  };
}

/** A JWT-shaped refresh token with the given payload (unsigned; Steam is never contacted in tests). */
export function fakeRefreshToken(payload: Record<string, unknown>): string {
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'EdDSA', typ: 'JWT' })}.${enc(payload)}.c2lnbmF0dXJl`;
}

/** A fresh temp dir per test, removed afterwards. */
export function useTempDir(): () => string {
  let dir = '';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return () => dir;
}

/** Capture log events instead of writing them anywhere. */
export function captureLogs(): LogEvent[] {
  const events: LogEvent[] = [];
  beforeEach(() => { events.length = 0; setLogSink((e) => events.push(e)); });
  afterEach(() => { setLogSink(null); });
  return events;
}
