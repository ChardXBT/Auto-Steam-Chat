import type { InboundDm } from '../chat-listener.js';
import { formatTelegramMessages, formatTelegramNotice, type OpsNotice } from '../format.js';
import { postJson, realSleep, withRetry, type FetchLike, type SendOutcome, type Sleep } from '../http.js';
import type { Sink } from '../relay.js';

export interface TelegramSinkOptions {
  botToken: string;
  chatId: string;
  timeZone: string;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
}

/**
 * Telegram Bot API sendMessage, the same endpoint and env names as
 * cs-notifier. Plain text (no parse_mode), so the DM arrives exactly as sent.
 * Success needs HTTP 2xx and `"ok": true`.
 */
export class TelegramSink implements Sink {
  readonly name = 'telegram';
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;

  constructor(private readonly opts: TelegramSinkOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? realSleep;
  }

  async send(dm: InboundDm): Promise<SendOutcome> {
    const messages = formatTelegramMessages(dm, this.opts.timeZone);
    let attempts = 0;
    for (const [i, text] of messages.entries()) {
      const outcome = await this.sendText(text);
      attempts += outcome.attempts;
      if (!outcome.ok) return { ...outcome, attempts, error: `${outcome.error ?? 'failed'} (part ${i + 1}/${messages.length})` };
    }
    return { ok: true, attempts };
  }

  notice(notice: OpsNotice): Promise<SendOutcome> {
    return this.sendText(formatTelegramNotice(notice));
  }

  private sendText(text: string): Promise<SendOutcome> {
    const url = `https://api.telegram.org/bot${this.opts.botToken}/sendMessage`;
    return withRetry(
      () => postJson(this.fetchImpl, url, { chat_id: this.opts.chatId, text, disable_web_page_preview: true }),
      (r) => r.status >= 200 && r.status < 300 && (r.json as { ok?: unknown } | null)?.ok === true,
      this.sleep,
    );
  }
}
