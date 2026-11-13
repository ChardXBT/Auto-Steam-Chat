# Auto-Steam-Chat

Watches inbound Steam direct messages on **S | Skins** (`main`) and
**Rukia | Skins** (`rukia`) and relays each one, verbatim, to Discord (with a
ping) and Telegram: the text, the sender's name, SteamID64 and profile link,
which account received it, and Steam's timestamp.

Inbound only. It never replies, never acks messages, and never touches
trades. A sibling of [Steam-Trade-Acceptor](../Steam-Trade-Acceptor) with the
same runtime layout and ops contract.

> **Status: skeleton, not production-ready.** Every code path is real, and the
> offline checks pass (build, 72 tests, no-secrets start). Nothing has run
> against live Steam, Discord or Telegram yet. Work through
> [`docs/VERIFY_LIVE.md`](docs/VERIFY_LIVE.md) before relying on it.

Docs: [research](docs/RESEARCH.md) · [spec](docs/SPEC.md) ·
[live verification checklist](docs/VERIFY_LIVE.md)

## Requirements

- Windows laptop (same machine and IP as the acceptor, see
  [research §6](docs/RESEARCH.md#6-where-it-runs))
- Node.js 20.12 or newer
- Each bot account must be friends with whoever DMs it: Steam does not
  allow DMs from non-friends.

## Setup

```powershell
npm ci
npm run build
Copy-Item .env.example .env      # fill in, see below
npm run signin                   # main, then rukia; password + Steam Guard, once
npm start
```

`config.json` is optional. Without it the built-in defaults apply (the same
values as `config.example.json`). Copy and edit that file only to change
something.

### Environment (`.env`, never committed)

| Variable | Purpose |
|---|---|
| `DISCORD_WEBHOOK_URL` | Incoming webhook of the relay channel |
| `DISCORD_MENTION_USER_ID` | Your Discord user ID, mentioned so it pings |
| `TELEGRAM_BOT_TOKEN` | Same bot as cs-notifier |
| `TELEGRAM_CHAT_ID` | Same chat as cs-notifier |

None is required to start. A missing or malformed value disables only that
sink (logged as `SINK_CONFIG` with the variable name, never the value), and
every DM is still written to `runtime/messages.jsonl`.

## Commands

```powershell
npm start                              # both accounts
npm start -- --account rukia           # one account (main | rukia | alt | both)
npm run signin -- --account main       # sign in again (e.g. after INTERACTIVE_AUTH_REQUIRED)
npm test; npm run typecheck
```

## Sign-in and sessions

- `npm run signin` asks for the account name, the password (hidden) and a
  Steam Guard code. A maFile `shared_secret` pasted at the code prompt is
  recognised by its format and used for that sign-in only. Only the refresh
  token is saved, to `runtime/accounts/<account>/refresh_token`. The password
  is never stored.
- `npm start` uses only the refresh token. If it is missing, rejected or for
  the wrong account, the account logs `INTERACTIVE_AUTH_REQUIRED`, sends one
  Discord ping and Telegram alert, and keeps retrying on the ladder
  (5 s, 15 s, 30 s, 60 s, 5 min, 10 min, then every 10 min). It never prompts.
  Running `npm run signin` fixes it without restarting the service.
- **logonIDs.** Steam replaces a session when a second one logs on to the same
  account from the same IP with the same logonID. The acceptor uses 0, so this
  service uses `0x41534301` (main) and `0x41534302` (rukia), and sign-in adds
  `0x100`. `config.json` refuses `0` and the autobuyer helper's `0x5a17b0`.
- Each account is set to **Online** after logon. Steam delivers chat events
  only to online sessions. Buyers will see the bots as online.

## Ops

| | |
|---|---|
| Stop | create `runtime/STOP_REQUESTED`: clean shutdown, exit 0 |
| Pause | create `runtime/PAUSE`: DMs are still received and recorded locally; Discord/Telegram delivery waits until the file is removed |
| Lock | `runtime/auto-steam-chat.lock`: a second instance exits 1 |
| Logs | `runtime/logs/chat_relay.log` (human), `runtime/logs/events.jsonl` (JSONL), 20 MB × 3 rotation, `HEALTH_BEAT` every minute |
| DM record | `runtime/messages.jsonl`: verbatim text + sender, one line per DM and one per delivery result |
| Dedupe | `runtime/accounts/<account>/state/relayed.json` |
| Notices | Discord `STARTUP` / `SHUTDOWN` (no ping). `INTERACTIVE_AUTH_REQUIRED` and `LOGON_SESSION_REPLACED` ping on Discord and also go to Telegram |

Exit codes: `0` clean stop, `1` crash, invalid config or lock held, `2`
usage error (bad arguments, signin without a terminal).

### Privacy

DM bodies go to Discord and Telegram by design, and to
`runtime/messages.jsonl` (local, gitignored). They never appear in
`chat_relay.log`, `events.jsonl` or the console. Those carry a `msgId`
that matches the record in `messages.jsonl`. Ops logs are also redacted
(tokens, webhook URLs, cookies, SteamID64s).

### Delivery guarantees

- Every DM is recorded locally (fsynced) before any network call.
- Discord and Telegram are tried in parallel, each with a 12 s timeout and up
  to 3 attempts (429 waits `retry_after`, capped at 30 s). One failing never
  affects the other or the Steam listener.
- A DM is marked relayed once both sinks were tried, even if one failed: no
  duplicate posts after a restart. The failure is in `messages.jsonl` and
  `SINK_FAILED`. There is no automatic re-send yet (v2).
- After every logon, the conversations active since the last relayed message
  (up to 72 h back) are re-read, so DMs sent while the service was down or
  asleep are relayed late, marked "(delivered late)".

## Layout

```
src/
  index.ts            CLI, lock, STOP/PAUSE, health beat, shutdown
  account-runner.ts   one SteamUser per account: logon, persona, chat, backfill, reconnect
  auth.ts             signin, refresh-token check/load/save, logon error classes, ladder
  chat-listener.ts    steam-user payloads -> InboundDm, history backfill
  relay.ts            serial fan-out: dedupe -> record -> pause -> sinks -> mark
  dedupe.ts           persisted relay markers + watermark
  format.ts           Discord/Telegram formatting, escaping, splitting
  http.ts             fetch with timeout and bounded retry
  sinks/discord.ts    webhook embeds + <@id> mention
  sinks/telegram.ts   sendMessage, 4000-char split
  sinks/jsonl.ts      runtime/messages.jsonl
  ops-notify.ts       STARTUP / SHUTDOWN / alert notices
  reply.ts            STUB: sendSteamDm() seam for a future two-way relay
  config.ts accounts.ts logger.ts state.ts atomic-rename.ts lock.ts pause.ts
test/                 vitest, isolated temp runtime per run
docs/                 RESEARCH.md SPEC.md VERIFY_LIVE.md
```

## Not in v1

Replies, auto-replies, per-sender filters or threads, friend-request and
group-chat relays, a re-send outbox, backfill paging, `npm run status`.
See the [v2 list](docs/SPEC.md#v2-list).
