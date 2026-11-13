import fs from 'node:fs';
import readline from 'node:readline';
import SteamUser from 'steam-user';
import SteamTotp from 'steam-totp';
import { accountPaths, SIGNIN_LOGON_ID_OFFSET } from './accounts.js';
import type { AccountConfig } from './config.js';
import { log } from './logger.js';
import { writeFileAtomic } from './state.js';

export const INTERACTIVE_AUTH_REQUIRED = 'INTERACTIVE_AUTH_REQUIRED';

// ---------------------------------------------------------------- Steam Guard

/**
 * Copied from Steam-Trade-Acceptor `src/auth.ts`. A shared secret is 20
 * bytes: 40 hex chars, or 27 base64 chars plus optional padding.
 */
export function isValidSteamSecret(s: string): boolean {
  if (/^[0-9a-fA-F]{40}$/.test(s)) return true;
  if (!/^[A-Za-z0-9+/_-]{27}=?$/.test(s)) return false;
  return Buffer.from(s, 'base64').length === 20;
}

export interface GuardEntry {
  code: string;
  /** Set only when the operator pasted a maFile shared_secret instead of a code. */
  sharedSecret?: string;
}

/** A 5-character code is used once; a pasted shared secret is recognised by format. */
export function parseGuardEntry(entry: string, generate = (secret: string) => SteamTotp.generateAuthCode(secret)): GuardEntry | null {
  const s = entry.trim();
  if (isValidSteamSecret(s)) return { code: generate(s), sharedSecret: s };
  if (/^[A-Za-z0-9]{5}$/.test(s)) return { code: s.toUpperCase() };
  return null;
}

// ---------------------------------------------------------- refresh tokens

export type TokenCheck =
  | { ok: true; steamId: string; expiresAt: Date | null }
  | { ok: false; reason: 'malformed' | 'not_a_client_token' | 'wrong_account' | 'expired' };

/**
 * Validate a refresh token locally before handing it to steam-user. steam-user
 * decodes the JWT inside an async nextTick (09-logon.js:128-160), so a bad
 * token there is an unhandled rejection that would kill the process.
 * The signature is not checked here; Steam does that.
 */
export function inspectRefreshToken(token: string, expectedSteamId: string, nowMs = Date.now()): TokenCheck {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return { ok: false, reason: 'malformed' };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || typeof payload !== 'object' || typeof payload['sub'] !== 'string') return { ok: false, reason: 'malformed' };
  const aud = Array.isArray(payload['aud']) ? payload['aud'] : [];
  if (payload['iss'] !== 'steam' || !aud.includes('client')) return { ok: false, reason: 'not_a_client_token' };
  if (payload['sub'] !== expectedSteamId) return { ok: false, reason: 'wrong_account' };
  const exp = typeof payload['exp'] === 'number' ? new Date(payload['exp'] * 1000) : null;
  if (exp && exp.getTime() <= nowMs) return { ok: false, reason: 'expired' };
  return { ok: true, steamId: payload['sub'], expiresAt: exp };
}

export function loadRefreshToken(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

export function saveRefreshToken(file: string, token: string): void {
  if (!token) throw new Error('Steam returned an empty refresh token');
  writeFileAtomic(file, token);
}

// ------------------------------------------------------- reconnect ladder

export type LogonFailureKind = 'auth_required' | 'throttled' | 'session_replaced' | 'transient';

/** EResults that mean the saved token cannot log on without a human (enums/EResult.js). */
const AUTH_REQUIRED_ERESULTS = new Set([5, 15, 17, 26, 27, 43, 63, 65, 85, 88, 121]);
const THROTTLED_ERESULTS = new Set([84, 87]);
const LOGON_SESSION_REPLACED = 34;
/** A throttle or a session ping-pong waits at least this long before the next try. */
export const SLOW_RETRY_FLOOR_MS = 300_000;

export function classifyLogonError(err: unknown): LogonFailureKind {
  const eresult = err && typeof err === 'object' ? (err as { eresult?: unknown }).eresult : undefined;
  if (typeof eresult === 'number') {
    if (eresult === LOGON_SESSION_REPLACED) return 'session_replaced';
    if (THROTTLED_ERESULTS.has(eresult)) return 'throttled';
    if (AUTH_REQUIRED_ERESULTS.has(eresult)) return 'auth_required';
  }
  return 'transient';
}

/** Delay before attempt `attempt` (1-based) on the ladder; the last rung repeats. */
export function reconnectDelayMs(ladder: readonly number[], attempt: number, kind: LogonFailureKind | 'initial'): number {
  const base = ladder[Math.min(Math.max(attempt, 1), ladder.length) - 1] ?? 600_000;
  return kind === 'throttled' || kind === 'session_replaced' ? Math.max(base, SLOW_RETRY_FLOOR_MS) : base;
}

// ----------------------------------------------------------- interactive sign-in

export interface PromptIO {
  ask(query: string): Promise<string>;
  askHidden(query: string): Promise<string>;
  print(line: string): void;
}

/** A terminal prompt. The password prompt suppresses echo (steam-autobuyer session.mjs). */
export function terminalIO(): PromptIO {
  const question = (query: string, hidden: boolean): Promise<string> => new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const writable = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
      writable._writeToOutput = (s: string) => { if (s.includes(query)) writable.output.write(query); };
    }
    rl.question(query, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
  return {
    ask: (q) => question(q, false),
    askHidden: (q) => question(q, true),
    print: (line) => console.log(line),
  };
}

export type SignInResult = { ok: true } | { ok: false; exitCode: 2 | 4 | 5; error: string };

const GUARD_PROMPT = 'Steam Guard code from the Steam app, or the maFile shared_secret: ';
const SIGNIN_TIMEOUT_MS = 120_000;

async function askGuard(io: PromptIO, query: string): Promise<GuardEntry | null> {
  for (;;) {
    const answer = await io.ask(query);
    if (!answer) return null;
    const entry = parseGuardEntry(answer);
    if (entry) return entry;
    io.print('That is neither a 5-character Steam Guard code nor a shared secret. Try again, or leave blank to cancel.');
  }
}

/**
 * One-time interactive login for one account. Saves only the refresh token
 * (after checking the logged-on SteamID is the configured one). The password
 * and any pasted shared secret live in memory for this logon only.
 * Exit codes follow session.mjs: 2 setup, 4 auth failed, 5 Steam/network.
 */
export async function signIn(account: AccountConfig, io: PromptIO): Promise<SignInResult> {
  const paths = accountPaths(account.id);
  io.print(`\n=== Auto-Steam-Chat sign-in: ${account.label} (${account.steamId}) ===`);
  io.print('The password is used for this sign-in only and is never saved. Only a refresh token is saved.');
  const accountName = await io.ask('Steam account name: ');
  if (!accountName) return { ok: false, exitCode: 2, error: 'account name is empty' };
  const password = await io.askHidden('Password: ');
  if (!password) return { ok: false, exitCode: 2, error: 'password is empty' };
  io.print('Leave the next prompt blank if Steam should ask (or to approve the login in the Steam app).');
  const firstGuard = await askGuard(io, GUARD_PROMPT);
  let sharedSecret = firstGuard?.sharedSecret;

  const client = new SteamUser({ dataDirectory: paths.steamData, autoRelogin: false });
  return new Promise<SignInResult>((resolve) => {
    let settled = false;
    let pendingToken: string | null = null;
    let identityVerified = false;
    let timer: NodeJS.Timeout | undefined;
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish({ ok: false, exitCode: 5, error: 'timed out waiting for Steam' }), SIGNIN_TIMEOUT_MS);
    };
    const finish = (result: SignInResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { client.logOff(); } catch { /* already gone */ }
      resolve(result);
    };
    const persist = (): void => {
      if (!pendingToken || !identityVerified) return;
      try {
        saveRefreshToken(paths.refreshToken, pendingToken);
        log('REFRESH_TOKEN_SAVED', { account: account.id, path: paths.refreshToken });
        io.print(`Refresh token saved to ${paths.refreshToken} (value not printed).`);
        finish({ ok: true });
      } catch (err) {
        finish({ ok: false, exitCode: 5, error: `could not save the refresh token: ${(err as Error).message}` });
      }
    };

    client.on('refreshToken', (token: string) => { pendingToken = token; persist(); });
    client.on('steamGuard', (domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) => {
      if (settled) return;
      if (sharedSecret && !lastCodeWrong) {
        callback(SteamTotp.generateAuthCode(sharedSecret));
        return;
      }
      if (lastCodeWrong) io.print('Steam rejected that code. Codes change every 30 seconds; enter the current one.');
      if (timer) clearTimeout(timer);
      const query = domain ? `Steam Guard code emailed to ...@${domain}: ` : GUARD_PROMPT;
      void askGuard(io, query).then((entry) => {
        if (!entry) { finish({ ok: false, exitCode: 4, error: 'Steam Guard code not entered' }); return; }
        if (entry.sharedSecret) sharedSecret = entry.sharedSecret;
        arm();
        callback(entry.code);
      });
    });
    client.on('loggedOn', () => {
      const actual = client.steamID?.getSteamID64();
      if (actual !== account.steamId) {
        finish({ ok: false, exitCode: 4, error: `signed in to ${actual ?? 'unknown'}, but ${account.id} is configured as ${account.steamId}; nothing saved` });
        return;
      }
      identityVerified = true;
      persist();
      // steam-user emits refreshToken before loggedOn for password logons;
      // allow a moment for an out-of-order arrival.
      setTimeout(() => finish({ ok: false, exitCode: 5, error: 'logged on but Steam sent no refresh token' }), 10_000).unref();
    });
    client.on('error', (err: Error & { eresult?: number }) => {
      const kind = classifyLogonError(err);
      finish({ ok: false, exitCode: kind === 'transient' ? 5 : 4, error: `Steam logon failed: ${err.message}` });
    });

    arm();
    client.logOn({
      accountName,
      password,
      ...(firstGuard ? { twoFactorCode: firstGuard.code } : {}),
      logonID: account.logonId + SIGNIN_LOGON_ID_OFFSET,
      machineName: 'Auto-Steam-Chat',
    });
  });
}
