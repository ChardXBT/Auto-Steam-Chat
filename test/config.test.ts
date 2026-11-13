import { describe, expect, it } from 'vitest';
import { ConfigError, loadSecrets, parseConfig } from '../src/config.js';

function issues(raw: unknown): string[] {
  try {
    parseConfig(raw);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
}

describe('config validation', () => {
  it('defaults are valid and use the exact labels and distinct logonIDs', () => {
    const config = parseConfig(undefined);
    expect(config.accounts.main.label).toBe('S | Skins');
    expect(config.accounts.rukia.label).toBe('Rukia | Skins');
    expect(config.accounts.rukia.steamId).toBe('76561199825952724');
    expect(config.accounts.main.logonId).not.toBe(config.accounts.rukia.logonId);
    expect(config.personaState).toBe('online');
    expect(config.reconnectBackoffMs).toEqual([5000, 15000, 30000, 60000, 300000, 600000]);
  });

  it('config.example.json parses to the defaults', async () => {
    const example = (await import('../config.example.json', { with: { type: 'json' } })).default;
    expect(parseConfig(example)).toEqual(parseConfig(undefined));
  });

  it('rejects logonIDs that would kick another fleet session', () => {
    expect(issues({ accounts: { main: { logon_id: 0 } } }).join()).toMatch(/logon_id/);
    expect(issues({ accounts: { main: { logon_id: 0x5a17b0 } } }).join()).toMatch(/collides/);
    expect(issues({ accounts: { main: { logon_id: 0x5a17b0 - 0x100 } } }).join()).toMatch(/collides/);
    expect(issues({ accounts: { main: { logon_id: 7 }, rukia: { logon_id: 7 } } }).join()).toMatch(/unique/);
    expect(issues({ accounts: { main: { logon_id: 7 }, rukia: { logon_id: 7 + 0x100 } } }).join()).toMatch(/unique/);
  });

  it('rejects bad SteamIDs, unknown accounts, and all-disabled', () => {
    expect(issues({ accounts: { main: { steam_id: '123' } } }).join()).toMatch(/steam_id/);
    expect(issues({ accounts: { alt: {} } }).join()).toMatch(/unknown account/);
    expect(issues({ accounts: { main: { enabled: false }, rukia: { enabled: false } } }).join()).toMatch(/at least one/);
  });

  it('refuses secrets in config.json', () => {
    const found = issues({ discord: { webhook_url: 'https://discord.com/api/webhooks/1/abc' }, telegram: { bot_token: 'x' } });
    expect(found.filter((i) => i.includes('secrets belong in .env'))).toHaveLength(2);
    expect(found.join()).not.toContain('abc');
  });

  it('validates persona, backfill, time zone, ladder and the Discord username', () => {
    expect(issues({ persona_state: 'offline' }).join()).toMatch(/persona_state/);
    expect(issues({ backfill: { max_hours: 9999 } }).join()).toMatch(/max_hours/);
    expect(issues({ display_time_zone: 'Mars/Base' }).join()).toMatch(/time zone/);
    expect(issues({ reconnect_backoff_ms: [] }).join()).toMatch(/reconnect_backoff_ms/);
    expect(issues({ reconnect_backoff_ms: [10] }).join()).toMatch(/reconnect_backoff_ms/);
    expect(issues({ discord: { username: 'my discord relay' } }).join()).toMatch(/username/);
    expect(issues({ backfill: { enabled: 'yes' } }).join()).toMatch(/true or false/);
  });
});

describe('secrets from the environment', () => {
  const webhook = `https://discord.com/api/webhooks/123456789012345678/${'a'.repeat(68)}`;
  const token = `1234567890:${'A'.repeat(35)}`;

  it('reports every missing variable by name and disables the sinks', () => {
    const s = loadSecrets({});
    expect(s.discord).toBeNull();
    expect(s.telegram).toBeNull();
    expect(s.problems.map((p) => p.variable).sort()).toEqual(['DISCORD_WEBHOOK_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']);
  });

  it('accepts well-formed values', () => {
    const s = loadSecrets({ DISCORD_WEBHOOK_URL: webhook, DISCORD_MENTION_USER_ID: '123456789012345678', TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '-1001234567890' });
    expect(s.problems).toEqual([]);
    expect(s.discord).toEqual({ webhookUrl: webhook, mentionUserId: '123456789012345678' });
    expect(s.telegram).toEqual({ botToken: token, chatId: '-1001234567890' });
  });

  it('disables only the malformed sink and never echoes the value', () => {
    const s = loadSecrets({ DISCORD_WEBHOOK_URL: 'https://example.com/hook/secretvalue', TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '42' });
    expect(s.discord).toBeNull();
    expect(s.telegram).not.toBeNull();
    expect(s.problems).toEqual([{ variable: 'DISCORD_WEBHOOK_URL', issue: 'malformed', effect: 'discord_disabled' }]);
    expect(JSON.stringify(s.problems)).not.toContain('secretvalue');
  });

  it('keeps Discord without a ping when the mention id is missing or malformed', () => {
    const s = loadSecrets({ DISCORD_WEBHOOK_URL: webhook, DISCORD_MENTION_USER_ID: '@me' });
    expect(s.discord).toEqual({ webhookUrl: webhook, mentionUserId: null });
    expect(s.problems).toContainEqual({ variable: 'DISCORD_MENTION_USER_ID', issue: 'malformed', effect: 'discord_no_ping' });
  });
});
