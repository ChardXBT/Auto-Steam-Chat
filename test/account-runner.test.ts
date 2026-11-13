import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRunner, type SteamClientLike } from '../src/account-runner.js';
import { accountPaths } from '../src/accounts.js';
import type { InboundDm } from '../src/chat-listener.js';
import { DedupeStore } from '../src/dedupe.js';
import type { OpsNotice } from '../src/format.js';
import type { NameLookup } from '../src/relay.js';
import { account, captureLogs, fakeRefreshToken, SENDER, testConfig } from './helpers.js';

class FakeChat extends EventEmitter {
  sessions: Array<{ steamid_friend: string; time_last_message: Date | null }> = [];
  history: Record<string, Array<{ sender: string; server_timestamp: Date; ordinal: number; message: string }>> = {};
  async getActiveFriendMessageSessions() { return { sessions: this.sessions }; }
  async getFriendMessageHistory(friend: string) { return { messages: this.history[friend] ?? [], more_available: false }; }
}

class FakeClient extends EventEmitter implements SteamClientLike {
  steamID: { getSteamID64(): string } | null = null;
  users: Record<string, { player_name?: string }> = {};
  chat = new FakeChat() as unknown as SteamClientLike['chat'];
  logOnDetails: Record<string, unknown> | null = null;
  persona: number | null = null;
  loggedOff = false;
  logOn(details: Record<string, unknown>): void { this.logOnDetails = details; }
  logOff(): void { this.loggedOff = true; }
  setPersona(state: number): void { this.persona = state; }
  async getPersonas(ids: string[]) { return { personas: Object.fromEntries(ids.map((id) => [id, { player_name: `name-${id.slice(-3)}` }])) }; }
  goOnline(steamId: string): void {
    this.steamID = { getSteamID64: () => steamId };
    this.emit('loggedOn', {});
  }
}

const RUKIA = account('rukia');

describe('AccountRunner', () => {
  const logs = captureLogs();
  let clients: FakeClient[];
  let enqueued: Array<{ dm: InboundDm; lookup?: NameLookup }>;
  let notices: OpsNotice[];
  let store: DedupeStore;

  const tokenFile = (): string => accountPaths('rukia').refreshToken;
  const writeToken = (payload: Record<string, unknown> = {}): void => {
    fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
    fs.writeFileSync(tokenFile(), fakeRefreshToken({ iss: 'steam', aud: ['client'], sub: RUKIA.steamId, exp: Math.floor(Date.now() / 1000) + 3600, ...payload }));
  };

  function makeRunner(): AccountRunner {
    return new AccountRunner({
      account: RUKIA, config: testConfig(), store,
      relay: { enqueue: (dm, lookup) => { enqueued.push({ dm, lookup }); return 'queued'; } },
      notifier: { notify: (n) => notices.push(n) },
      clientFactory: () => { const c = new FakeClient(); clients.push(c); return c; },
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    clients = [];
    enqueued = [];
    notices = [];
    fs.rmSync(accountPaths('rukia').dir, { recursive: true, force: true });
    store = new DedupeStore(accountPaths('rukia').relayed, { retentionSeconds: 30 * 86_400 });
    store.load();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('without a refresh token: INTERACTIVE_AUTH_REQUIRED, one alert, retries on the ladder, never connects', async () => {
    const runner = makeRunner();
    runner.start();
    expect(runner.health()['state']).toBe('auth_required');
    expect(logs.filter((e) => e.event === 'INTERACTIVE_AUTH_REQUIRED')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const events = logs.filter((e) => e.event === 'INTERACTIVE_AUTH_REQUIRED');
    expect(events.map((e) => e['retryInMs'])).toEqual([5_000, 15_000, 30_000, 60_000]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'INTERACTIVE_AUTH_REQUIRED', mention: true });
    expect(clients).toHaveLength(0);
    runner.stop();
  });

  it('heals without a restart once signin writes a token', async () => {
    const runner = makeRunner();
    runner.start();
    writeToken();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(clients).toHaveLength(1);
    expect(clients[0]!.logOnDetails).toMatchObject({ logonID: RUKIA.logonId });
    expect(clients[0]!.logOnDetails!['refreshToken']).toBeTypeOf('string');
    runner.stop();
  });

  it('logs on with its own logonID, goes Online, and relays a live DM (but not echoes or typing)', async () => {
    writeToken();
    const runner = makeRunner();
    runner.start();
    const client = clients[0]!;
    expect(client.logOnDetails!['logonID']).toBe(0x41534302);
    client.goOnline(RUKIA.steamId);
    expect(runner.health()['state']).toBe('online');
    expect(client.persona).toBe(1);

    client.users[SENDER] = { player_name: 'Cached Buyer' };
    client.chat.emit('friendMessage', { steamid_friend: SENDER, chat_entry_type: 1, message: '[b]hi[/b]', message_no_bbcode: 'hi', server_timestamp: new Date('2026-11-13T01:00:00Z'), ordinal: 0, local_echo: false });
    client.chat.emit('friendMessage', { steamid_friend: SENDER, chat_entry_type: 1, message_no_bbcode: 'mine', server_timestamp: new Date(), ordinal: 0, local_echo: true });
    client.chat.emit('friendMessage', { steamid_friend: SENDER, chat_entry_type: 2, server_timestamp: new Date(), ordinal: 0 });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.dm).toMatchObject({ account: 'rukia', accountLabel: 'Rukia | Skins', text: 'hi', senderName: 'Cached Buyer', source: 'live' });
    expect(enqueued[0]!.lookup).toBeUndefined();
    runner.stop();
  });

  it('a handler exception is contained', async () => {
    writeToken();
    const runner = makeRunner();
    runner.start();
    clients[0]!.goOnline(RUKIA.steamId);
    expect(() => clients[0]!.chat.emit('friendMessage', null)).not.toThrow();
    expect(logs.some((e) => e.event === 'DM_HANDLER_FAILED')).toBe(true);
    runner.stop();
  });

  it('on a disconnect, reconnects with a fresh client and ignores the stale one', async () => {
    writeToken();
    const runner = makeRunner();
    runner.start();
    const first = clients[0]!;
    first.goOnline(RUKIA.steamId);
    first.emit('error', Object.assign(new Error('NoConnection'), { eresult: 3 }));
    expect(first.loggedOff).toBe(true);
    expect(runner.health()['state']).toBe('reconnect_wait');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(clients).toHaveLength(2);
    first.chat.emit('friendMessage', { steamid_friend: SENDER, chat_entry_type: 1, message_no_bbcode: 'stale', server_timestamp: new Date(), ordinal: 0 });
    expect(enqueued).toHaveLength(0);
    runner.stop();
  });

  it('a dead token goes to INTERACTIVE_AUTH_REQUIRED; a session kick alerts and slows down', async () => {
    writeToken();
    const runner = makeRunner();
    runner.start();
    clients[0]!.emit('error', Object.assign(new Error('AccessDenied'), { eresult: 15 }));
    expect(runner.health()['state']).toBe('auth_required');
    expect(notices.map((n) => n.kind)).toEqual(['INTERACTIVE_AUTH_REQUIRED']);
    await vi.advanceTimersByTimeAsync(5_000);
    clients[1]!.goOnline(RUKIA.steamId);
    clients[1]!.emit('error', Object.assign(new Error('LogonSessionReplaced'), { eresult: 34 }));
    expect(notices.map((n) => n.kind)).toEqual(['INTERACTIVE_AUTH_REQUIRED', 'LOGON_SESSION_REPLACED']);
    expect(logs.filter((e) => e.event === 'STEAM_RECONNECT_SCHEDULED').at(-1)!['retryInMs']).toBe(300_000);
    runner.stop();
  });

  it('refuses a session that logged on as the wrong account', async () => {
    writeToken();
    const runner = makeRunner();
    runner.start();
    clients[0]!.goOnline('76561199798489148');
    expect(runner.health()['state']).toBe('auth_required');
    expect(logs.some((e) => e.event === 'ACCOUNT_MISMATCH')).toBe(true);
    runner.stop();
  });

  it('a wrong-account or expired token file never reaches steam-user', async () => {
    writeToken({ sub: '76561199798489148' });
    const runner = makeRunner();
    runner.start();
    expect(clients).toHaveLength(0);
    expect(logs.find((e) => e.event === 'INTERACTIVE_AUTH_REQUIRED')!['reason']).toBe('refresh_token_wrong_account');
    runner.stop();
  });

  it('backfills inbound history since the watermark and skips our own messages', async () => {
    writeToken();
    const now = Math.floor(Date.now() / 1000);
    // A store created an hour ago, last message ten minutes ago: a restart.
    fs.rmSync(accountPaths('rukia').relayed, { force: true });
    store = new DedupeStore(accountPaths('rukia').relayed, { retentionSeconds: 30 * 86_400, nowMs: () => (now - 3600) * 1000 });
    store.load();
    store.mark('seed:1:0', 'relayed', now - 600);
    const runner = makeRunner();
    runner.start();
    const client = clients[0]!;
    const chat = client.chat as unknown as FakeChat;
    chat.sessions = [{ steamid_friend: SENDER, time_last_message: new Date() }];
    chat.history[SENDER] = [
      { sender: SENDER, server_timestamp: new Date((now - 300) * 1000), ordinal: 0, message: 'while you were away' },
      { sender: RUKIA.steamId, server_timestamp: new Date((now - 200) * 1000), ordinal: 0, message: 'our reply' },
    ];
    client.goOnline(RUKIA.steamId);
    await vi.advanceTimersByTimeAsync(0);
    expect(enqueued.map((e) => e.dm.text)).toEqual(['while you were away']);
    expect(enqueued[0]!.dm.source).toBe('backfill');
    expect(await enqueued[0]!.lookup!()).toBe(`name-${SENDER.slice(-3)}`);
    expect(logs.find((e) => e.event === 'BACKFILL_DONE')).toMatchObject({ queued: 1, ignored: 1 });
    runner.stop();
  });
});
