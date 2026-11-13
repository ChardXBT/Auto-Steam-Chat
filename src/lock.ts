import fs from 'node:fs';
import path from 'node:path';

/**
 * Single-instance PID lock, from Steam-Trade-Acceptor `src/lock.ts`. Two
 * copies of this service would share logonIDs and kick each other off Steam
 * (LogonSessionReplaced), and both would relay every DM. A lock left by a
 * dead process is taken over, so a crash never wedges a restart.
 */

export interface LockResult {
  acquired: boolean;
  heldByPid?: number;
  tookOverFromPid?: number;
}

/** Signal 0 checks existence without delivering anything; EPERM still means alive. */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(file: string): number | null {
  try {
    const parsed = Number(fs.readFileSync(file, 'utf-8').trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function acquireLock(file: string): LockResult {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = readPid(file);
  if (existing !== null && existing !== process.pid && isAlive(existing)) {
    return { acquired: false, heldByPid: existing };
  }
  fs.writeFileSync(file, String(process.pid), 'utf-8');
  const tookOver = existing !== null && existing !== process.pid ? existing : undefined;
  return { acquired: true, ...(tookOver !== undefined ? { tookOverFromPid: tookOver } : {}) };
}

/** Release only if we still own it. */
export function releaseLock(file: string): void {
  try {
    if (readPid(file) === process.pid) fs.unlinkSync(file);
  } catch {
    // A lock we failed to remove is reclaimed as stale on the next start.
  }
}
