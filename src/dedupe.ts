import { log } from './logger.js';
import { quarantine, readJson, writeJsonAtomic } from './state.js';

export type MarkerState = 'recorded' | 'relayed';

interface Marker {
  state: MarkerState;
  /** Message time, unix seconds: drives eviction. */
  ts: number;
  at: string;
}

interface StoreFile {
  version: 1;
  /** Newest Steam server time seen on this account (unix seconds), or null before the first message. */
  watermark: number | null;
  /** When this store was first created: the backfill never reaches before it. */
  created_at: number;
  markers: Record<string, Marker>;
}

export interface DedupeOptions {
  /** Markers older than this (by message time) are dropped on load. */
  retentionSeconds: number;
  nowMs?: () => number;
}

/**
 * Per-account record of which DMs were already relayed, so a reconnect or
 * restart (and the backfill that follows it) never relays one twice.
 *
 * `recorded` = written to messages.jsonl, sinks not yet tried (e.g. paused).
 * `relayed`  = sinks tried, whatever the outcome (docs/SPEC.md, dedupe model).
 * Every change is written atomically before the caller moves on.
 */
export class DedupeStore {
  private data: StoreFile;
  private readonly now: () => number;
  /** True if there was no usable store at load: a first run, not a restart. */
  fresh = false;

  constructor(private readonly file: string, private readonly opts: DedupeOptions) {
    this.now = opts.nowMs ?? Date.now;
    this.data = this.empty();
  }

  private empty(): StoreFile {
    return { version: 1, watermark: null, created_at: Math.floor(this.now() / 1000), markers: {} };
  }

  load(): void {
    const read = readJson(this.file);
    if (read.status === 'missing') {
      this.data = this.empty();
      this.fresh = true;
      this.save();
      return;
    }
    if (read.status === 'corrupt' || !isStoreFile(read.value)) {
      const movedTo = quarantine(this.file, this.now());
      log('DEDUPE_STATE_CORRUPT', {
        path: this.file, movedTo,
        error: read.status === 'corrupt' ? read.error : 'unexpected structure',
        effect: 'starting empty; the next backfill may relay recent messages again',
      });
      this.data = this.empty();
      // No floor: the next backfill re-reads the whole window. Duplicates
      // are possible, a missed DM is not (at-least-once).
      this.data.created_at = 0;
      this.fresh = false;
      this.save();
      return;
    }
    this.data = read.value;
    this.fresh = false;
    const cutoff = Math.floor(this.now() / 1000) - this.opts.retentionSeconds;
    let evicted = 0;
    for (const [key, marker] of Object.entries(this.data.markers)) {
      // The backfill window is far shorter than the retention, so an evicted
      // message can never be fetched again.
      if (marker.ts < cutoff) {
        delete this.data.markers[key];
        evicted++;
      }
    }
    if (evicted > 0) {
      log('DEDUPE_EVICTED', { path: this.file, evicted, remaining: Object.keys(this.data.markers).length });
      this.save();
    }
  }

  state(key: string): MarkerState | undefined {
    return this.data.markers[key]?.state;
  }

  get watermark(): number | null {
    return this.data.watermark;
  }

  get createdAt(): number {
    return this.data.created_at;
  }

  /** Keys still waiting for the sinks (recorded while paused or before a crash). */
  pending(): string[] {
    return Object.entries(this.data.markers).filter(([, m]) => m.state === 'recorded').map(([k]) => k);
  }

  mark(key: string, state: MarkerState, messageUnixSeconds: number): void {
    this.data.markers[key] = { state, ts: messageUnixSeconds, at: new Date(this.now()).toISOString() };
    if (this.data.watermark === null || messageUnixSeconds > this.data.watermark) this.data.watermark = messageUnixSeconds;
    this.save();
  }

  /**
   * A failed save is logged, not thrown: the relay must keep going. The
   * worst case is one duplicate relay after a restart.
   */
  private save(): void {
    try {
      writeJsonAtomic(this.file, this.data);
    } catch (err) {
      log('DEDUPE_SAVE_FAILED', { path: this.file, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

function isStoreFile(v: unknown): v is StoreFile {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o['version'] !== 1 || typeof o['created_at'] !== 'number') return false;
  if (o['watermark'] !== null && typeof o['watermark'] !== 'number') return false;
  const markers = o['markers'];
  if (!markers || typeof markers !== 'object' || Array.isArray(markers)) return false;
  return Object.values(markers as Record<string, unknown>).every((m) => {
    const mm = m as Record<string, unknown> | null;
    return !!mm && (mm['state'] === 'recorded' || mm['state'] === 'relayed') && typeof mm['ts'] === 'number';
  });
}
