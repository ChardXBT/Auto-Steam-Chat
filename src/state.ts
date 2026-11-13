import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry } from './atomic-rename.js';

/**
 * Replace `file` with `contents` so a crash or power loss leaves either the
 * old file or the new one, never a torn mix: temp file, fsync, rename (with
 * the Windows lock retry). No directory fsync: win32 has none, matching the
 * acceptor's state writer.
 */
export function writeFileAtomic(file: string, contents: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'w', mode);
    try {
      fs.writeSync(fd, contents);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(temporary, file);
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch { /* preserve the original error */ }
    throw err;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}

export type JsonReadResult =
  | { status: 'ok'; value: unknown }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string };

export function readJson(file: string): JsonReadResult {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return { status: 'corrupt', error: (err as Error).message };
  }
  try {
    return { status: 'ok', value: JSON.parse(text) as unknown };
  } catch (err) {
    return { status: 'corrupt', error: (err as Error).message };
  }
}

/**
 * Move an unreadable state file aside instead of deleting it, so nothing is
 * lost if it turns out to be recoverable by hand.
 */
export function quarantine(file: string, nowMs = Date.now()): string | null {
  const target = `${file}.corrupt-${nowMs}`;
  try {
    renameWithRetry(file, target);
    return target;
  } catch {
    return null;
  }
}

/** Append one line and fsync it: used for the durable DM record. */
export function appendLineDurable(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, line.endsWith('\n') ? line : `${line}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
