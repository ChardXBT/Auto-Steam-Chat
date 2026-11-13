import crypto from 'node:crypto';
import type { AccountConfig } from './config.js';
import type { AccountId } from './accounts.js';

/** One inbound Steam DM, normalised. The only shape the relay and sinks see. */
export interface InboundDm {
  account: AccountId;
  accountLabel: string;
  accountSteamId: string;
  senderSteamId: string;
  senderName: string | null;
  /** Verbatim text. Never trimmed, rewritten or summarised. */
  text: string;
  /** Steam server time (whole seconds); local time only if Steam sent none. */
  serverTimestamp: Date;
  timestampSource: 'steam' | 'local';
  ordinal: number;
  fromLimitedAccount: boolean;
  source: 'live' | 'backfill';
  /** `${sender}:${unixSeconds}:${ordinal}`: Steam's own message address (docs/RESEARCH.md §3). */
  key: string;
  /** Short, log-safe id: lets an ops event be matched to its record in messages.jsonl. */
  msgId: string;
}

interface SteamIdLike { getSteamID64(): string }
type SteamIdInput = SteamIdLike | string | null | undefined;

/** steam-user `IncomingFriendMessage` (chatroom.js:1031), only the fields used. */
export interface RawFriendMessage {
  steamid_friend: SteamIdInput;
  chat_entry_type?: number;
  message?: string | null;
  message_no_bbcode?: string | null;
  server_timestamp?: Date | null;
  ordinal?: number | null;
  local_echo?: boolean | null;
  from_limited_account?: boolean | null;
}

/** steam-user `getFriendMessageHistory` entry (chatroom.js:700). */
export interface RawHistoryMessage {
  sender: SteamIdInput;
  server_timestamp: Date | null;
  ordinal?: number | null;
  message?: string | null;
}

const CHAT_MSG = 1;

export function steamId64(id: SteamIdInput): string | null {
  if (!id) return null;
  if (typeof id === 'string') return /^\d{17}$/.test(id) ? id : null;
  try {
    const s = id.getSteamID64();
    return /^\d{17}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

export function dedupeKey(senderSteamId: string, unixSeconds: number, ordinal: number): string {
  return `${senderSteamId}:${unixSeconds}:${ordinal}`;
}

export function messageId(account: AccountId, key: string): string {
  return crypto.createHash('sha256').update(`${account}|${key}`).digest('hex').slice(0, 16);
}

function build(
  account: AccountConfig,
  sender: string,
  text: string,
  timestamp: Date | null | undefined,
  ordinal: number | null | undefined,
  extra: { senderName: string | null; fromLimitedAccount: boolean; source: InboundDm['source'] },
  nowMs: number,
): InboundDm {
  const valid = timestamp instanceof Date && !Number.isNaN(timestamp.getTime()) && timestamp.getTime() > 0;
  const unix = Math.floor((valid ? timestamp.getTime() : nowMs) / 1000);
  const ord = Number.isInteger(ordinal) && (ordinal as number) >= 0 ? (ordinal as number) : 0;
  const key = dedupeKey(sender, unix, ord);
  return {
    account: account.id,
    accountLabel: account.label,
    accountSteamId: account.steamId,
    senderSteamId: sender,
    senderName: extra.senderName,
    text,
    serverTimestamp: new Date(unix * 1000),
    timestampSource: valid ? 'steam' : 'local',
    ordinal: ord,
    fromLimitedAccount: extra.fromLimitedAccount,
    source: extra.source,
    key,
    msgId: messageId(account.id, key),
  };
}

export type NormalizeResult =
  | { kind: 'dm'; dm: InboundDm }
  | { kind: 'ignored'; reason: 'echo' | 'not_a_message' | 'own_message' | 'no_sender' };

/**
 * A live `chat.on('friendMessage')` payload. Echoes (our own messages from
 * another session) and non-message entry types are ignored.
 * `message_no_bbcode` is what the sender typed; steam-user falls back to
 * `message` when Steam omits it.
 */
export function normalizeLive(account: AccountConfig, raw: RawFriendMessage, senderName: string | null,
  nowMs = Date.now()): NormalizeResult {
  if (raw.local_echo) return { kind: 'ignored', reason: 'echo' };
  if (raw.chat_entry_type !== undefined && raw.chat_entry_type !== CHAT_MSG) return { kind: 'ignored', reason: 'not_a_message' };
  const sender = steamId64(raw.steamid_friend);
  if (!sender) return { kind: 'ignored', reason: 'no_sender' };
  if (sender === account.steamId) return { kind: 'ignored', reason: 'own_message' };
  const text = raw.message_no_bbcode ?? raw.message ?? '';
  return {
    kind: 'dm',
    dm: build(account, sender, text, raw.server_timestamp, raw.ordinal,
      { senderName, fromLimitedAccount: raw.from_limited_account === true, source: 'live' }, nowMs),
  };
}

/** A backfilled history entry. History holds both directions; ours are dropped. */
export function normalizeHistory(account: AccountConfig, raw: RawHistoryMessage, senderName: string | null,
  nowMs = Date.now()): NormalizeResult {
  const sender = steamId64(raw.sender);
  if (!sender) return { kind: 'ignored', reason: 'no_sender' };
  if (sender === account.steamId) return { kind: 'ignored', reason: 'own_message' };
  return {
    kind: 'dm',
    dm: build(account, sender, raw.message ?? '', raw.server_timestamp, raw.ordinal,
      { senderName, fromLimitedAccount: false, source: 'backfill' }, nowMs),
  };
}

/** The subset of `client.chat` (SteamChatRoomClient) the backfill uses. */
export interface ChatHistoryApi {
  getActiveFriendMessageSessions(options?: { conversationsSince?: Date | number }): Promise<{
    sessions: Array<{ steamid_friend: SteamIdInput; time_last_message: Date | null }>;
  }>;
  getFriendMessageHistory(friend: string, options?: { maxCount?: number; wantBbcode?: boolean; startTime?: Date | number }): Promise<{
    messages: RawHistoryMessage[];
    more_available: boolean;
  }>;
}

export interface BackfillOutcome {
  messages: Array<{ friend: string; message: RawHistoryMessage }>;
  sessionsChecked: number;
  truncatedFriends: string[];
  failedFriends: string[];
}

/**
 * Messages since `since` from every recently active conversation, oldest
 * first. One friend failing is skipped; the rest still backfill.
 */
export async function collectBackfill(chat: ChatHistoryApi, since: Date): Promise<BackfillOutcome> {
  const { sessions } = await chat.getActiveFriendMessageSessions({ conversationsSince: since });
  const outcome: BackfillOutcome = { messages: [], sessionsChecked: 0, truncatedFriends: [], failedFriends: [] };
  for (const session of sessions ?? []) {
    const friend = steamId64(session.steamid_friend);
    if (!friend) continue;
    if (session.time_last_message && session.time_last_message.getTime() < since.getTime()) continue;
    outcome.sessionsChecked++;
    try {
      const history = await chat.getFriendMessageHistory(friend, { startTime: since, maxCount: 100, wantBbcode: false });
      if (history.more_available) outcome.truncatedFriends.push(friend);
      for (const message of history.messages ?? []) {
        if (message.server_timestamp && message.server_timestamp.getTime() < since.getTime()) continue;
        outcome.messages.push({ friend, message });
      }
    } catch {
      outcome.failedFriends.push(friend);
    }
  }
  outcome.messages.sort((a, b) => {
    const ta = a.message.server_timestamp?.getTime() ?? 0;
    const tb = b.message.server_timestamp?.getTime() ?? 0;
    return ta - tb || (a.message.ordinal ?? 0) - (b.message.ordinal ?? 0);
  });
  return outcome;
}
