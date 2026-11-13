import type { InboundDm } from '../chat-listener.js';
import { formatDiscordNotice, formatDiscordPayloads, type OpsNotice } from '../format.js';
import { postJson, realSleep, withRetry, type FetchLike, type SendOutcome, type Sleep } from '../http.js';
import type { Sink } from '../relay.js';

export interface DiscordSinkOptions {
  webhookUrl: string;
  mentionUserId: string | null;
  username: string;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
}

/**
 * Discord incoming webhook. Each chunk of a long DM is its own POST, sent in
 * order; the DM counts as delivered only if every chunk was.
 */
export class DiscordSink implements Sink {
  readonly name = 'discord';
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;

  constructor(private readonly opts: DiscordSinkOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? realSleep;
  }

  async send(dm: InboundDm): Promise<SendOutcome> {
    const payloads = formatDiscordPayloads(dm, { mentionUserId: this.opts.mentionUserId, username: this.opts.username });
    let attempts = 0;
    for (const [i, payload] of payloads.entries()) {
      const outcome = await this.post(payload);
      attempts += outcome.attempts;
      if (!outcome.ok) return { ...outcome, attempts, error: `${outcome.error ?? 'failed'} (part ${i + 1}/${payloads.length})` };
    }
    return { ok: true, attempts };
  }

  async notice(notice: OpsNotice): Promise<SendOutcome> {
    return this.post(formatDiscordNotice(notice, { mentionUserId: this.opts.mentionUserId, username: this.opts.username }));
  }

  private post(payload: unknown): Promise<SendOutcome> {
    return withRetry(() => postJson(this.fetchImpl, this.opts.webhookUrl, payload),
      (r) => r.status >= 200 && r.status < 300, this.sleep);
  }
}
