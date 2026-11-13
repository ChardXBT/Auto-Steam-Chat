import { describe, expect, it } from 'vitest';
import {
  chunkTokens, DISCORD_DESCRIPTION_LIMIT, escapeDiscord, formatDiscordNotice, formatDiscordPayloads,
  formatTelegramMessages, TELEGRAM_MESSAGE_LIMIT, unescapeDiscord,
} from '../src/format.js';
import { makeDm, SENDER } from './helpers.js';

const OWNER = '123456789012345678';
const opts = { mentionUserId: OWNER, username: 'Auto-Steam-Chat' };

function longText(n: number): string {
  const words = ['trade', 'offer', 'ak47', 'redline', '🔥', 'price?', 'ok\n'];
  let s = '';
  for (let i = 0; s.length < n; i++) s += `${words[i % words.length]} `;
  return s.slice(0, n);
}

describe('Discord formatting', () => {
  it('mentions the owner, allows only that mention, and carries sender, account and profile', () => {
    const [payload, ...rest] = formatDiscordPayloads(makeDm(), opts);
    expect(rest).toHaveLength(0);
    expect(payload!.content).toBe(`<@${OWNER}> Steam DM to **S \\| Skins**`);
    expect(payload!.allowed_mentions).toEqual({ parse: [], users: [OWNER] });
    const embed = payload!.embeds[0]!;
    expect(embed['title']).toBe('Steam DM → S | Skins');
    const fields = embed['fields'] as Array<{ name: string; value: string }>;
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]));
    expect(byName['SteamID64']).toBe(SENDER);
    expect(byName['Profile']).toBe(`https://steamcommunity.com/profiles/${SENDER}`);
    expect(byName['Account']).toBe('S \\| Skins (main)');
    expect(byName['From']).toBe('Buyer');
    expect(byName['Sent']).toContain('2026-11-13T00:59:00.000Z');
  });

  it('renders the text verbatim: escaping round-trips and defuses links, mentions and markup', () => {
    const hostile = '[steamcommunity.com/tradeoffer](https://evil.example) @everyone <@1> **bold** `x` ||s|| > q\n- item\n# h \\ ok';
    const dm = makeDm({ text: hostile });
    const description = formatDiscordPayloads(dm, opts)[0]!.embeds[0]!['description'] as string;
    expect(unescapeDiscord(description)).toBe(hostile);
    expect(description).not.toContain('](');
    expect(description).toContain('\\[');
    expect(description).toContain('\\<@1\\>');
    expect(description).toContain('\n\\- item');
  });

  it('works without a mention id (no ping, nothing allowed)', () => {
    const [payload] = formatDiscordPayloads(makeDm(), { mentionUserId: null, username: 'x' });
    expect(payload!.content).toBe('Steam DM to **S \\| Skins**');
    expect(payload!.allowed_mentions.users).toEqual([]);
  });

  it('splits a long DM without losing or changing a character, mentioning only once', () => {
    const text = longText(9_500).replace(/a/g, '*');
    const payloads = formatDiscordPayloads(makeDm({ text }), opts);
    expect(payloads.length).toBe(3);
    const descriptions = payloads.map((p) => p.embeds[0]!['description'] as string);
    for (const d of descriptions) expect(d.length).toBeLessThanOrEqual(DISCORD_DESCRIPTION_LIMIT);
    expect(unescapeDiscord(descriptions.join(''))).toBe(text);
    expect(payloads.filter((p) => p.content?.includes(`<@${OWNER}>`))).toHaveLength(1);
    expect(payloads.slice(1).every((p) => p.allowed_mentions.users.length === 0)).toBe(true);
    expect(payloads[2]!.embeds[0]!['footer']).toEqual({ text: expect.stringContaining('part 3/3') });
  });

  it('never splits an escape pair or a surrogate pair', () => {
    const text = '_'.repeat(2_100) + '😀'.repeat(1_500);
    const descriptions = formatDiscordPayloads(makeDm({ text }), opts).map((p) => p.embeds[0]!['description'] as string);
    for (const d of descriptions) {
      expect(d.endsWith('\\') && !d.endsWith('\\\\')).toBe(false);
      expect(/[\uD800-\uDBFF]$/.test(d)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(d)).toBe(false);
    }
    expect(unescapeDiscord(descriptions.join(''))).toBe(text);
  });

  it('flags late (backfilled) delivery and limited senders', () => {
    const [payload] = formatDiscordPayloads(makeDm({ source: 'backfill', fromLimitedAccount: true }), opts);
    expect(payload!.embeds[0]!['title']).toContain('(delivered late)');
    expect(payload!.content).toContain('(delivered late)');
    expect(JSON.stringify(payload!.embeds[0]!['fields'])).toContain('Limited account');
  });

  it('ops notices ping only when asked', () => {
    expect(formatDiscordNotice({ kind: 'STARTUP', summary: 's', mention: false }, opts).content).toBeUndefined();
    const alert = formatDiscordNotice({ kind: 'INTERACTIVE_AUTH_REQUIRED', summary: 's', mention: true }, opts);
    expect(alert.content).toContain(`<@${OWNER}>`);
    expect(alert.allowed_mentions.users).toEqual([OWNER]);
  });
});

describe('Telegram formatting', () => {
  it('sends plain text with the header and the verbatim body', () => {
    const text = '<b>not html</b> & [link](x) *raw*';
    const [message, ...rest] = formatTelegramMessages(makeDm({ text }), 'America/Toronto');
    expect(rest).toHaveLength(0);
    expect(message).toContain('📨 Steam DM → S | Skins (main)');
    expect(message).toContain(`SteamID64: ${SENDER}`);
    expect(message).toContain(`Profile: https://steamcommunity.com/profiles/${SENDER}`);
    expect(message).toContain('From: Buyer');
    expect(message!.endsWith(`\n\n${text}`)).toBe(true);
  });

  it('splits at the 4000-character limit and reassembles exactly', () => {
    const text = longText(11_000);
    const messages = formatTelegramMessages(makeDm({ text, account: 'rukia', accountLabel: 'Rukia | Skins' }), 'America/Toronto');
    expect(messages.length).toBeGreaterThan(2);
    for (const m of messages) expect(m.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    const body = messages.map((m, i) => (i === 0 ? m.slice(m.indexOf('\n\n') + 2) : m.slice(m.indexOf('\n') + 1))).join('');
    expect(body).toBe(text);
    expect(messages[1]!.startsWith(`(part 2/${messages.length}, Rukia | Skins)\n`)).toBe(true);
  });

  it('shows (unknown name) when the persona could not be resolved', () => {
    expect(formatTelegramMessages(makeDm({ senderName: null }), 'UTC')[0]).toContain('From: (unknown name)');
  });
});

describe('chunkTokens', () => {
  it('returns one empty chunk for empty input and prefers breaking at whitespace', () => {
    expect(chunkTokens([], () => 10)).toEqual(['']);
    const chunks = chunkTokens(Array.from('aaaa bbbb cccc'), () => 7);
    expect(chunks.join('')).toBe('aaaa bbbb cccc');
    expect(chunks[0]).toBe('aaaa ');
  });

  it('escapeDiscord leaves plain text and URLs alone', () => {
    expect(escapeDiscord('see https://steamcommunity.com/id/foo ok')).toBe('see https://steamcommunity.com/id/foo ok');
  });
});
