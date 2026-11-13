import type { AccountId } from './accounts.js';

/**
 * STUB ONLY (v1 is inbound-only; docs/SPEC.md non-goals and v2 list).
 *
 * The seam a two-way relay or a canned auto-reply plugs into. A real
 * implementation would hold each account's live SteamUser (AccountRunner
 * owns it) and call `client.chat.sendFriendMessage(recipient, text)`
 * (steam-user chatroom.js:521, resolves {modified_message, server_timestamp,
 * ordinal}). Nothing in v1 calls this.
 */
export interface SteamDmSender {
  sendSteamDm(account: AccountId, recipientSteamId64: string, text: string): Promise<SendDmResult>;
}

export type SendDmResult =
  | { ok: true; serverTimestamp: Date; ordinal: number }
  | { ok: false; reason: 'replies_disabled' | 'account_offline' | 'steam_error'; detail?: string };

/** The v1 sender: refuses every send and never contacts Steam. */
export class DisabledSteamDmSender implements SteamDmSender {
  async sendSteamDm(): Promise<SendDmResult> {
    return { ok: false, reason: 'replies_disabled', detail: 'Auto-Steam-Chat v1 is inbound-only' };
  }
}
