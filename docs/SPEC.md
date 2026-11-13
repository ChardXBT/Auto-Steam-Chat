# Auto-Steam-Chat: specification (v1)

Research behind every decision: [`RESEARCH.md`](RESEARCH.md). Judgment calls
the brief did not specify are marked **(my call)**.

## Intent

S | Skins and Rukia | Skins are marketplace bot accounts (CSFloat,
Skins.com, CS.MONEY, BUFF163). Buyers and sellers DM them on Steam about
trades and the owner never sees those messages, because nobody reads the
bots' Steam chat. This service watches inbound DMs on both accounts and
relays each one, verbatim, to the owner's Discord channel (with a ping) and
Telegram chat.

## Goals

1. Every inbound DM on either account produces a relay to Discord and
   Telegram: verbatim text, sender display name, SteamID64, profile link,
   receiving account, Steam server timestamp.
2. A delivery failure never crashes or stalls the Steam listener.
3. No message is relayed twice, across reconnects and restarts.
4. DMs that arrive while the service is down or reconnecting are relayed
   when it comes back (bounded window).
5. Coexists with Steam-Trade-Acceptor's sessions on the same accounts
   without kicking either side.
6. Runs unattended under the fleet supervisor with the fleet's ops contract.

## Non-goals (v1)

- Replying, auto-responders, canned replies (a `sendSteamDm()` seam exists,
  disabled).
- Trade automation of any kind.
- Storing passwords. Storing shared secrets **(my call)**: refresh-token logon
  never needs one, so a pasted secret is used for that one sign-in only.
- Scraping web pages.
- AI, fuzzy logic, classification or summarising of messages.
- Group-chat or chat-room messages, friend requests (v2 list).
- Marking messages read on Steam (`ackFriendMessage` is never called)
  **(my call)**: the phone app keeps its unread badges.

## Architecture

One Node process **(my call)**, two `SteamUser` instances (one per account),
one shared relay. The acceptor needed one process per account because its
Steam wiring lives in module globals; here each account is an
`AccountRunner` object, so a single process is simpler, needs one lock, and
gives one delivery path.

```
             ┌──────────── AccountRunner(main) ─────────────┐
 Steam CM ──▶│ SteamUser(logonID 0x41534301) → chat-listener │──┐
             └───────────────────────────────────────────────┘  │  InboundDm
             ┌──────────── AccountRunner(rukia) ────────────┐   ├──────────▶ Relay (one serial queue)
 Steam CM ──▶│ SteamUser(logonID 0x41534302) → chat-listener │──┘              │
             └───────────────────────────────────────────────┘                 │ 1. dedupe check
                                                                               │ 2. jsonl sink (durable, sync)
                                                                               │ 3. wait while PAUSE
                                                                               │ 4. Discord ┐ parallel, each
                                                                               │    Telegram┘ isolated + timed out
                                                                               │ 5. mark relayed (atomic)
```

The Steam event handler only normalises and enqueues; it never awaits a
network sink. The relay queue is serial **(my call)** so Discord and Telegram
show a conversation in order.

## Modules

| File | Responsibility |
|---|---|
| `src/index.ts` | CLI (`start`, `signin`, `help`, `--account main\|rukia\|both`), lock, STOP/PAUSE wiring, signals, health beat, clean shutdown |
| `src/config.ts` | Load + validate `config.json` (optional; defaults built in) and secrets from env |
| `src/accounts.ts` | Account ids, labels, SteamID64s, per-account paths |
| `src/auth.ts` | Interactive signin, refresh-token load/save (atomic), Steam Guard parsing, logon-error classification, reconnect ladder |
| `src/account-runner.ts` | One `SteamUser` per account: logon, persona, chat wiring, backfill, reconnect |
| `src/chat-listener.ts` | steam-user payloads → normalised `InboundDm`; backfill from history |
| `src/relay.ts` | Serial fan-out: dedupe → jsonl → pause gate → sinks → mark |
| `src/dedupe.ts` | Persisted per-account relay markers + watermark |
| `src/state.ts` | Atomic JSON write (`tmp` + `fsync` + `renameWithRetry`) and safe read |
| `src/atomic-rename.ts` | Rename retried on EPERM/EBUSY/EACCES (copied from the acceptor) |
| `src/lock.ts` | Single-instance PID lock with stale takeover |
| `src/pause.ts` | `runtime/PAUSE` and `runtime/STOP_REQUESTED` |
| `src/logger.ts` | Human log + `events.jsonl`, rotation, redaction |
| `src/format.ts` | Pure Discord/Telegram formatting and splitting |
| `src/http.ts` | `fetch` with timeout, body always consumed, bounded retry on 429/5xx |
| `src/sinks/discord.ts` | Webhook embed + `<@id>` mention; ops notices |
| `src/sinks/telegram.ts` | `sendMessage`, split to 4000 chars |
| `src/sinks/jsonl.ts` | Durable local DM record (`runtime/messages.jsonl`) |
| `src/reply.ts` | **Stub**: `SteamDmSender` interface, disabled implementation |

## Config

### Secrets: environment only (`.env`, never committed)

| Variable | Required | Validation | If missing |
|---|---|---|---|
| `DISCORD_WEBHOOK_URL` | for Discord | `https://discord.com/api/webhooks/<id>/<token>` (also `discordapp.com`, `ptb.`/`canary.`) | Discord sink disabled, `SINK_DISABLED` logged once |
| `DISCORD_MENTION_USER_ID` | for the ping | 17-20 digit snowflake | DMs still relayed, without the ping; logged once |
| `TELEGRAM_BOT_TOKEN` | for Telegram | `<digits>:<35+ chars>` | Telegram sink disabled |
| `TELEGRAM_CHAT_ID` | for Telegram | integer, may be negative | Telegram sink disabled |

A malformed value disables that sink and logs `SINK_CONFIG_INVALID` with the
variable *name* only **(my call)**: it must not crash the listener, and the
DM is still in `messages.jsonl`. `config.json` is rejected if it contains a
`url`, `token` or `webhook` key, so secrets cannot drift into it.

Test/ops overrides (like the acceptor's `TRADE_ACCEPTOR_*`):
`AUTO_STEAM_CHAT_RUNTIME_DIR`, `AUTO_STEAM_CHAT_CONFIG_PATH`,
`AUTO_STEAM_CHAT_ENV_PATH`.

### `config.json` (optional; `config.example.json` is the default)

```json
{
  "accounts": {
    "main":  { "enabled": true, "label": "S | Skins",     "steam_id": "76561199798489148", "logon_id": 1095975681 },
    "rukia": { "enabled": true, "label": "Rukia | Skins", "steam_id": "76561199825952724", "logon_id": 1095975682 }
  },
  "persona_state": "online",
  "backfill": { "enabled": true, "max_hours": 72 },
  "discord": { "enabled": true, "username": "Auto-Steam-Chat", "notify_startup": true, "notify_shutdown": true },
  "telegram": { "enabled": true },
  "display_time_zone": "America/Toronto",
  "reconnect_backoff_ms": [5000, 15000, 30000, 60000, 300000, 600000]
}
```

Validation (all errors at startup, process exits 1 with `CONFIG_INVALID`):

- `steam_id` matches `^7656119\d{10}$`.
- `logon_id` integer in `1..0xFFFFFFFF`, not `0` (the acceptor's value),
  not `0x5a17b0` (the autobuyer helper's), unique across accounts. The
  signin logonID is `logon_id + 0x100` and must also be unique.
- `label` non-empty, ≤ 64 chars. Defaults are the exact labels.
- `persona_state` one of `online`, `invisible`, `away`, `busy`,
  `looking_to_trade`. Default `online` until `invisible` is verified live.
- `backfill.max_hours` 0..336.
- `reconnect_backoff_ms` non-empty, every entry 1000..3,600,000.
- `display_time_zone` accepted by `Intl.DateTimeFormat`.

## Flow: DM → Discord / Telegram

### Normalised message

```ts
interface InboundDm {
  account: 'main' | 'rukia';
  accountLabel: string;           // "S | Skins"
  accountSteamId: string;
  senderSteamId: string;          // SteamID64
  senderName: string | null;      // persona name if known
  text: string;                   // verbatim
  serverTimestamp: Date;          // Steam server time, whole seconds
  ordinal: number;
  fromLimitedAccount: boolean;
  source: 'live' | 'backfill';
  key: string;                    // `${senderSteamId}:${unixSeconds}:${ordinal}`
  msgId: string;                  // sha256(account + key) first 16 hex, for logs
}
```

- Live text = `message_no_bbcode` (what the sender typed). Backfill text =
  history `message` fetched with `wantBbcode: false`. Equality is VERIFY
  LIVE.
- Sender name: `client.users[id].player_name` if the persona is cached
  (we are Online, so friends' personas arrive), else `getPersonas([id])`
  with a 5 s cap, else `null` → shown as `(unknown name)`. A name lookup
  failure never blocks or drops the relay.
- Messages from the account itself (history includes both directions) and
  `friendMessageEcho` are never relayed.

### Discord

One webhook POST per chunk. `allowed_mentions` permits only the owner, so
`@everyone` or `<@id>` inside a DM can never ping anyone.

```json
{
  "username": "Auto-Steam-Chat",
  "content": "<@OWNER_ID> Steam DM to **S | Skins**",
  "allowed_mentions": { "parse": [], "users": ["OWNER_ID"] },
  "embeds": [{
    "title": "Steam DM → S | Skins",
    "description": "<escaped verbatim text>",
    "color": 1779768,
    "fields": [
      { "name": "From", "value": "<escaped display name>", "inline": true },
      { "name": "SteamID64", "value": "76561198000000000", "inline": true },
      { "name": "Account", "value": "S | Skins (main)", "inline": true },
      { "name": "Profile", "value": "https://steamcommunity.com/profiles/76561198000000000", "inline": false },
      { "name": "Sent", "value": "<t:UNIX_SECONDS:F> · 2026-11-13T00:59:00.000Z", "inline": false }
    ],
    "footer": { "text": "Auto-Steam-Chat · part 1/1 · 3f9c0a1b2c3d4e5f" },
    "timestamp": "2026-11-13T00:59:00.000Z"
  }]
}
```

- If the sender is a limited account a `Limited account: yes` field is
  added (cheap scam signal) **(my call)**.
- Backfilled messages get `(delivered late)` in the title **(my call)**.
- **Escaping (my call):** Discord renders Markdown in embed descriptions,
  including masked links `[text](url)`. A scammer could send
  `[steamcommunity.com/tradeoffer/new](https://evil)` and it would render as a
  trusted-looking link. So the characters `\ * _ ~ ` | > [ ] ( ) # < @ :` are
  backslash-escaped. Rendered text equals the original; raw links stay
  readable. Whether escaped `_`/`:` inside bare URLs still auto-link is VERIFY
  LIVE (if not, links are still readable, just not clickable).
- **Splitting:** the escaped body is split into chunks of ≤ 4000 chars
  (embed description limit is 4096; margin kept) on code-point boundaries,
  never inside an escape pair or a surrogate pair, preferring a newline or
  space in the last 200 chars. Only the first chunk carries the mention;
  each chunk's footer says `part i/n`.

### Telegram

Plain text, **no `parse_mode`** **(my call)**: the text arrives exactly as
sent with no escaping layer to get wrong. cs-notifier uses HTML mode; here
verbatim matters more than bold headers.

```
📨 Steam DM → S | Skins (main)
From: <display name>
SteamID64: 76561198000000000
Profile: https://steamcommunity.com/profiles/76561198000000000
Sent: Nov 12, 2026, 7:59 p.m. EST (2026-11-13T00:59:00.000Z)

<verbatim text>
```

`POST https://api.telegram.org/bot<TOKEN>/sendMessage` with `chat_id`,
`text`, `disable_web_page_preview: true`. Each message ≤ 4000 chars. The
header goes in the first message; continuation messages start with
`(part i/n, S | Skins)` and a newline. Success = HTTP 2xx and `"ok": true`.

### Retry per sink

- Timeout 12 s per request (cs-notifier's value); the response body is
  always read or cancelled.
- HTTP 429: wait `retry_after` (Discord: JSON seconds or `Retry-After`
  header; Telegram: `parameters.retry_after`), capped at 30 s.
- HTTP 5xx or network error: wait 2 s, then 5 s.
- Max 3 attempts per chunk. Other 4xx: no retry (configuration error).
- Worst case per message ≈ 3 × 12 s + 35 s per sink, sinks in parallel, so
  the queue cannot stall indefinitely.

## Dedupe model

- Store per account: `runtime/accounts/<account>/state/relayed.json`

  ```json
  { "version": 1, "watermark": 1731456000,
    "markers": { "76561198000000000:1731456000:0": { "state": "relayed", "at": "2026-11-12T..." } } }
  ```
- `state` is `recorded` (written to `messages.jsonl`, sinks not yet done,
  e.g. paused) or `relayed` (sinks attempted).
- A message whose marker is `relayed` is skipped. One that is `recorded`
  skips the jsonl write and goes to the sinks.
- **Marked `relayed` after the sinks were attempted, whatever the outcome
  (my call).** A Discord outage must not make Telegram receive duplicates on
  the next restart. The failure is visible in `messages.jsonl`
  (`relay_result` line) and `events.jsonl` (`SINK_FAILED`). A durable retry
  outbox is on the v2 list.
- Crash between "sinks sent" and "marker saved" → the next backfill relays
  the message again (at-least-once). Accepted: a duplicate ping is better
  than a lost one.
- Every write is atomic (tmp + `fsync` + rename with the EPERM/EBUSY/EACCES
  retry). A corrupt file is moved aside to `relayed.json.corrupt-<ts>`,
  logged `DEDUPE_STATE_CORRUPT`, and replaced by an empty store **(my call)**;
  the watermark is lost, so the next logon backfills `max_hours`, and old
  messages in that window would be relayed again. Logged loudly.
- In-memory "in flight" set prevents the live event and the backfill from
  relaying the same message concurrently.
- Eviction: markers whose message time is older than
  `max(backfill.max_hours, 24h) + 7 days` are dropped on load; backfill can
  never reach that far back, so they can never be needed.
- **Watermark:** the newest `server_timestamp` seen on that account (live or
  backfill). First run ever (no store): watermark = now, no backfill
  **(my call)**, so the first start does not flood Discord with months of
  history.

### Backfill (every successful logon)

1. `since = max(watermark − 120 s, now − backfill.max_hours)`.
2. `chat.getActiveFriendMessageSessions({conversationsSince: since})`.
3. For each session with `time_last_message ≥ since`:
   `chat.getFriendMessageHistory(friend, {startTime: since, maxCount: 100,
   wantBbcode: false})`. Keep messages whose sender is not us. If
   `more_available`, log `BACKFILL_TRUNCATED` (v1 does not page).
4. Sort all by `(server_timestamp, ordinal)` and enqueue with
   `source: 'backfill'`. The dedupe store removes anything already relayed.
5. Any backfill error is logged `BACKFILL_FAILED` and the runner stays
   online; live events keep flowing.

## Failure modes

| Failure | Detection | Behaviour |
|---|---|---|
| CM disconnect / network loss | `error` (autoRelogin off → every logoff is `error`) | Log `STEAM_DISCONNECTED`, schedule relogin on the ladder with a fresh `SteamUser`; backfill on logon recovers the gap |
| Logon hangs | 60 s timer | Treated as transient, ladder |
| No refresh token | file missing | `INTERACTIVE_AUTH_REQUIRED`, alert once per transition (Discord with mention + Telegram), retry on the ladder; the token file is re-read each attempt so `npm run signin` heals it without a restart |
| Token dead (`InvalidPassword`, `AccessDenied`, `Revoked`, `Expired`, `InvalidSignature`) | `error.eresult` | Same as above |
| Throttled (`RateLimitExceeded 84`, `AccountLoginDeniedThrottle 87`) | `error.eresult` | Jump to the 5-minute rung **(my call)** |
| Kicked: `LogonSessionReplaced 34` | `error.eresult` | Someone used *our* logonID from this IP (a second copy of this service). Alert `LOGON_SESSION_REPLACED`, jump to the 5-minute rung to avoid a kick ping-pong **(my call)** |
| Kicking the acceptor | n/a | Prevented by distinct logonIDs; VERIFY LIVE |
| Wrong account signed in | `client.steamID` ≠ config `steam_id` | Log `ACCOUNT_MISMATCH`, log off, treat as auth-required; never save that token |
| Discord 429 / 5xx / down | HTTP status | Retry policy above, then `SINK_FAILED`; other sinks unaffected |
| Discord 4xx (bad webhook) | HTTP 400/401/404 | No retry, `SINK_FAILED status=…`; message still in `messages.jsonl` and Telegram |
| Telegram down / `ok: false` | HTTP status, JSON | Same as Discord |
| Disk full / file locked | write throws | Logger swallows its own errors; dedupe save failure is logged `DEDUPE_SAVE_FAILED` and the relay continues (worst case a duplicate after restart) |
| Laptop sleep | socket dies on resume → `error` | Ladder reconnects, backfill relays what arrived during sleep, marked "delivered late". Timing VERIFY LIVE |
| Relay queue overflow | > 1000 queued | New items still go to `messages.jsonl`, dropped from the network queue with `RELAY_QUEUE_FULL`; backfill after restart catches them up |
| Unexpected exception in a handler | try/catch at every event boundary | Logged; the runner keeps going. `uncaughtException` / `unhandledRejection` log and exit 1 so the supervisor restarts (fleet convention) |

## Privacy decision point

DM bodies go to Discord and Telegram by design. Locally **(my call)**:

| Destination | Body? | Why |
|---|---|---|
| Discord, Telegram | Yes, verbatim | The purpose of the service |
| `runtime/messages.jsonl` | **Yes**, verbatim, unredacted | The durable record if both network sinks fail. Local only, under gitignored `runtime/`, owner's own laptop. Not rotated (DM volume is low). Contains SteamID64s and text |
| `runtime/logs/events.jsonl`, `runtime/logs/chat_relay.log`, console | **No** | Ops logs get pasted into issues and chats. They carry `msgId`, account, `length`, `source`, sink outcomes. Redaction (including SteamID64 masking) runs on them; it would corrupt a verbatim body anyway |

To find the text of an ops event, look up its `msgId` in `messages.jsonl`.

## Ops

- `npm run build`, `npm start` (both accounts), `npm start -- --account
  rukia`, `npm run signin [-- --account main|rukia|both]`.
- Lock: `runtime/auto-steam-chat.lock` (PID, stale takeover).
- `runtime/STOP_REQUESTED`: checked at startup and watched every second;
  clean shutdown (drain the in-flight relay up to 15 s, SHUTDOWN notice, log
  off both, release lock, exit 0).
- `runtime/PAUSE` **(my call on semantics)**: the Steam listener keeps
  running and every DM is still written to `messages.jsonl` and marked
  `recorded`; network delivery waits until PAUSE is removed, then the queue
  drains in order.
- Discord STARTUP (accounts, build, persona) and SHUTDOWN notices without a
  mention. `INTERACTIVE_AUTH_REQUIRED` and `LOGON_SESSION_REPLACED` alerts
  **with** the mention, also sent to Telegram **(my call)**.
- Logs: `runtime/logs/chat_relay.log` (human), `runtime/logs/events.jsonl`,
  20 MB × 3 rotation. `HEALTH_BEAT` every 60 s: per-account state, queue
  depth, per-sink sent/failed counters.
- Signin uses logonID `logon_id + 0x100`, so it can run while the service
  is up without kicking it. A successful signin is picked up by the running
  service on its next ladder attempt.

## Security

- Secrets only in env; never logged (key-name and value-shape redaction:
  Bearer, JWT, Discord webhook URL, Telegram bot token, Steam cookies,
  SteamID64), never in `config.json` (rejected).
- Refresh token file written with mode `0600` (no effect on Windows ACLs;
  it lives in the user profile).
- Password read with echo suppressed, kept in memory for one logon, never
  written.
- CI secret scan: tracked-file list must not include `.env`, `config.json`,
  `runtime/`, `refresh_token`; `git grep` must not find a Discord webhook URL
  with a token, a Telegram bot token, a JWT, or a `steamLoginSecure` value.
- Discord `allowed_mentions` restricted to the owner; DM text is escaped.

## v2 list

1. Two-way reply: `/reply <msgId> text` from Discord (bot, not webhook) or
   Telegram → `sendSteamDm()` → `client.chat.sendFriendMessage()`.
2. Canned auto-reply ("I'm a bot, contact …") with per-sender cooldown.
3. Per-sender filters: mute list, marketplace-bot allowlist, keyword
   highlights.
4. Per-sender Discord threads (needs a bot token or a forum channel webhook
   with `thread_name`) and Telegram topics.
5. Durable retry outbox for failed sink deliveries.
6. Relay pending friend requests (`friendRelationship` RequestRecipient), so
   a buyer who cannot DM because they are not a friend is still seen.
7. Group-chat mentions (`chat.on('chatMessage')`).
8. Backfill paging when `more_available`.
9. `npm run status` like the acceptor's (build fingerprint, last event).
