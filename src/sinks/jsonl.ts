import type { InboundDm } from '../chat-listener.js';
import type { SendOutcome } from '../http.js';
import { appendLineDurable } from '../state.js';

/**
 * The durable local DM record, `runtime/messages.jsonl`. Written (and
 * fsynced) before any network sink is tried, so a DM is never only in
 * memory. It holds verbatim text and SteamID64s and is therefore NOT
 * redacted; it lives only under gitignored runtime/ (docs/SPEC.md, privacy).
 */
export class MessageRecorder {
  constructor(private readonly file: string) {}

  recordDm(dm: InboundDm, recordedAt = new Date()): void {
    appendLineDurable(this.file, JSON.stringify({
      type: 'dm',
      recorded_at: recordedAt.toISOString(),
      msg_id: dm.msgId,
      account: dm.account,
      account_label: dm.accountLabel,
      sender_steam_id: dm.senderSteamId,
      sender_name: dm.senderName,
      server_timestamp: dm.serverTimestamp.toISOString(),
      timestamp_source: dm.timestampSource,
      ordinal: dm.ordinal,
      from_limited_account: dm.fromLimitedAccount,
      source: dm.source,
      text: dm.text,
    }));
  }

  recordResult(dm: InboundDm, results: Record<string, SendOutcome>, recordedAt = new Date()): void {
    appendLineDurable(this.file, JSON.stringify({
      type: 'relay_result',
      recorded_at: recordedAt.toISOString(),
      msg_id: dm.msgId,
      account: dm.account,
      results,
    }));
  }
}
