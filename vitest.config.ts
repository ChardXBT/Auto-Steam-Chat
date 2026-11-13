import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Every path the app touches is redirected under a per-run temp root, so the
 * suite can never read or write the real runtime/ tree, .env or config.json.
 */
const TEST_TMP = path.join(os.tmpdir(), `auto-steam-chat-test-${process.pid}`);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    env: {
      AUTO_STEAM_CHAT_RUNTIME_DIR: path.join(TEST_TMP, 'runtime'),
      AUTO_STEAM_CHAT_CONFIG_PATH: path.join(TEST_TMP, 'config.json'),
      AUTO_STEAM_CHAT_ENV_PATH: path.join(TEST_TMP, 'dotenv'),
    },
  },
});
