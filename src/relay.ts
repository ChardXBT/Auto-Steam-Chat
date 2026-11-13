import type { AccountId } from './accounts.js';
import type { InboundDm } from './chat-listener.js';
import type { DedupeStore } from './dedupe.js';
import { realSleep, type SendOutcome, type Sleep } from './http.js';
import { log } from './logger.js';

/** A delivery destination. `send` may reject; the relay isolates it either way. */
export interface Sink {
  readonly name: string;
  send(dm: InboundDm): Promise<SendOutcome>;
}

export interface DmRecorder {
  recordDm(dm: InboundDm): void;
  recordResult(dm: InboundDm, results: Record<string, SendOutcome>): void;
}

export interface RelayDeps {
  stores: Partial<Record<AccountId, DedupeStore>>;
  recorder: DmRecorder;
  sinks: Sink[];
  isPaused: () => boolean;
  sleep?: Sleep;
  maxQueue?: number;
  pausePollMs?: number;
  nameLookupTimeoutMs?: number;
}

export type NameLookup = () => Promise<string | null>;
export type EnqueueResult = 'queued' | 'duplicate' | 'overflow';

interface Item { dm: InboundDm; lookupName: NameLookup | undefined }

const unixSeconds = (dm: InboundDm): number => Math.floor(dm.serverTimestamp.getTime() / 1000);

/**
 * The single delivery path for both accounts. Steam handlers call `enqueue`
 * and return at once; one serial worker then, per DM:
 *   dedupe check → durable local record → wait while PAUSE → every sink in
 *   parallel, each isolated → mark relayed.
 * Nothing a sink does (throw, reject, hang up to its own timeout) can reach
 * the Steam listener or stop the next DM.
 */
export class Relay {
  private readonly queue: Item[] = [];
  private readonly inFlight = new Set<string>();
  private worker: Promise<void> | null = null;
  private stopping = false;
  private readonly sleep: Sleep;
  private readonly maxQueue: number;
  private readonly pausePollMs: number;
  private readonly nameLookupTimeoutMs: number;
  readonly stats = { delivered: 0, duplicates: 0, overflow: 0, sinkOk: {} as Record<string, number>, sinkFailed: {} as Record<string, number> };

  constructor(private readonly deps: RelayDeps) {
    this.sleep = deps.sleep ?? realSleep;
    this.maxQueue = deps.maxQueue ?? 1_000;
    this.pausePollMs = deps.pausePollMs ?? 1_000;
    this.nameLookupTimeoutMs = deps.nameLookupTimeoutMs ?? 5_000;
  }

  get depth(): number {
    return this.queue.length;
  }

  enqueue(dm: InboundDm, lookupName?: NameLookup): EnqueueResult {
    const id = `${dm.account}|${dm.key}`;
    if (this.inFlight.has(id) || this.deps.stores[dm.account]?.state(dm.key) === 'relayed') {
      this.stats.duplicates++;
      log('DM_DUPLICATE_SKIPPED', { account: dm.account, msgId: dm.msgId, source: dm.source });
      return 'duplicate';
    }
    if (this.stopping || this.queue.length >= this.maxQueue) {
      // Never only in memory: record it so a later backfill can still deliver it.
      this.recordOnce(dm);
      this.stats.overflow++;
      log('RELAY_QUEUE_FULL', { account: dm.account, msgId: dm.msgId, depth: this.queue.length, stopping: this.stopping });
      return 'overflow';
    }
    this.inFlight.add(id);
    this.queue.push({ dm, lookupName });
    this.worker ??= this.run().finally(() => { this.worker = null; });
    return 'queued';
  }

  /** Resolves once everything queued so far has been handled. */
  async drain(): Promise<void> {
    while (this.worker) await this.worker;
  }

  /**
   * Stop taking work, give the DM in progress up to `timeoutMs` to finish,
   * and record anything still queued so it is not lost. Returns true if the
   * worker finished in time.
   */
  async stop(timeoutMs: number): Promise<boolean> {
    this.stopping = true;
    const worker = this.worker;
    let finished = true;
    if (worker) {
      let timer: NodeJS.Timeout | undefined;
      finished = await Promise.race([
        worker.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
      if (timer) clearTimeout(timer);
    }
    for (const item of this.queue.splice(0)) {
      this.recordOnce(item.dm);
      this.inFlight.delete(`${item.dm.account}|${item.dm.key}`);
    }
    return finished;
  }

  private async run(): Promise<void> {
    for (let item = this.queue.shift(); item; item = this.queue.shift()) {
      try {
        await this.process(item);
      } catch (err) {
        log('RELAY_ITEM_FAILED', { account: item.dm.account, msgId: item.dm.msgId, error: err instanceof Error ? err.message : String(err) });
      } finally {
        this.inFlight.delete(`${item.dm.account}|${item.dm.key}`);
      }
    }
  }

  private async process(item: Item): Promise<void> {
    const { dm } = item;
    const store = this.deps.stores[dm.account];
    if (store?.state(dm.key) === 'relayed') {
      this.stats.duplicates++;
      return;
    }
    if (!dm.senderName && item.lookupName) dm.senderName = await this.lookupName(item.lookupName);
    this.recordOnce(dm);

    if (this.deps.isPaused()) {
      log('RELAY_PAUSED', { account: dm.account, msgId: dm.msgId, effect: 'recorded locally; delivery resumes when runtime/PAUSE is removed' });
      while (this.deps.isPaused()) {
        if (this.stopping) {
          log('RELAY_STOPPED_WHILE_PAUSED', { account: dm.account, msgId: dm.msgId });
          return;
        }
        await this.sleep(this.pausePollMs);
      }
      log('RELAY_RESUMED', { account: dm.account, msgId: dm.msgId });
    }

    const entries = await Promise.all(this.deps.sinks.map(async (sink): Promise<[string, SendOutcome]> => {
      try {
        return [sink.name, await sink.send(dm)];
      } catch (err) {
        return [sink.name, { ok: false, attempts: 0, error: `sink threw: ${err instanceof Error ? err.name : 'unknown'}` }];
      }
    }));
    const results = Object.fromEntries(entries);
    store?.mark(dm.key, 'relayed', unixSeconds(dm));
    try {
      this.deps.recorder.recordResult(dm, results);
    } catch (err) {
      log('DM_RECORD_FAILED', { account: dm.account, msgId: dm.msgId, stage: 'result', error: err instanceof Error ? err.message : String(err) });
    }
    for (const [name, outcome] of entries) {
      const bucket = outcome.ok ? this.stats.sinkOk : this.stats.sinkFailed;
      bucket[name] = (bucket[name] ?? 0) + 1;
      if (!outcome.ok) log('SINK_FAILED', { sink: name, account: dm.account, msgId: dm.msgId, status: outcome.status, attempts: outcome.attempts, error: outcome.error });
    }
    this.stats.delivered++;
    log('DM_RELAYED', {
      account: dm.account, msgId: dm.msgId, source: dm.source,
      sinks: Object.fromEntries(entries.map(([n, o]) => [n, o.ok ? 'ok' : 'failed'])),
    });
  }

  /** Durable record + `recorded` marker, unless this DM already has one. */
  private recordOnce(dm: InboundDm): void {
    const store = this.deps.stores[dm.account];
    if (store?.state(dm.key)) return;
    try {
      this.deps.recorder.recordDm(dm);
    } catch (err) {
      log('DM_RECORD_FAILED', { account: dm.account, msgId: dm.msgId, stage: 'dm', error: err instanceof Error ? err.message : String(err) });
    }
    store?.mark(dm.key, 'recorded', unixSeconds(dm));
    log('DM_RECEIVED', { account: dm.account, msgId: dm.msgId, source: dm.source, length: dm.text.length, timestampSource: dm.timestampSource });
  }

  private async lookupName(lookup: NameLookup): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        lookup(),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.nameLookupTimeoutMs); }),
      ]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
