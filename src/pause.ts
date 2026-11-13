import fs from 'node:fs';

/**
 * Fleet control files. `runtime/PAUSE` holds network delivery (DMs are still
 * recorded locally); `runtime/STOP_REQUESTED` asks for a clean shutdown.
 */
export class ControlFiles {
  constructor(private readonly pauseFile: string, private readonly stopFile: string) {}

  isPaused(): boolean {
    return fs.existsSync(this.pauseFile);
  }

  stopRequested(): boolean {
    return fs.existsSync(this.stopFile);
  }

  /**
   * Calls `onStop` once when the stop file appears. `fs.watchFile` polls, so
   * it also works when the file already exists or the directory is created
   * later. Returns an unwatch function.
   */
  watchStop(onStop: () => void, intervalMs = 1000): () => void {
    let fired = false;
    const check = (): void => {
      if (!fired && this.stopRequested()) {
        fired = true;
        onStop();
      }
    };
    fs.watchFile(this.stopFile, { interval: intervalMs }, check);
    check();
    return () => fs.unwatchFile(this.stopFile, check);
  }
}
