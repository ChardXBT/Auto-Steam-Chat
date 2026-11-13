import type { OpsNotifier } from './account-runner.js';
import type { OpsNotice } from './format.js';
import { log } from './logger.js';
import type { SendOutcome } from './http.js';

export interface NoticeChannel {
  readonly name: string;
  notice(notice: OpsNotice): Promise<SendOutcome>;
}

/**
 * Fleet ops notices. Informational ones (STARTUP, SHUTDOWN) go to Discord
 * only; ones that need the owner (`mention: true`) also go to Telegram.
 * Sending is fire-and-forget so it can never block a Steam handler; `flush`
 * lets shutdown wait (bounded) for what is in flight.
 */
export class FleetNotifier implements OpsNotifier {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly discord: NoticeChannel | null, private readonly telegram: NoticeChannel | null) {}

  notify(notice: OpsNotice): void {
    const channels = [this.discord, notice.mention ? this.telegram : null].filter((c): c is NoticeChannel => c !== null);
    for (const channel of channels) {
      const p = channel.notice(notice)
        .then((outcome) => {
          if (!outcome.ok) log('NOTICE_FAILED', { channel: channel.name, kind: notice.kind, status: outcome.status, error: outcome.error });
        })
        .catch((err: unknown) => log('NOTICE_FAILED', { channel: channel.name, kind: notice.kind, error: err instanceof Error ? err.name : 'unknown' }))
        .finally(() => { this.pending.delete(p); });
      this.pending.add(p);
    }
  }

  async flush(timeoutMs: number): Promise<void> {
    if (this.pending.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.pending]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
