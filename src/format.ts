import { profileUrl } from './accounts.js';
import type { InboundDm } from './chat-listener.js';

/**
 * Pure formatting for the Discord and Telegram sinks. The message text is
 * never altered: Discord gets it Markdown-escaped (renders identically),
 * Telegram gets it as plain text (no parse_mode). Long text is split, never
 * truncated.
 */

export const TELEGRAM_MESSAGE_LIMIT = 4_000;
/** Discord allows 4096 in an embed description; keep a margin. */
export const DISCORD_DESCRIPTION_LIMIT = 4_000;
const SPLIT_LOOKBACK = 200;

const ACCOUNT_COLORS: Record<string, number> = { main: 0x66c0f4, rukia: 0xc06cf4 };

/*
 * Escaped so a DM cannot render as formatting or as a masked link
 * (`[looks trusted](https://elsewhere)`) or a user mention. `:` and `@` are
 * left alone so bare URLs stay clickable; allowed_mentions already stops any
 * ping from the text.
 */
const DISCORD_SPECIAL = new Set(['\\', '*', '_', '~', '`', '|', '>', '[', ']', '(', ')', '#', '<']);

/** One token per code point: escapes and surrogate pairs are never split. */
export function discordTokens(text: string): string[] {
  const out: string[] = [];
  let lineStart = true;
  for (const ch of text) {
    out.push(DISCORD_SPECIAL.has(ch) || (lineStart && (ch === '-' || ch === '+')) ? `\\${ch}` : ch);
    lineStart = ch === '\n';
  }
  return out;
}

export function escapeDiscord(text: string): string {
  return discordTokens(text).join('');
}

/** Inverse of escapeDiscord, for tests: what Discord renders. */
export function unescapeDiscord(text: string): string {
  return text.replace(/\\([\s\S])/gu, '$1');
}

/**
 * Greedy split of tokens into chunks whose joined length fits `limitFor(i)`,
 * preferring to break after a newline or space in the last SPLIT_LOOKBACK
 * characters. Joining the chunks gives back exactly the input.
 */
export function chunkTokens(tokens: string[], limitFor: (chunkIndex: number) => number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  const lastBreakIn = (arr: string[]): number => {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] === '\n' || arr[i] === ' ') return i;
    return -1;
  };
  for (const token of tokens) {
    const limit = limitFor(chunks.length);
    if (current.length > 0 && length + token.length > limit) {
      let cut = current.length;
      const lastBreak = lastBreakIn(current);
      if (lastBreak >= 0) {
        const tail = current.slice(lastBreak + 1).join('').length;
        if (tail <= SPLIT_LOOKBACK) cut = lastBreak + 1;
      }
      chunks.push(current.slice(0, cut).join(''));
      current = current.slice(cut);
      length = current.join('').length;
    }
    current.push(token);
    length += token.length;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current.join(''));
  return chunks;
}

export function formatLocalTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    second: '2-digit', timeZoneName: 'short',
  }).format(date);
}

export interface DiscordFormatOptions {
  mentionUserId: string | null;
  username: string;
}

export interface DiscordPayload {
  username: string;
  content?: string;
  allowed_mentions: { parse: never[]; users: string[] };
  embeds: Array<Record<string, unknown>>;
}

export function formatDiscordPayloads(dm: InboundDm, opts: DiscordFormatOptions): DiscordPayload[] {
  const body = dm.text.length > 0 ? discordTokens(dm.text) : ['*(empty message)*'];
  const chunks = chunkTokens(body, () => DISCORD_DESCRIPTION_LIMIT);
  const unix = Math.floor(dm.serverTimestamp.getTime() / 1000);
  const iso = dm.serverTimestamp.toISOString();
  const late = dm.source === 'backfill' ? ' (delivered late)' : '';
  const label = escapeDiscord(dm.accountLabel);
  const fields = [
    { name: 'From', value: dm.senderName ? escapeDiscord(dm.senderName).slice(0, 1024) : '(unknown name)', inline: true },
    { name: 'SteamID64', value: dm.senderSteamId, inline: true },
    { name: 'Account', value: `${label} (${dm.account})`, inline: true },
    { name: 'Profile', value: profileUrl(dm.senderSteamId), inline: false },
    { name: 'Sent', value: `<t:${unix}:F> · ${iso}${dm.timestampSource === 'local' ? ' (local clock)' : ''}`, inline: false },
    ...(dm.fromLimitedAccount ? [{ name: 'Limited account', value: 'yes', inline: true }] : []),
  ];
  return chunks.map((description, i) => {
    const part = chunks.length > 1 ? ` · part ${i + 1}/${chunks.length}` : '';
    const first = i === 0;
    const payload: DiscordPayload = {
      username: opts.username,
      allowed_mentions: { parse: [], users: first && opts.mentionUserId ? [opts.mentionUserId] : [] },
      embeds: [{
        title: `Steam DM → ${dm.accountLabel}${late}${first ? '' : ` (part ${i + 1}/${chunks.length})`}`.slice(0, 256),
        description,
        color: ACCOUNT_COLORS[dm.account] ?? 0x888888,
        ...(first ? { fields } : {}),
        footer: { text: `Auto-Steam-Chat${part} · ${dm.msgId}` },
        timestamp: iso,
      }],
    };
    if (first) payload.content = `${opts.mentionUserId ? `<@${opts.mentionUserId}> ` : ''}Steam DM to **${label}**${late}`;
    return payload;
  });
}

export function formatTelegramMessages(dm: InboundDm, timeZone: string): string[] {
  const late = dm.source === 'backfill' ? ' (delivered late)' : '';
  const header = [
    `📨 Steam DM → ${dm.accountLabel} (${dm.account})${late}`,
    `From: ${dm.senderName ?? '(unknown name)'}`,
    `SteamID64: ${dm.senderSteamId}`,
    `Profile: ${profileUrl(dm.senderSteamId)}`,
    `Sent: ${formatLocalTime(dm.serverTimestamp, timeZone)} (${dm.serverTimestamp.toISOString()})`
      + (dm.timestampSource === 'local' ? ' (local clock)' : ''),
    ...(dm.fromLimitedAccount ? ['Limited account: yes'] : []),
  ].join('\n');
  const body = dm.text.length > 0 ? Array.from(dm.text) : Array.from('(empty message)');
  // The continuation prefix is bounded by "(part 999/999, <label>)\n".
  const continuationRoom = TELEGRAM_MESSAGE_LIMIT - `(part 999/999, ${dm.accountLabel})\n`.length;
  const firstRoom = TELEGRAM_MESSAGE_LIMIT - header.length - 2;
  const chunks = chunkTokens(body, (i) => (i === 0 ? firstRoom : continuationRoom));
  return chunks.map((chunk, i) => (i === 0
    ? `${header}\n\n${chunk}`
    : `(part ${i + 1}/${chunks.length}, ${dm.accountLabel})\n${chunk}`));
}

/** Fleet ops notices (STARTUP, SHUTDOWN, auth alerts). Never carries a DM body. */
export interface OpsNotice {
  kind: string;
  summary: string;
  fields?: Record<string, string | number | boolean>;
  /** Ping the owner: only for things that need them to act. */
  mention: boolean;
}

const NOTICE_COLORS: Record<string, number> = {
  STARTUP: 0x8888ff, SHUTDOWN: 0x888888, INTERACTIVE_AUTH_REQUIRED: 0xff8800, LOGON_SESSION_REPLACED: 0xff0000,
};

export function formatDiscordNotice(notice: OpsNotice, opts: DiscordFormatOptions): DiscordPayload {
  const mention = notice.mention && opts.mentionUserId ? opts.mentionUserId : null;
  return {
    username: opts.username,
    ...(mention ? { content: `<@${mention}> ${notice.kind}` } : {}),
    allowed_mentions: { parse: [], users: mention ? [mention] : [] },
    embeds: [{
      title: `Auto-Steam-Chat — ${notice.kind}`.slice(0, 256),
      description: escapeDiscord(notice.summary).slice(0, 4000),
      color: NOTICE_COLORS[notice.kind] ?? 0xaaaaaa,
      fields: Object.entries(notice.fields ?? {}).slice(0, 25).map(([name, value]) => ({
        name: name.slice(0, 256), value: escapeDiscord(String(value)).slice(0, 1024) || '-', inline: true,
      })),
      timestamp: new Date().toISOString(),
    }],
  };
}

export function formatTelegramNotice(notice: OpsNotice): string {
  const lines = [`⚙️ Auto-Steam-Chat — ${notice.kind}`, notice.summary];
  for (const [k, v] of Object.entries(notice.fields ?? {})) lines.push(`${k}: ${String(v)}`);
  return lines.join('\n').slice(0, TELEGRAM_MESSAGE_LIMIT);
}
