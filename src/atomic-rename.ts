import fs from 'node:fs';

/**
 * Copied from Steam-Trade-Acceptor `src/atomic-rename.ts`.
 *
 * Windows reports a rename over a file another process has open as EPERM,
 * EBUSY or EACCES. OneDrive and antivirus scanners briefly hold freshly
 * written files that way. Those codes are retried a few times (50-200 ms
 * apart, under half a second in total); anything else is thrown at once.
 */
export const RENAME_RETRY_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
export const RENAME_ATTEMPTS = 5;
const RENAME_DELAYS_MS = [50, 100, 150, 200];

let pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
let rename = (from: string, to: string): void => fs.renameSync(from, to);

/** Test seam: replace the rename and the pause. Returns a restore function. */
export function setRenameHooks(hooks: { rename?: (from: string, to: string) => void; pause?: (ms: number) => void }): () => void {
  const previous = { rename, pause };
  if (hooks.rename) rename = hooks.rename;
  if (hooks.pause) pause = hooks.pause;
  return () => { rename = previous.rename; pause = previous.pause; };
}

/** `fs.renameSync`, retried briefly while another process holds either file. */
export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (attempt >= RENAME_ATTEMPTS || typeof code !== 'string' || !RENAME_RETRY_CODES.has(code)) throw err;
      pause(RENAME_DELAYS_MS[attempt - 1] ?? 200);
    }
  }
}
