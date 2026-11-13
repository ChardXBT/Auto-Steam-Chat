import type { EventEmitter } from 'node:events';
import SteamUser from 'steam-user';
import { accountPaths } from './accounts.js';
import {
  INTERACTIVE_AUTH_REQUIRED, classifyLogonError, inspectRefreshToken, loadRefreshToken, reconnectDelayMs,
  saveRefreshToken, type LogonFailureKind,
} from './auth.js';
import {
  collectBackfill, normalizeHistory, normalizeLive, type ChatHistoryApi, type RawFriendMessage,
} from './chat-listener.js';
import type { AccountConfig, AppConfig, PersonaStateName } from './config.js';
import type { DedupeStore } from './dedupe.js';
import type { OpsNotice } from './format.js';
import { log, logError } from './logger.js';
import type { EnqueueResult, NameLookup } from './relay.js';
import type { InboundDm } from './chat-listener.js';

/** The part of a steam-user `SteamUser` this runner touches (fakeable in tests). */
export interface SteamClientLike extends EventEmitter {
  steamID: { getSteamID64(): string } | null;
  users: Record<string, { player_name?: string } | undefined>;
  chat: EventEmitter & ChatHistoryApi;
  logOn(details: Record<string, unknown>): void;
  logOff(): void;
  setPersona(state: number): void;
  getPersonas(ids: string[]): Promise<{ personas: Record<string, { player_name?: string } | undefined> }>;
}

export type ClientFactory = (dataDirectory: string) => SteamClientLike;

/**
 * A fresh SteamUser per attempt (logOn on a used instance can throw
 * asynchronously, 09-logon.js:24-38). autoRelogin is off so every drop
 * surfaces as 'error' and goes through our ladder, as in the acceptor.
 * renewRefreshTokens keeps this service's own token alive.
 */
export const defaultClientFactory: ClientFactory = (dataDirectory) =>
  new SteamUser({ dataDirectory, autoRelogin: false, renewRefreshTokens: true }) as unknown as SteamClientLike;

/** steam-user enums/EPersonaState.js */
const PERSONA_STATE: Record<PersonaStateName, number> = { online: 1, busy: 2, away: 3, looking_to_trade: 5, invisible: 7 };
const LOGON_TIMEOUT_MS = 60_000;
/** Overlap so a message right at the watermark second is re-checked, not skipped. */
const BACKFILL_OVERLAP_S = 120;

export interface RelayPort {
  enqueue(dm: InboundDm, lookupName?: NameLookup): EnqueueResult;
}

export interface OpsNotifier {
  /** Fire and forget; must never throw. */
  notify(notice: OpsNotice): void;
}

export type RunnerState = 'idle' | 'connecting' | 'online' | 'reconnect_wait' | 'auth_required' | 'stopped';

export interface AccountRunnerDeps {
  account: AccountConfig;
  config: AppConfig;
  relay: RelayPort;
  store: DedupeStore;
  notifier: OpsNotifier;
  clientFactory?: ClientFactory;
  now?: () => number;
}

/**
 * One Steam logon for one account: refresh-token logon with this account's
 * own logonID, Online persona, live DM listener, backfill on every logon,
 * and the reconnect ladder. Unattended: it never prompts, and an account
 * that needs a human goes to INTERACTIVE_AUTH_REQUIRED and keeps retrying
 * (the token file is re-read each attempt, so `npm run signin` heals it).
 */
export class AccountRunner {
  private client: SteamClientLike | null = null;
  private generation = 0;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private logonTimer: NodeJS.Timeout | null = null;
  private authAlerted = false;
  private state: RunnerState = 'idle';
  private onlineSince: string | null = null;
  private lastFailure: { kind: LogonFailureKind; reason: string; at: string } | null = null;
  private readonly factory: ClientFactory;
  private readonly now: () => number;
  private readonly paths;

  constructor(private readonly deps: AccountRunnerDeps) {
    this.factory = deps.clientFactory ?? defaultClientFactory;
    this.now = deps.now ?? Date.now;
    this.paths = accountPaths(deps.account.id);
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.connect();
  }

  stop(): void {
    this.state = 'stopped';
    this.generation++;
    this.clearTimers();
    this.dropClient();
  }

  health(): Record<string, unknown> {
    return { state: this.state, onlineSince: this.onlineSince, attempt: this.attempt, lastFailure: this.lastFailure };
  }

  private get account(): AccountConfig {
    return this.deps.account;
  }

  private connect(): void {
    if (this.state === 'stopped') return;
    this.retryTimer = null;
    this.attempt++;
    const token = loadRefreshToken(this.paths.refreshToken);
    if (!token) {
      this.fail('auth_required', 'no_refresh_token');
      return;
    }
    const check = inspectRefreshToken(token, this.account.steamId, this.now());
    if (!check.ok) {
      this.fail('auth_required', `refresh_token_${check.reason}`);
      return;
    }

    const gen = ++this.generation;
    const client = this.factory(this.paths.steamData);
    this.client = client;
    this.state = 'connecting';
    const current = (): boolean => gen === this.generation && this.state !== 'stopped';

    this.logonTimer = setTimeout(() => {
      if (!current()) return;
      this.dropClient();
      this.fail('transient', 'logon_timeout');
    }, LOGON_TIMEOUT_MS);

    client.on('refreshToken', (renewed: string) => {
      if (!current()) return;
      const renewedCheck = inspectRefreshToken(renewed, this.account.steamId, this.now());
      if (!renewedCheck.ok) {
        log('REFRESH_TOKEN_RENEWAL_REJECTED', { account: this.account.id, reason: renewedCheck.reason });
        return;
      }
      try {
        saveRefreshToken(this.paths.refreshToken, renewed);
        log('REFRESH_TOKEN_RENEWED', { account: this.account.id, expiresAt: renewedCheck.expiresAt?.toISOString() ?? null });
      } catch (err) {
        logError('REFRESH_TOKEN_SAVE_FAILED', err, { account: this.account.id });
      }
    });

    client.on('loggedOn', () => {
      if (!current()) return;
      this.clearLogonTimer();
      const actual = client.steamID?.getSteamID64();
      if (actual !== this.account.steamId) {
        log('ACCOUNT_MISMATCH', { account: this.account.id, expected: this.account.steamId, actual });
        this.dropClient();
        this.fail('auth_required', 'account_mismatch');
        return;
      }
      this.state = 'online';
      this.onlineSince = new Date(this.now()).toISOString();
      this.attempt = 0;
      this.authAlerted = false;
      try {
        client.setPersona(PERSONA_STATE[this.deps.config.personaState]);
      } catch (err) {
        logError('SET_PERSONA_FAILED', err, { account: this.account.id });
      }
      log('STEAM_ONLINE', { account: this.account.id, label: this.account.label, logonId: this.account.logonId, persona: this.deps.config.personaState });
      void this.backfill(client, current).catch((err) => logError('BACKFILL_FAILED', err, { account: this.account.id }));
    });

    // With autoRelogin off, every logoff after logon arrives here (09-logon.js:631-680).
    client.on('error', (err: Error & { eresult?: number }) => {
      if (!current()) return;
      this.clearLogonTimer();
      const wasOnline = this.state === 'online';
      this.dropClient();
      this.fail(classifyLogonError(err), wasOnline ? 'disconnected' : 'logon_failed', err);
    });
    client.on('disconnected', (eresult: number, msg?: string) => {
      if (!current()) return;
      this.clearLogonTimer();
      this.dropClient();
      this.fail(classifyLogonError({ eresult }), `disconnected:${msg ?? 'unknown'}`, { eresult });
    });
    client.on('steamGuard', () => {
      if (!current()) return;
      log('STEAM_GUARD_PROMPT_SUPPRESSED', { account: this.account.id, reason: 'unattended' });
      this.dropClient();
      this.fail('auth_required', 'steam_guard_requested');
    });
    client.on('offlineMessages', (count: number, friends: unknown[]) => {
      if (!current()) return;
      log('STEAM_OFFLINE_MESSAGES', { account: this.account.id, count, friends: Array.isArray(friends) ? friends.length : 0 });
    });
    client.chat.on('friendMessage', (raw: RawFriendMessage) => {
      if (!current()) return;
      try {
        this.handleLive(client, raw);
      } catch (err) {
        logError('DM_HANDLER_FAILED', err, { account: this.account.id });
      }
    });

    log('STEAM_LOGON_ATTEMPT', { account: this.account.id, attempt: this.attempt, logonId: this.account.logonId });
    try {
      client.logOn({ refreshToken: token, logonID: this.account.logonId, machineName: 'Auto-Steam-Chat' });
    } catch (err) {
      this.clearLogonTimer();
      this.dropClient();
      this.fail('transient', 'logon_threw', err);
    }
  }

  private handleLive(client: SteamClientLike, raw: RawFriendMessage): void {
    const sender = typeof raw.steamid_friend === 'string' ? raw.steamid_friend : raw.steamid_friend?.getSteamID64?.();
    const result = normalizeLive(this.account, raw, sender ? this.cachedName(client, sender) : null, this.now());
    if (result.kind === 'ignored') {
      if (result.reason !== 'echo' && result.reason !== 'not_a_message') log('DM_IGNORED', { account: this.account.id, reason: result.reason });
      return;
    }
    const dm = result.dm;
    this.deps.relay.enqueue(dm, dm.senderName ? undefined : () => this.lookupName(client, dm.senderSteamId));
  }

  private async backfill(client: SteamClientLike, current: () => boolean): Promise<void> {
    const { backfill } = this.deps.config;
    if (!backfill.enabled || backfill.maxHours <= 0) return;
    const store = this.deps.store;
    const nowS = Math.floor(this.now() / 1000);
    // Never before this store existed: a first run does not replay old history.
    const floor = Math.max(store.createdAt, nowS - Math.round(backfill.maxHours * 3600));
    const since = Math.max(floor, (store.watermark ?? store.createdAt) - BACKFILL_OVERLAP_S);
    const outcome = await collectBackfill(client.chat, new Date(since * 1000));
    if (!current()) return;
    const counts: Record<EnqueueResult | 'ignored', number> = { queued: 0, duplicate: 0, overflow: 0, ignored: 0 };
    for (const { message } of outcome.messages) {
      const sender = typeof message.sender === 'string' ? message.sender : message.sender?.getSteamID64?.();
      const result = normalizeHistory(this.account, message, sender ? this.cachedName(client, sender) : null, this.now());
      if (result.kind === 'ignored') { counts.ignored++; continue; }
      const dm = result.dm;
      counts[this.deps.relay.enqueue(dm, dm.senderName ? undefined : () => this.lookupName(client, dm.senderSteamId))]++;
    }
    log('BACKFILL_DONE', {
      account: this.account.id, since: new Date(since * 1000).toISOString(), sessions: outcome.sessionsChecked,
      fetched: outcome.messages.length, ...counts,
      truncatedConversations: outcome.truncatedFriends.length, failedConversations: outcome.failedFriends.length,
    });
    if (outcome.truncatedFriends.length > 0) log('BACKFILL_TRUNCATED', { account: this.account.id, conversations: outcome.truncatedFriends.length, maxPerConversation: 100 });
  }

  private cachedName(client: SteamClientLike, steamId: string): string | null {
    try {
      const name = client.users?.[steamId]?.player_name;
      return typeof name === 'string' && name ? name : null;
    } catch {
      return null;
    }
  }

  private async lookupName(client: SteamClientLike, steamId: string): Promise<string | null> {
    const { personas } = await client.getPersonas([steamId]);
    const name = personas?.[steamId]?.player_name;
    return typeof name === 'string' && name ? name : null;
  }

  private fail(kind: LogonFailureKind, reason: string, err?: unknown): void {
    if (this.state === 'stopped') return;
    const eresult = err && typeof err === 'object' ? (err as { eresult?: unknown }).eresult : undefined;
    const delay = reconnectDelayMs(this.deps.config.reconnectBackoffMs, Math.max(this.attempt, 1), kind);
    this.lastFailure = { kind, reason, at: new Date(this.now()).toISOString() };
    this.onlineSince = null;
    this.state = kind === 'auth_required' ? 'auth_required' : 'reconnect_wait';
    const data = {
      account: this.account.id, reason, kind, attempt: this.attempt, retryInMs: delay,
      ...(eresult !== undefined ? { eresult } : {}),
      ...(err instanceof Error ? { error: err.message } : {}),
    };
    if (kind === 'auth_required') {
      log(INTERACTIVE_AUTH_REQUIRED, { ...data, action: `npm run signin -- --account ${this.account.id}` });
      if (!this.authAlerted) {
        this.authAlerted = true;
        this.deps.notifier.notify({
          kind: INTERACTIVE_AUTH_REQUIRED, mention: true,
          summary: `${this.account.label} cannot log on to Steam without you. DMs to this account are not being relayed. `
            + `Run: npm run signin -- --account ${this.account.id}`,
          fields: { account: this.account.id, reason, retry_every: 'reconnect ladder' },
        });
      }
    } else {
      log('STEAM_RECONNECT_SCHEDULED', data);
      if (kind === 'session_replaced') {
        this.deps.notifier.notify({
          kind: 'LOGON_SESSION_REPLACED', mention: true,
          summary: `${this.account.label}: another session with this service's logonID (${this.account.logonId}) took over from this IP. `
            + 'Is a second copy of Auto-Steam-Chat running?',
          fields: { account: this.account.id, retry_in_s: Math.round(delay / 1000) },
        });
      }
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Detach the client first, so whatever it still emits while logging off is ignored as stale. */
  private dropClient(): void {
    const client = this.client;
    this.client = null;
    this.generation++;
    if (!client) return;
    try { client.logOff(); } catch { /* already gone */ }
  }

  private clearLogonTimer(): void {
    if (this.logonTimer) clearTimeout(this.logonTimer);
    this.logonTimer = null;
  }

  private clearTimers(): void {
    this.clearLogonTimer();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
