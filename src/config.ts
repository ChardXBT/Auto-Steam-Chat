import fs from 'node:fs';
import path from 'node:path';
import {
  ACCOUNT_DEFAULTS, ACCOUNT_IDS, AccountId, RESERVED_LOGON_IDS, SIGNIN_LOGON_ID_OFFSET,
} from './accounts.js';

export const PERSONA_STATES = ['online', 'invisible', 'away', 'busy', 'looking_to_trade'] as const;
export type PersonaStateName = (typeof PERSONA_STATES)[number];

export interface AccountConfig {
  id: AccountId;
  enabled: boolean;
  label: string;
  steamId: string;
  logonId: number;
}

export interface AppConfig {
  accounts: Record<AccountId, AccountConfig>;
  personaState: PersonaStateName;
  backfill: { enabled: boolean; maxHours: number };
  discord: { enabled: boolean; username: string; notifyStartup: boolean; notifyShutdown: boolean };
  telegram: { enabled: boolean };
  displayTimeZone: string;
  reconnectBackoffMs: number[];
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid config: ${issues.join('; ')}`);
    this.name = 'ConfigError';
  }
}

const DEFAULT_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 300_000, 600_000];
const STEAM_ID64 = /^7656119\d{10}$/;
/** config.json must never hold a secret: they belong in .env only. */
const SECRET_LIKE_KEY = /(url|token|webhook|secret|password|cookie|api_?key)/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function findSecretKeys(value: unknown, at: string, out: string[]): void {
  if (Array.isArray(value)) value.forEach((v, i) => findSecretKeys(v, `${at}[${i}]`, out));
  else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      const where = at ? `${at}.${k}` : k;
      if (SECRET_LIKE_KEY.test(k)) out.push(`${where}: secrets belong in .env, not config.json`);
      findSecretKeys(v, where, out);
    }
  }
}

/** Validate a parsed config.json. Absent sections and keys take the defaults. */
export function parseConfig(raw: unknown): AppConfig {
  const issues: string[] = [];
  if (raw !== undefined && !isObj(raw)) throw new ConfigError(['config must be a JSON object']);
  const root: Obj = raw ?? {};
  findSecretKeys(root, '', issues);

  const section = (key: string): Obj => {
    const v = root[key];
    if (v === undefined) return {};
    if (!isObj(v)) { issues.push(`${key} must be an object`); return {}; }
    return v;
  };
  const bool = (obj: Obj, key: string, where: string, fallback: boolean): boolean => {
    const v = obj[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'boolean') { issues.push(`${where}.${key} must be true or false`); return fallback; }
    return v;
  };

  const accountsRaw = section('accounts');
  for (const key of Object.keys(accountsRaw)) {
    if (!(ACCOUNT_IDS as readonly string[]).includes(key)) issues.push(`accounts.${key}: unknown account (main or rukia)`);
  }
  const accounts = {} as Record<AccountId, AccountConfig>;
  for (const id of ACCOUNT_IDS) {
    const defaults = ACCOUNT_DEFAULTS[id];
    const a = accountsRaw[id] === undefined ? {} : accountsRaw[id];
    if (!isObj(a)) { issues.push(`accounts.${id} must be an object`); continue; }
    const where = `accounts.${id}`;
    const label = a['label'] ?? defaults.label;
    if (typeof label !== 'string' || !label.trim() || label.length > 64) issues.push(`${where}.label must be 1-64 characters`);
    const steamId = a['steam_id'] ?? defaults.steamId;
    if (typeof steamId !== 'string' || !STEAM_ID64.test(steamId)) issues.push(`${where}.steam_id must be a SteamID64 (7656119 + 10 digits)`);
    const logonId = a['logon_id'] ?? defaults.logonId;
    if (typeof logonId !== 'number' || !Number.isInteger(logonId) || logonId < 1 || logonId + SIGNIN_LOGON_ID_OFFSET > 0xffffffff) {
      issues.push(`${where}.logon_id must be an integer between 1 and ${0xffffffff - SIGNIN_LOGON_ID_OFFSET}`);
    } else if (RESERVED_LOGON_IDS.has(logonId) || RESERVED_LOGON_IDS.has(logonId + SIGNIN_LOGON_ID_OFFSET)) {
      issues.push(`${where}.logon_id ${logonId} collides with another fleet process (0 = Steam-Trade-Acceptor, ${0x5a17b0} = autobuyer session helper)`);
    }
    accounts[id] = {
      id,
      enabled: bool(a, 'enabled', where, true),
      label: typeof label === 'string' ? label.trim() : defaults.label,
      steamId: typeof steamId === 'string' ? steamId : defaults.steamId,
      logonId: typeof logonId === 'number' ? logonId : defaults.logonId,
    };
  }
  const allLogonIds = ACCOUNT_IDS.flatMap((id) => accounts[id] ? [accounts[id].logonId, accounts[id].logonId + SIGNIN_LOGON_ID_OFFSET] : []);
  if (new Set(allLogonIds).size !== allLogonIds.length) {
    issues.push(`accounts: every logon_id, and logon_id + ${SIGNIN_LOGON_ID_OFFSET} (sign-in), must be unique`);
  }
  if (ACCOUNT_IDS.every((id) => accounts[id] && !accounts[id].enabled)) issues.push('accounts: at least one account must be enabled');

  const persona = root['persona_state'] ?? 'online';
  if (typeof persona !== 'string' || !(PERSONA_STATES as readonly string[]).includes(persona)) {
    issues.push(`persona_state must be one of ${PERSONA_STATES.join(', ')}`);
  }

  const backfillRaw = section('backfill');
  const maxHours = backfillRaw['max_hours'] ?? 72;
  if (typeof maxHours !== 'number' || !Number.isFinite(maxHours) || maxHours < 0 || maxHours > 336) {
    issues.push('backfill.max_hours must be a number from 0 to 336');
  }

  const discordRaw = section('discord');
  const username = discordRaw['username'] ?? 'Auto-Steam-Chat';
  if (typeof username !== 'string' || !username.trim() || username.length > 80 || /discord|clyde/i.test(username)) {
    issues.push('discord.username must be 1-80 characters and not contain "discord" or "clyde" (Discord rejects those)');
  }
  const telegramRaw = section('telegram');
  const flags = {
    backfill: bool(backfillRaw, 'enabled', 'backfill', true),
    discord: bool(discordRaw, 'enabled', 'discord', true),
    notifyStartup: bool(discordRaw, 'notify_startup', 'discord', true),
    notifyShutdown: bool(discordRaw, 'notify_shutdown', 'discord', true),
    telegram: bool(telegramRaw, 'enabled', 'telegram', true),
  };

  const timeZone = root['display_time_zone'] ?? 'America/Toronto';
  if (typeof timeZone !== 'string' || !isTimeZone(timeZone)) issues.push('display_time_zone must be an IANA time zone');

  const backoff = root['reconnect_backoff_ms'] ?? DEFAULT_BACKOFF_MS;
  if (!Array.isArray(backoff) || backoff.length === 0
      || !backoff.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 1_000 && n <= 3_600_000)) {
    issues.push('reconnect_backoff_ms must be a non-empty list of integers from 1000 to 3600000');
  }

  if (issues.length > 0) throw new ConfigError(issues);
  return {
    accounts,
    personaState: persona as PersonaStateName,
    backfill: { enabled: flags.backfill, maxHours: maxHours as number },
    discord: {
      enabled: flags.discord,
      username: (username as string).trim(),
      notifyStartup: flags.notifyStartup,
      notifyShutdown: flags.notifyShutdown,
    },
    telegram: { enabled: flags.telegram },
    displayTimeZone: timeZone as string,
    reconnectBackoffMs: [...(backoff as number[])],
  };
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function configPath(): string {
  return path.resolve(process.env['AUTO_STEAM_CHAT_CONFIG_PATH'] || 'config.json');
}

/** config.json is optional: without it the built-in defaults apply. */
export function loadConfig(file = configPath()): { config: AppConfig; source: 'file' | 'defaults' } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: parseConfig(undefined), source: 'defaults' };
    throw new ConfigError([`cannot read ${file}: ${(err as Error).message}`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new ConfigError([`${file} is not valid JSON: ${(err as Error).message}`]);
  }
  return { config: parseConfig(raw), source: 'file' };
}

export function envFilePath(): string {
  return path.resolve(process.env['AUTO_STEAM_CHAT_ENV_PATH'] || '.env');
}

/** Load `.env` into process.env if it exists. Values already set in the environment win. */
export function loadEnvFile(file = envFilePath()): boolean {
  if (!fs.existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

export interface Secrets {
  discord: { webhookUrl: string; mentionUserId: string | null } | null;
  telegram: { botToken: string; chatId: string } | null;
  /** Variable names (never values) that were missing or malformed, with the effect. */
  problems: Array<{ variable: string; issue: 'missing' | 'malformed'; effect: string }>;
}

const DISCORD_WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d{15,22}\/[A-Za-z0-9_-]{30,}$/;
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const TELEGRAM_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_CHAT = /^-?\d{1,20}$/;

/**
 * A missing or malformed secret disables only its sink: DMs are still
 * recorded locally and the other sink still runs.
 */
export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const problems: Secrets['problems'] = [];
  const read = (name: string): string => (env[name] ?? '').trim();

  let discord: Secrets['discord'] = null;
  const webhookUrl = read('DISCORD_WEBHOOK_URL');
  const mention = read('DISCORD_MENTION_USER_ID');
  if (!webhookUrl) problems.push({ variable: 'DISCORD_WEBHOOK_URL', issue: 'missing', effect: 'discord_disabled' });
  else if (!DISCORD_WEBHOOK.test(webhookUrl)) problems.push({ variable: 'DISCORD_WEBHOOK_URL', issue: 'malformed', effect: 'discord_disabled' });
  else {
    let mentionUserId: string | null = null;
    if (!mention) problems.push({ variable: 'DISCORD_MENTION_USER_ID', issue: 'missing', effect: 'discord_no_ping' });
    else if (!DISCORD_SNOWFLAKE.test(mention)) problems.push({ variable: 'DISCORD_MENTION_USER_ID', issue: 'malformed', effect: 'discord_no_ping' });
    else mentionUserId = mention;
    discord = { webhookUrl, mentionUserId };
  }

  let telegram: Secrets['telegram'] = null;
  const botToken = read('TELEGRAM_BOT_TOKEN');
  const chatId = read('TELEGRAM_CHAT_ID');
  if (!botToken) problems.push({ variable: 'TELEGRAM_BOT_TOKEN', issue: 'missing', effect: 'telegram_disabled' });
  else if (!TELEGRAM_TOKEN.test(botToken)) problems.push({ variable: 'TELEGRAM_BOT_TOKEN', issue: 'malformed', effect: 'telegram_disabled' });
  if (!chatId) problems.push({ variable: 'TELEGRAM_CHAT_ID', issue: 'missing', effect: 'telegram_disabled' });
  else if (!TELEGRAM_CHAT.test(chatId)) problems.push({ variable: 'TELEGRAM_CHAT_ID', issue: 'malformed', effect: 'telegram_disabled' });
  if (TELEGRAM_TOKEN.test(botToken) && TELEGRAM_CHAT.test(chatId)) telegram = { botToken, chatId };

  return { discord, telegram, problems };
}
