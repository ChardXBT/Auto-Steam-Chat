import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Same per-run root as vitest.config.ts (both run in the main vitest process). */
const TEST_TMP = path.join(os.tmpdir(), `auto-steam-chat-test-${process.pid}`);

export default function setup(): () => void {
  return () => fs.rmSync(TEST_TMP, { recursive: true, force: true });
}
