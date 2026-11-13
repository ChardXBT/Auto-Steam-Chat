import { AccountRunner } from './account-runner.js';
import {
  accountPaths, parseArgs, runtimePaths, selectedAccounts, type AccountId, type AccountSelection,
} from './accounts.js';
import { signIn, terminalIO } from './auth.js';
import { ConfigError, loadConfig, loadEnvFile, loadSecrets, type AppConfig } from './config.js';
import { DedupeStore } from './dedupe.js';
import { acquireLock, releaseLock } from './lock.js';
import { closeLogs, configureLogDir, log, logError, RUN_ID } from './logger.js';
import { FleetNotifier } from './ops-notify.js';
import { ControlFiles } from './pause.js';
import { Relay, type Sink } from './relay.js';
import { DiscordSink } from './sinks/discord.js';
import { MessageRecorder } from './sinks/jsonl.js';
import { TelegramSink } from './sinks/telegram.js';

const HELP = `Auto-Steam-Chat: relays inbound Steam DMs to Discord and Telegram.

  npm start [-- --account main|rukia|both]     run the relay (default: both)
  npm run signin [-- --account main|rukia|both]  one-time interactive Steam sign-in

Control files: runtime/PAUSE (hold delivery), runtime/STOP_REQUESTED (clean stop).`;

const HEALTH_BEAT_MS = 60_000;
const RELAY_DRAIN_MS = 15_000;
const NOTICE_FLUSH_MS = 10_000;

/*
 * Fleet convention (Steam-Trade-Acceptor src/worker.ts): an exception that
 * escaped every boundary is logged and the process exits 1 so the
 * supervisor restarts it. Reporting is best effort; the exit code is what
 * the supervisor relies on.
 */
process.on('uncaughtException', (err) => {
  try { logError('UNCAUGHT_EXCEPTION', err); } catch { /* keep the exit path */ }
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  try { logError('UNHANDLED_REJECTION', reason); } catch { /* keep the exit path */ }
  process.exit(1);
});

function enabledAccounts(config: AppConfig, selection: AccountSelection): AccountId[] {
  return selectedAccounts(selection).filter((id) => config.accounts[id].enabled);
}

async function runSignin(config: AppConfig, selection: AccountSelection): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error('signin needs an interactive terminal (it asks for the password and a Steam Guard code).');
    return 2;
  }
  configureLogDir(runtimePaths().logs);
  let worst = 0;
  for (const id of enabledAccounts(config, selection)) {
    const result = await signIn(config.accounts[id], terminalIO());
    if (result.ok) {
      console.log(`Signed in: ${config.accounts[id].label}. A running service picks the new token up on its next retry.`);
    } else {
      console.error(`Sign-in failed for ${config.accounts[id].label}: ${result.error}`);
      worst = Math.max(worst, result.exitCode);
    }
  }
  closeLogs();
  return worst;
}

async function runService(config: AppConfig, selection: AccountSelection, configSource: string): Promise<number> {
  const paths = runtimePaths();
  configureLogDir(paths.logs);
  const lock = acquireLock(paths.lock);
  if (!lock.acquired) {
    log('LOCK_HELD', { path: paths.lock, heldByPid: lock.heldByPid });
    console.error(`Another Auto-Steam-Chat is running (pid ${lock.heldByPid}). If that is wrong, delete ${paths.lock}.`);
    closeLogs();
    return 1;
  }
  log('LOCK_ACQUIRED', { path: paths.lock, pid: process.pid, ...(lock.tookOverFromPid ? { tookOverFromPid: lock.tookOverFromPid } : {}) });

  const control = new ControlFiles(paths.pause, paths.stop);
  if (control.stopRequested()) {
    log('STOP_FILE_DETECTED', { path: paths.stop, phase: 'startup' });
    releaseLock(paths.lock);
    closeLogs();
    return 0;
  }

  const secrets = loadSecrets();
  for (const problem of secrets.problems) log('SINK_CONFIG', problem);
  const discord = config.discord.enabled && secrets.discord
    ? new DiscordSink({ webhookUrl: secrets.discord.webhookUrl, mentionUserId: secrets.discord.mentionUserId, username: config.discord.username })
    : null;
  const telegram = config.telegram.enabled && secrets.telegram
    ? new TelegramSink({ botToken: secrets.telegram.botToken, chatId: secrets.telegram.chatId, timeZone: config.displayTimeZone })
    : null;
  const sinks: Sink[] = [discord, telegram].filter((s): s is DiscordSink | TelegramSink => s !== null);
  if (sinks.length === 0) log('NO_NETWORK_SINKS', { effect: `DMs are recorded only in ${paths.messages}` });
  const notifier = new FleetNotifier(discord, telegram);

  const accounts = enabledAccounts(config, selection);
  const retentionSeconds = Math.max(config.backfill.maxHours, 24) * 3600 + 7 * 86_400;
  const stores: Partial<Record<AccountId, DedupeStore>> = {};
  for (const id of accounts) {
    const store = new DedupeStore(accountPaths(id).relayed, { retentionSeconds });
    store.load();
    const pending = store.pending().length;
    if (pending > 0) log('DEDUPE_PENDING', { account: id, pending, effect: 'delivered if the backfill sees them again; text is in messages.jsonl' });
    stores[id] = store;
  }
  const relay = new Relay({ stores, recorder: new MessageRecorder(paths.messages), sinks, isPaused: () => control.isPaused() });
  const runners = accounts.map((id) => new AccountRunner({ account: config.accounts[id], config, relay, store: stores[id]!, notifier }));

  log('STARTED', {
    run: RUN_ID, accounts, config: configSource, persona: config.personaState, backfill: config.backfill,
    sinks: sinks.map((s) => s.name), paused: control.isPaused(), node: process.version,
  });
  if (discord && config.discord.notifyStartup) {
    notifier.notify({
      kind: 'STARTUP', mention: false, summary: 'Relaying inbound Steam DMs.',
      fields: { accounts: accounts.map((id) => config.accounts[id].label).join(', '), sinks: sinks.map((s) => s.name).join(', '), persona: config.personaState },
    });
  }
  for (const runner of runners) runner.start();

  const health = setInterval(() => {
    log('HEALTH_BEAT', {
      accounts: Object.fromEntries(accounts.map((id, i) => [id, runners[i]!.health()])),
      queueDepth: relay.depth, paused: control.isPaused(), relay: relay.stats,
    });
  }, HEALTH_BEAT_MS);

  return new Promise<number>((resolve) => {
    let shuttingDown = false;
    const shutdown = async (reason: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      log('SHUTDOWN_REQUESTED', { reason });
      clearInterval(health);
      unwatch();
      for (const runner of runners) runner.stop();
      const drained = await relay.stop(RELAY_DRAIN_MS);
      if (discord && config.discord.notifyShutdown) {
        notifier.notify({ kind: 'SHUTDOWN', mention: false, summary: `Stopped (${reason}).`, fields: { relayed_this_run: relay.stats.delivered } });
      }
      await notifier.flush(NOTICE_FLUSH_MS);
      log('SHUTDOWN', { reason, drained, relay: relay.stats });
      releaseLock(paths.lock);
      closeLogs();
      // steam-user can keep a socket or timer open briefly after logOff.
      setTimeout(() => process.exit(0), 5_000).unref();
      resolve(0);
    };
    const unwatch = control.watchStop(() => {
      log('STOP_FILE_DETECTED', { path: paths.stop, phase: 'running' });
      void shutdown('stop_file');
    });
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  });
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (parsed.command === 'help') {
    console.log(HELP);
    return 0;
  }
  try {
    loadEnvFile();
  } catch (err) {
    console.error(`ENV_LOAD_FAILED: ${(err as Error).message}`);
    return 1;
  }
  let loaded;
  try {
    loaded = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('CONFIG_INVALID');
      for (const issue of err.issues) console.error(`  - ${issue}`);
      return 1;
    }
    throw err;
  }
  if (enabledAccounts(loaded.config, parsed.selection).length === 0) {
    console.error(`No enabled account matches --account ${parsed.selection}.`);
    return 2;
  }
  return parsed.command === 'signin'
    ? runSignin(loaded.config, parsed.selection)
    : runService(loaded.config, parsed.selection, loaded.source);
}

main().then((code) => { process.exitCode = code; }, (err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
