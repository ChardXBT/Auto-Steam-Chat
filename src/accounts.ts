import path from 'node:path';

export type AccountId = 'main' | 'rukia';
export type AccountSelection = AccountId | 'both';
export const ACCOUNT_IDS: readonly AccountId[] = ['main', 'rukia'];

export interface AccountIdentity {
  label: string;
  steamId: string;
  logonId: number;
}

/**
 * Built-in identities. Labels are exact (cs-notifier `ACCEPTED_ACCOUNTS`).
 * The main SteamID64 comes from Steam-Trade-Acceptor's config.example.json.
 *
 * logonIDs must differ from every other session on these accounts from this
 * IP, or Steam kicks one with LogonSessionReplaced (docs/RESEARCH.md §4):
 * the acceptor uses 0, the autobuyer session helper 0x5a17b0.
 */
export const ACCOUNT_DEFAULTS: Readonly<Record<AccountId, AccountIdentity>> = {
  main: { label: 'S | Skins', steamId: '76561199798489148', logonId: 0x41534301 },
  rukia: { label: 'Rukia | Skins', steamId: '76561199825952724', logonId: 0x41534302 },
};

/** logonIDs known to be used by other fleet processes on these accounts. */
export const RESERVED_LOGON_IDS: ReadonlySet<number> = new Set([0, 0x5a17b0]);

/** `npm run signin` logs on beside the running service without kicking it. */
export const SIGNIN_LOGON_ID_OFFSET = 0x100;

export type Command = 'start' | 'signin' | 'help';

export function parseArgs(args: string[]): { command: Command; selection: AccountSelection } {
  let rest = args;
  let command: Command = 'start';
  const first = rest[0];
  if (first !== undefined && !first.startsWith('--')) {
    if (['help', '-h'].includes(first)) return { command: 'help', selection: 'both' };
    if (first !== 'start' && first !== 'signin') throw new Error(`Unknown command: ${first}`);
    command = first;
    rest = rest.slice(1);
  }
  let selection: AccountSelection = 'both';
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--help') return { command: 'help', selection: 'both' };
    if (arg !== '--account') throw new Error(`Unknown option: ${arg}`);
    const value = rest[++i];
    if (value === 'alt') selection = 'rukia';
    else if (value === 'main' || value === 'rukia' || value === 'both') selection = value;
    else throw new Error('--account must be main, rukia (or alt), or both');
  }
  return { command, selection };
}

export function selectedAccounts(selection: AccountSelection): AccountId[] {
  return selection === 'both' ? [...ACCOUNT_IDS] : [selection];
}

/** Root of everything this service writes. Overridable for tests. */
export function runtimeRoot(): string {
  return path.resolve(process.env['AUTO_STEAM_CHAT_RUNTIME_DIR'] || 'runtime');
}

/** Per-account paths. Every account, main included, gets its own tree. */
export function accountPaths(account: AccountId, root = runtimeRoot()) {
  const dir = path.join(root, 'accounts', account);
  return {
    dir,
    refreshToken: path.join(dir, 'refresh_token'),
    steamData: path.join(dir, 'steam-user-data'),
    relayed: path.join(dir, 'state', 'relayed.json'),
  };
}

export function runtimePaths(root = runtimeRoot()) {
  return {
    root,
    lock: path.join(root, 'auto-steam-chat.lock'),
    pause: path.join(root, 'PAUSE'),
    stop: path.join(root, 'STOP_REQUESTED'),
    logs: path.join(root, 'logs'),
    messages: path.join(root, 'messages.jsonl'),
  };
}

export function profileUrl(steamId64: string): string {
  return `https://steamcommunity.com/profiles/${steamId64}`;
}
