import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry } from './atomic-rename.js';

/**
 * Ops logging: `chat_relay.log` (human) and `events.jsonl` (one JSON object
 * per line) under runtime/logs/, plus the console. Structure follows
 * Steam-Trade-Acceptor `src/logger.ts`; the value-shape patterns add the
 * webhook-URL and SteamID64 masks from steam-autobuyer `logging_setup.py`
 * and a Telegram bot-token mask.
 *
 * DM bodies never go through here (docs/SPEC.md "Privacy decision point").
 */

export type LogEvent = { timestamp: string; event: string } & Record<string, unknown>;

export const RUN_ID = crypto.randomBytes(6).toString('hex');
export const MAX_LOG_BYTES = 20 * 1024 * 1024;
export const LOG_BACKUPS = 3;

const SECRET_KEY = /(token|secret|password|passwd|cookie|sessionid|session_id|webhook|api_?key|authorization|guard_?code|two_?factor|steamloginsecure|steamrefresh)/i;
const SECRET_VALUE: Array<[RegExp, string]> = [
  [/https?:\/\/(?:[a-z0-9-]+\.)*(?:discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com)\/\S+/gi, '[redacted-webhook]'],
  [/api\.telegram\.org\/bot[^/\s]+/gi, 'api.telegram.org/bot[redacted]'],
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[redacted-bot-token]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
  [/(steamLoginSecure|sessionid|steamRefresh_steam|steamMachineAuth\d*)=[^;\s"]+/gi, '$1=[redacted]'],
  [/(?<!\d)7656119\d{10}(?!\d)/g, '7656119**********'],
];
const MAX_REDACT_DEPTH = 6;

export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_VALUE) out = out.replace(pattern, replacement);
  return out;
}

/** A plain, secret-free copy: cycles, throwing getters and BigInts become placeholders. */
export function redactEvent(value: unknown, key = '', depth = 0, ancestors: Set<unknown> = new Set()): unknown {
  if (typeof value === 'string') return key && SECRET_KEY.test(key) ? '[redacted]' : redactText(value);
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return redactText(`${value.name}: ${value.message}`);
  if (depth > MAX_REDACT_DEPTH) return '[truncated]';
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redactEvent(item, key, depth + 1, ancestors));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>)) {
      let v: unknown;
      try { v = (value as Record<string, unknown>)[k]; } catch { out[k] = '[unreadable]'; continue; }
      out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined && typeof v !== 'boolean'
        ? '[redacted]'
        : redactEvent(v, k, depth + 1, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/** Append-only file with size rotation (`file` -> `file.1` ... `file.N`). */
class RotatingFile {
  private fd: number | null = null;
  private size = 0;
  private nextRotateAttemptAt = 0;
  constructor(private readonly file: string) {}
  write(line: string): void {
    if (this.fd === null) this.open();
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > MAX_LOG_BYTES && Date.now() >= this.nextRotateAttemptAt) this.rotate();
    fs.writeSync(this.fd!, line);
    this.size += bytes;
  }
  close(): void {
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* best effort */ } }
    this.fd = null;
  }
  private open(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.fd = fs.openSync(this.file, 'a');
    try { this.size = fs.fstatSync(this.fd).size; } catch { this.size = 0; }
  }
  private rotate(): void {
    this.close();
    try {
      for (let i = LOG_BACKUPS - 1; i >= 1; i--) {
        if (fs.existsSync(`${this.file}.${i}`)) renameWithRetry(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      }
      renameWithRetry(this.file, `${this.file}.1`);
      this.nextRotateAttemptAt = 0;
    } catch {
      // A sync client holding the file must not stop logging; try again later.
      this.nextRotateAttemptAt = Date.now() + 60_000;
    }
    this.open();
  }
}

let logDir: string | null = null;
let humanFile: RotatingFile | null = null;
let jsonFile: RotatingFile | null = null;
let sink: ((event: LogEvent) => void) | null = null;

/** Point the on-disk logs at `dir`. Closes any open files. */
export function configureLogDir(dir: string): void {
  closeLogs();
  logDir = path.resolve(dir);
}

/** Divert events to a callback instead of disk and console (tests). */
export function setLogSink(fn: ((event: LogEvent) => void) | null): void {
  sink = fn;
}

export function closeLogs(): void {
  humanFile?.close();
  jsonFile?.close();
  humanFile = null;
  jsonFile = null;
}

function formatHuman(event: LogEvent): string {
  const { timestamp, event: name, ...rest } = event;
  const parts = [`${timestamp} ${name}`];
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined && value !== null) parts.push(`${key}=${JSON.stringify(value)}`);
  }
  return parts.join(' ');
}

export function log(event: string, data: Record<string, unknown> = {}): void {
  const entry: LogEvent = { timestamp: new Date().toISOString(), event };
  for (const k of Object.keys(data)) {
    if (k === 'timestamp' || k === 'event' || k === '__proto__') continue;
    try { entry[k] = data[k]; } catch { entry[k] = '[unreadable]'; }
  }
  if (sink) {
    sink(redactEvent(entry) as LogEvent);
    return;
  }
  let safe: LogEvent;
  try {
    safe = redactEvent({ ...entry, pid: process.pid, run: RUN_ID }) as LogEvent;
  } catch {
    safe = { timestamp: entry.timestamp, event, pid: process.pid, run: RUN_ID, redaction_failed: true };
  }
  let line = `${safe.timestamp} ${event} serialization=failed`;
  let json = JSON.stringify({ timestamp: safe.timestamp, event, serialization_failed: true });
  try {
    line = formatHuman(safe);
    json = JSON.stringify(safe);
  } catch { /* keep the fallbacks */ }
  try {
    if (logDir) {
      humanFile ??= new RotatingFile(path.join(logDir, 'chat_relay.log'));
      jsonFile ??= new RotatingFile(path.join(logDir, 'events.jsonl'));
      humanFile.write(line + '\n');
      jsonFile.write(json + '\n');
    }
  } catch { /* a full or locked disk must never take the listener down */ }
  try { console.log(line); } catch { /* a closed stdout pipe must not either */ }
}

/** Log an error, keeping Steam's `eresult` (it decides auth vs transient). */
export function logError(event: string, error: unknown, extra: Record<string, unknown> = {}): void {
  let eresult: unknown;
  if (error && typeof error === 'object') {
    try { eresult = (error as Record<string, unknown>)['eresult']; } catch { /* unreadable */ }
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  log(event, { ...extra, error: message, ...(eresult !== undefined ? { eresult } : {}) });
}
