# Auto-Steam-Chat: research notes

Written 2026-11-12, before the spec. Every claim cites its source. Anything
that cannot be settled from source or docs without a live Steam session is
marked **VERIFY LIVE** and is carried into [`VERIFY_LIVE.md`](VERIFY_LIVE.md).

## Sources read

| Source | Version / path | Used for |
|---|---|---|
| `steam-user` source | 5.3.0, `Steam-Trade-Acceptor/node_modules/steam-user/` (`npm view steam-user version` = `5.3.0`, last modified 2025-12-04) | chat events, payload, logon, logonID, disconnect semantics |
| `steam-user` README | same package, `README.md` | documented behaviour (events, options) |
| `@types/steam-user` | 5.1.1, `node_modules/@types/steam-user/` | the TypeScript surface we compile against |
| Dr. McKay (steam-user author) forum answer | <https://dev.doctormckay.com/topic/2553-how-to-fix-error-logonsessionreplaced/> | logonID guidance |
| Steam-Trade-Acceptor | `C:/Users/ericy/Downloads/steam-delivery-work/Steam-Trade-Acceptor` @ `4cbb033` | fleet conventions, how it logs on |
| steam-autobuyer session helper | `C:/Users/ericy/steam-autobuyer/scripts/steam_session/session.mjs` | distinct logonID, renewRefreshTokens, exit codes |
| steam-autobuyer alerts/logging | `src/steam_autobuyer/alerts.py`, `logging_setup.py`, `.github/workflows/test.yml` | AlertSink contract, redaction regexes, CI secret scan |
| cs-notifier | `C:/Users/ericy/Downloads/cs-notifier/src/{delivery,format,types}.ts` | Telegram endpoint, env names, length limits |
| Steam community / help pages (web search) | see section 2 | who can DM a Steam account |

Paths below like `chatroom.js:1031` are relative to
`node_modules/steam-user/components/` in steam-user 5.3.0.

---

## 1. Chat surface in steam-user v5

### Inbound DM event

The current API is the `SteamChatRoomClient` exposed as `client.chat`. The
legacy `client.on('friendMessage', (steamID, message))` still fires but is
documented as **deprecated** ("You should use `SteamChatRoomClient` instead",
README `### friendMessage`).

Source, `chatroom.js:1031-1110`, handler for
`FriendMessagesClient.IncomingMessage#1`:

- `chat_entry_type == ChatMsg (1)` → `this.chat.emit('friendMessage', body)`
- `Typing (2)` → `friendTyping`
- `LeftConversation (6)` → `friendLeftConversation`
- any other type → `debug` only ("Got unknown chat entry type"), no event
- if `body.local_echo` is true the name gets an `Echo` suffix:
  `friendMessageEcho`, `friendTypingEcho`, `friendLeftConversationEcho`
- after that it also emits the deprecated ID events on the `SteamUser`
  itself (`friendMessage`, `friendMessage#<steamid>`, `friendOrChatMessage`)

**Decision:** subscribe to `client.chat.on('friendMessage', ...)` only.

### Payload (`IncomingFriendMessage`)

Built in `chatroom.js:1032-1040` and typed in
`@types/steam-user/components/chatroom.d.ts:511-522`:

| Field | Type | Notes |
|---|---|---|
| `steamid_friend` | `SteamID` | sender. `preProcessObject` (`chatroom.js:1344+`) converts every `steamid_*` string into a `SteamID` |
| `chat_entry_type` | `EChatEntryType` | `1` for a normal message |
| `from_limited_account` | boolean | coerced from null to false. Worth surfacing: limited accounts are common for scam alts |
| `message` | string | raw text **with BBCode** |
| `message_no_bbcode` | string | falls back to `message` when Steam omits it |
| `message_bbcode_parsed` | array | parsed BBCode tree |
| `server_timestamp` | `Date` | from `rtime32_server_timestamp`, a 32-bit **whole-second** server time |
| `ordinal` | number | coerced to `0` when absent |
| `local_echo` | boolean | true = a message *we* sent from another session |
| `low_priority` | boolean | |

There is **no message id**. The only identity Steam gives a friend message is
`(sender, server_timestamp seconds, ordinal)`. Steam itself uses
`{server_timestamp, ordinal}` to address messages (see the
`deleteChatMessages` argument contract, `chatroom.js:800-830`, and the
`startOrdinal`/`lastOrdinal` paging options of `getFriendMessageHistory`,
`chatroom.js:650-695`). The ordinal disambiguates messages within the same
second.

**VERIFY LIVE:** that `ordinal` is non-zero and increments for two messages a
sender sends within the same second, and that the live event's
`(server_timestamp, ordinal)` equals the pair `getFriendMessageHistory`
returns for the same message. The dedupe key relies on both.

**VERIFY LIVE:** whether `message_no_bbcode` (live) and the history API's
`message` with `wantBbcode: false` are byte-identical for the same message,
including links, `[`/`]`, emoji and multi-line text.

### Echo and typing

- `friendMessageEcho` = a message the account itself sent from another
  session (the phone app, the acceptor never sends chat). Ignored in v1.
- `friendTyping` / `friendLeftConversation` (and their echoes) are noise for
  this use case. Ignored.

### Group / chat-room messages

New-style group chats arrive as `chat.emit('chatMessage', body)`
(`chatroom.js:1112-1139`, `ChatRoomClient.NotifyIncomingChatMessage#1`) with
`chat_group_id`, `chat_id`, `steamid_sender`. Legacy chat-room messages and
invites are the deprecated `chatMessage` / `chatInvite` events (README).
These are **not DMs**. The bots are not expected to be in group chats, so v1
ignores them (they are not subscribed, so they are not even logged).

### Offline messages and backfill APIs

- `offlineMessages(count, friends)` (`notifications.js:93-100`,
  `EMsg.ClientFSOfflineMessageNotification`). README: "This will always be
  emitted after logon, even if you have no messages." It gives a **count and
  a list of senders**, not the text.
- `client.chat.getActiveFriendMessageSessions({conversationsSince})`
  (`chatroom.js:602-640`) → `{sessions: [{steamid_friend, time_last_message,
  time_last_view, unread_message_count}], timestamp}`. 10 s timeout.
- `client.chat.getFriendMessageHistory(friend, {startTime, maxCount,
  wantBbcode, ...})` (`chatroom.js:646-712`) → `{messages: [{sender,
  server_timestamp, ordinal, message, message_bbcode_parsed, unread}],
  more_available}`. Default `maxCount` 100. Includes messages in both
  directions; ours must be filtered out by `sender`.

---

## 2. Who can DM the accounts

- Steam only allows direct messages between friends. Non-friends can only
  start a chat if they share a group chat. Sources: Steam Community
  discussion <https://steamcommunity.com/discussions/forum/0/3165461775611266910/>
  ("You can initiate a new chat with someone who's not your friend if
  they're in the same chat group"), and the Steam error string "Your account
  does not have permission to send messages to non-friends"
  (<https://steamcommunity.com/discussions/forum/1/3826424631139455944/>).
  So in practice only friends of S | Skins / Rukia | Skins can DM them. A
  buyer who has not been accepted as a friend is invisible to this service.
  Pending friend requests are a separate event (`friendRelationship` with
  `EFriendRelationship.RequestRecipient`, README `### friendRelationship`),
  which goes on the v2 list.
- **Persona state.** README for every chat event says "as long as we're
  [online](#setpersonastate-name)", and `setPersona` docs say "You need to
  call this after you logon or else you'll show up as offline." The
  Steam-Trade-Acceptor never calls `setPersona` (grep of its `src/` for
  `setPersona` returns nothing), so today both accounts are logged on but
  offline from the CM's point of view. This service must call
  `setPersona(EPersonaState.Online)` after `loggedOn`.
  **VERIFY LIVE:** whether `Invisible (7)` also receives `friendMessage`
  (that would let the bots read DMs without showing as online). Default is
  `Online` until verified.
- Persona state is account-wide. Setting it from this service changes what
  buyers see for the account (online instead of offline). That is visible
  but harmless for marketplace bots, and arguably a feature.
- Group chat messages and invites: surfaced as separate events (section 1),
  not DMs, safe to ignore for v1.

---

## 3. Message identity and redelivery

- **Stable identity:** `(account, sender SteamID64, server_timestamp in
  whole seconds, ordinal)`. No opaque message id exists in the protocol
  surface steam-user exposes. Server time, not local time, so it is the same
  across restarts and sessions.
- **Does Steam redeliver missed messages on logon?** Not as `friendMessage`
  events. On logon Steam sends `offlineMessages` with a count and sender
  list only (section 1). The text has to be pulled through
  `getActiveFriendMessageSessions` + `getFriendMessageHistory`. The steam-user
  source has no code path that replays old messages as live events.
  **VERIFY LIVE:** that a DM sent while the service is down shows up (a) in
  `offlineMessages` on the next logon and (b) in `getFriendMessageHistory`
  with the same `(server_timestamp, ordinal)` it would have had live.
- **Read state.** `getFriendMessageHistory` computes `unread` from
  `time_last_view` (`chatroom.js:700-708`). Fetching history does not mark
  anything read; only `ackFriendMessage` does (`chatroom.js:770-780`). This
  service never acks, so the phone app keeps showing unread badges.
  **VERIFY LIVE:** that being Online in a second session does not by itself
  clear unread state on the phone.
- **Consequence for design:** live events plus a history backfill on every
  logon, both feeding one dedupe store keyed as above, with a per-account
  watermark (latest relayed `server_timestamp`) to bound the backfill window.

---

## 4. CM-session interaction (the riskiest unknown)

### What logonID is

`09-logon.js:66-90`: `details.logonID` becomes
`CMsgClientLogOn.obfuscated_private_ip.v4`. A dotted IPv4 string is converted
and XORed with `0xbaadf00d`; a number above 2^32-1 is truncated with a
warning. Missing or `0` → `0`.

README (`logOn` details): "`logonID` - A 32-bit integer to identify this
login. The official Steam client derives this from your machine's private IP
(it's the `obfuscated_private_ip` field in `CMsgClientLogOn`). **If you try to
logon twice to the same account from the same public IP with the same
`logonID`, the first session will be kicked with reason
`SteamUser.EResult.LogonSessionReplaced`.** Defaults to `0` if not specified."

The library author's answer
(<https://dev.doctormckay.com/topic/2553-how-to-fix-error-logonsessionreplaced/>):
"Just set logonID to some number when you log on, and use a different number
for each instance of the account."

### What the fleet uses today

| Process | Account(s) | logonID | Source |
|---|---|---|---|
| Steam-Trade-Acceptor worker (start, reconnect, signin) | main, rukia | **0** (not passed) | `src/auth.ts` `client.logOn({accountName, password, twoFactorCode})` and `client.logOn({refreshToken})`; grep of `src/` for `logonID` finds nothing |
| steam-autobuyer `session.mjs` | its configured account | `0x5a17b0` | `session.mjs:24` |
| Official Steam client / phone | any | derived from private IP (desktop) / unknown (mobile) | README |
| ASF (steam-asf-keeper) | possibly Rukia ("Rukia's actual enabled mapping ... remain unverified", `steam-asf-keeper/docs/recovery-specs/f01-asf-account-relogin.md`) | ASF's own value | not read; **VERIFY LIVE** if ASF holds either account |

### Answer

- Two sessions on the same account, same public IP, **different** logonIDs:
  both stay logged on. This is exactly the case the README and the author
  describe. This service uses fixed non-zero logonIDs that differ from `0`
  (acceptor), `0x5a17b0` (autobuyer helper) and each other:
  `main = 0x41534301`, `rukia = 0x41534302` ("ASC" + n), plus a separate one
  for `npm run signin` so signing in never kicks the running service.
- Using the default `0` would collide with the acceptor and one of the two
  processes would be kicked with `LogonSessionReplaced (34)`, each time the
  other reconnects. That is the failure mode to avoid.
- `LoggedInElsewhere (6)` is a different mechanism: it is about *playing a
  game* on another session. This service never calls `gamesPlayed`, so it
  cannot trigger or suffer it from the acceptor (which also does not play).
- The acceptor itself. `src/auth.ts` builds `SteamUser` with
  `autoRelogin: false`. In `09-logon.js:631-680` (`_handleLogOff`) every
  logoff is `fatal` when `autoRelogin` is false, so it is surfaced as
  `'error'`, not `'disconnected'`. The acceptor's post-logon `'error'`
  listener in `src/steam.ts` (`setupSteamClientEvents`) only logs
  `STEAM_CLIENT_ERROR`; its relogin ladder is driven by `'disconnected'` and
  the trade manager's `sessionExpired`. So if the acceptor's CM session were
  kicked it would keep polling on its existing web cookies until those
  expire, and would not reconnect the CM session immediately. **Observation
  only, not changed here** (different repo, out of scope). It reinforces
  that this service must never reuse logonID 0.
- Refresh tokens are independent. This service signs in once per account
  and gets its **own** refresh token. `renewRefreshTokens: true` renews only
  the token used for that logon (`09-logon.js:166-170, 786-802`; README "the
  refresh token you used to log on will become invalid"). It cannot
  invalidate the acceptor's token.
- **VERIFY LIVE:** start this service while the acceptor is running on both
  accounts; confirm neither logs `LogonSessionReplaced`, and the acceptor
  keeps producing `POLL_SUCCESS` for an hour.
- **VERIFY LIVE:** whether Steam caps concurrent CM sessions per account.
  Nothing in steam-user source or docs mentions a cap; the fleet would be at
  2 sessions per account (acceptor + this) plus the phone.

### Other logon facts used by the design

- After `loggedOn` with a refresh token, steam-user itself attempts token
  renewal (if `renewRefreshTokens`) and calls `webLogOn()`
  (`09-logon.js:780-806`). The `webSession` cookies are not needed here and
  are ignored.
- `error` is emitted for fatal logon failures and, with `autoRelogin: false`,
  for every disconnect after logon (`_handleLogOff`). If `error` is not
  handled the process crashes (README `### error`: "If this event isn't
  handled, the program will crash.").
- `logOn()` throws asynchronously ("Already logged on") inside
  `process.nextTick` if called on an instance that is still logged on or
  connecting (`09-logon.js:24-38`). Reusing an instance across reconnects is
  therefore risky; the acceptor creates a fresh `SteamUser` per attempt, and
  this service does the same.
- Fatal-auth EResults (token dead, sign-in needed): `InvalidPassword 5`,
  `AccessDenied 15`, `Revoked 26`, `Expired 27`, `InvalidSignature 121`
  (`enums/EResult.js`). `session.mjs` treats 5/15/84/88 plus
  `/AccessDenied|InvalidPassword|Expired|Revoked/` as "login required".
  `RateLimitExceeded 84` and `AccountLoginDeniedThrottle 87` are throttles,
  not dead tokens, and are treated as transient (longer backoff) here.

---

## 5. Alternatives

| Option | How | Verdict |
|---|---|---|
| **steam-user CM client** (chosen) | `client.chat.on('friendMessage')` over the CM connection | Real-time push, documented, same library and refresh-token flow both sibling repos already use. Needs a distinct logonID and Online persona. |
| `steamcommunity` web chat | `steamcommunity`'s chat helpers target the old web chat that Steam replaced with the new chat in 2018; today's web chat talks the same CM protocol over a WebSocket | Not a supported receive path; would amount to scraping. Rejected (scraping is a non-goal). Not re-verified against the current `steamcommunity` source, because nothing here depends on it. |
| Web API poll | The `FriendMessages.GetRecentMessages` service method (the same one steam-user wraps, `03-messages.js:285`), called per friend on a timer | Polling per friend, unofficial auth, rate limits, and it still needs a logon to get a token. Kept only as the *backfill* mechanism, through steam-user's wrapper on the CM connection. |
| Fold into Steam-Trade-Acceptor | Add a chat listener to its worker's `SteamUser` | No second session at all, which removes the logonID risk entirely. But: couples DM relay to a money-moving process with its own release discipline (build markers, status, supervised restarts); a chat bug or a Discord hang would share a process with accepts; the acceptor is offline-persona by design and would have to go Online; and its post-logon `'error'` handling (section 4) would need work first. Rejected for v1. Reconsider if a second session per account turns out to be a problem live. |

**Recommendation:** a separate service on `steam-user` 5.3, with its own
refresh tokens and distinct logonIDs, structured like the acceptor.

---

## 6. Where it runs

| Option | For | Against |
|---|---|---|
| **Laptop daemon under the existing supervisor** (chosen) | Same home IP as the acceptor, so Steam sees a familiar location (no new-location Steam Guard prompts or suspicious-login emails). Reuses the fleet's PAUSE/STOP files, JSONL logs and supervisor. `npm run signin` is interactive and easiest at the machine. Zero cost. | Laptop sleep / network loss = gaps. Mitigated by history backfill on every logon (section 3). |
| VPS / container | Always on | New IP for both bot accounts (Steam Guard/new-login friction, account-risk signal for trading bots), a second copy of refresh tokens on a remote host, monthly cost, and none of the fleet tooling. Also the logonID guarantee is "same public IP"; a different IP removes the collision risk but adds the location risk. |

**Recommendation:** laptop daemon, same supervisor as the acceptor. The
backfill makes sleep gaps recoverable: a DM received while asleep is relayed
(late) on the next logon instead of being lost.

**VERIFY LIVE:** what steam-user does across Windows sleep/resume (socket
death detection time, whether `error` fires promptly so the ladder reconnects).

---

## Fleet conventions adopted (Phase 0 notes)

From Steam-Trade-Acceptor:

- `runtime/` tree, per-account `runtime/accounts/<account>/` holding the
  refresh token, steam-user data dir and state. All gitignored.
- Refresh-token logon, password prompted once at `signin` and never stored,
  Steam Guard code or a pasted maFile `shared_secret` recognised by format
  (`isValidSteamSecret`: 40 hex, or 27 base64 chars + optional `=` that
  decode to 20 bytes; `parseGuardEntry`). This service does not save the
  secret: unattended logons use only the refresh token.
- Unattended mode never reads stdin; a dead or missing token →
  `INTERACTIVE_AUTH_REQUIRED`, alert, keep retrying.
- Reconnect ladder `5s, 15s, 30s, 60s, 5m, 10m` then 10m
  (`RELOGIN_BACKOFF_MS` in `src/steam.ts`).
- Atomic writes: temp file + `fsync` + rename with `renameWithRetry` (EPERM,
  EBUSY, EACCES retried 5 times at 50/100/150/200 ms) from
  `src/atomic-rename.ts`, because OneDrive and AV briefly hold new files.
- Single-instance PID lock with stale takeover (`src/lock.ts`).
- `runtime/PAUSE`, `runtime/STOP_REQUESTED` (watched with `fs.watchFile`,
  checked at startup too, per the 2026-09-29 incident comment in
  `src/steam.ts`).
- `runtime/logs/` human log + `events.jsonl`, size rotation 20 MB x 3,
  redaction by key name and by value shape (`src/logger.ts`).
- Discord webhook embeds with a 10 s `AbortSignal.timeout` and the response
  body always consumed (Windows libuv assertion note in
  `src/notifications.ts`).
- STARTUP / SHUTDOWN Discord notices.

From steam-autobuyer:

- `logonID` distinct per process (`session.mjs:23-24`), `renewRefreshTokens:
  true`, atomic token save, hidden password prompt
  (`rl._writeToOutput` override), never printing token values.
- `AlertSink`: local JSONL written first, webhook second, webhook failures
  logged and never raised, `ALERT_MENTION` prefix only on alerts that need
  the owner.
- Redaction regexes (`logging_setup.py`): key-based
  `(steamLoginSecure|sessionid|access_token|refresh_token|...)` and
  shape-based: Bearer tokens, JWTs `eyJ...`, Discord/Slack webhook URLs, and
  SteamID64 `7656119\d{10}`.
- CI "No session material tracked": `git ls-files` must not list session or
  `.env` files; `git grep` must not find webhook secrets or cookie values.

From cs-notifier (conventions only, not the Worker runtime):

- `POST https://api.telegram.org/bot<TOKEN>/sendMessage` with `chat_id`,
  `text`, `disable_web_page_preview: true`; success requires HTTP 2xx **and**
  `{"ok": true}`.
- Env names `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL`.
- `TELEGRAM_MESSAGE_LIMIT = 4000` (Telegram's hard limit is 4096),
  `DISCORD_MESSAGE_LIMIT = 1900` for plain content.
- 12 s outbound timeout, error messages carry only the error *name*, never
  the URL.
- Account labels `S | Skins`, `Rukia | Skins` (`types.ts`
  `ACCEPTED_ACCOUNTS`).
- Display time zone `America/Toronto`.

## Identities

- `main` = `S | Skins`, SteamID64 `76561199798489148`, taken from
  Steam-Trade-Acceptor `config.example.json` (`account.steam_id`). The brief
  did not state it; **VERIFY LIVE** that this is the right account.
- `rukia` = `Rukia | Skins`, SteamID64 `76561199825952724` (brief, and the
  acceptor's `RUKIA` constant in `src/accounts.ts`).

## Open questions carried forward

All are listed with exact steps in `VERIFY_LIVE.md`:

1. Coexistence with the acceptor's logonID-0 sessions (section 4).
2. Concurrent-session cap per account (section 4).
3. `Invisible` persona still receives DMs? (section 2)
4. Ordinal behaviour and live/history key equality (sections 1, 3).
5. `message_no_bbcode` vs history `message` equality (section 1).
6. Offline-message backfill end to end (section 3).
7. Phone unread state unaffected (section 3).
8. Sleep/resume reconnect timing (section 6).
9. Whether ASF is logged into either account (section 4).
10. Main account SteamID64 (Identities).
