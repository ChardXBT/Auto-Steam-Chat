# VERIFY LIVE checklist

Everything here could not be verified from this session. The reasons are
the same for most items: no Steam password or Steam Guard device, no
Discord/Telegram secrets, and no way to send a real Steam DM. A live Steam
logon with a fake token was also **deliberately not attempted**: repeated
bad logons from the home IP risk a Steam login throttle
(`AccountLoginDeniedThrottle`) that would also hit the acceptor.

Commands are PowerShell, run from the repo root. Tick an item only after
seeing the stated evidence. Items are ordered so each one builds on the last.

What *was* verified offline is listed at the bottom.

---

## 0. Before anything

- [ ] **Main account SteamID64.** `76561199798489148` was taken from
  Steam-Trade-Acceptor `config.example.json`; the brief did not state it.
  - Check: open `https://steamcommunity.com/profiles/76561199798489148` and
    confirm it is S | Skins. If not, copy `config.example.json` to
    `config.json` and set `accounts.main.steam_id`.
- [ ] **Is ASF (steam-asf-keeper) logged into either account?** Its docs say
  Rukia's ASF mapping is unverified. ASF uses its own logonID, but it is one
  more session on the account.
  - Check: in ASF's config, look for bots whose `SteamLogin` is either
    account. Write the answer into `docs/RESEARCH.md` §4.

## 1. Sign-in

- [ ] **`npm run signin` works for both accounts, the password is not echoed,
  and only a refresh token is saved.**
  - Why unverified: needs your password and Steam Guard.
  - Steps:
    ```powershell
    npm ci; npm run build
    npm run signin -- --account main
    npm run signin -- --account rukia
    ```
  - Expect: the password prompt shows nothing as you type (the hidden-input
    trick from `session.mjs`; never tested in Windows Terminal here).
    `Refresh token saved to ...\runtime\accounts\<id>\refresh_token`. Then:
    ```powershell
    Get-ChildItem -Recurse runtime\accounts | Select-Object FullName
    Select-String -Path runtime\logs\*.log,runtime\logs\*.jsonl -Pattern 'eyJ' # must print nothing
    ```
  - Also try pasting the maFile `shared_secret` at the Steam Guard prompt
    once (if you have one): it must be accepted and **not** saved anywhere
    (`Select-String -Recurse` for it in `runtime\` must find nothing).
- [ ] **Signing in does not kick the running acceptor.** Signin uses
  logonID `logon_id + 0x100`. Run the signin above while the acceptor is
  running and check the acceptor's log for `LogonSessionReplaced` (must be
  absent) and continued `POLL_SUCCESS`.
- [ ] **steam-user emits `refreshToken` around `loggedOn` for a password
  logon** (signin gives it 10 s after `loggedOn`). If signin ever reports
  `logged on but Steam sent no refresh token`, this assumption is wrong.

## 2. Coexistence with Steam-Trade-Acceptor (the riskiest unknown)

- [ ] **Both services stay logged on together for an hour.**
  - Why unverified: needs live sessions. Source and docs say distinct
    logonIDs from one IP do not replace each other (`docs/RESEARCH.md` §4).
  - Steps: with the acceptor running on both accounts, `npm start`.
    After 60 minutes:
    ```powershell
    Select-String -Path runtime\logs\events.jsonl -Pattern 'STEAM_ONLINE|LOGON_SESSION_REPLACED|STEAM_RECONNECT_SCHEDULED'
    # and in the acceptor's runtime\logs: no LogonSessionReplaced, POLL_SUCCESS still every ~15 s
    ```
  - Expect: one `STEAM_ONLINE` per account, no `LOGON_SESSION_REPLACED`
    on either side.
- [ ] **No concurrent-session cap bites** with acceptor + this + phone app
  on one account. Same evidence as above, plus the phone app still works.

## 3. Receiving DMs

- [ ] **A DM from a friend arrives as `friendMessage` while Online.**
  - Steps: from a personal account that is friends with Rukia | Skins,
    send `verify 1`. Within seconds:
    ```powershell
    Select-String -Path runtime\logs\events.jsonl -Pattern 'DM_RECEIVED|DM_RELAYED'
    Get-Content runtime\messages.jsonl -Tail 2
    ```
  - Expect: `DM_RECEIVED account="rukia" source="live"`, and a `dm` record
    whose `text` is exactly `verify 1`, `timestamp_source` `steam`.
  - Repeat on S | Skins.
- [ ] **Ordinal disambiguates same-second messages.** Send three short
  messages as fast as possible. Expect three `dm` records with distinct
  `ordinal` (or distinct `server_timestamp`). If two share both, they were
  deduped as one: report it, the dedupe key needs another field.
- [ ] **BBCode / special text is verbatim.** Send a message containing a
  link, `[b]x[/b]`, an emoji, a line break and `<@1> @everyone`. The `text`
  in `messages.jsonl` must match what you typed (Steam may itself convert
  links; note what it does).
- [ ] **`Invisible` persona still receives DMs?** Optional. Set
  `"persona_state": "invisible"` in `config.json`, restart, send a DM. If it
  arrives, invisible is an option (buyers would not see the bots online).
  Record the result in `docs/RESEARCH.md` §2.
- [ ] **Sender display name resolves.** The `dm` record's `sender_name` is
  the friend's current Steam name, not null.

## 4. Discord

- [ ] **Webhook delivery, ping and layout.**
  - Why unverified: no webhook secret here.
  - Steps: put `DISCORD_WEBHOOK_URL` and `DISCORD_MENTION_USER_ID` in
    `.env`, restart, send a DM.
  - Expect: one Discord message that pings you on phone and desktop, with
    the embed fields From / SteamID64 / Account / Profile / Sent, the
    verbatim text, and the profile link opening the sender's profile. A
    STARTUP notice (no ping) appears when the service starts.
- [ ] **Escaping renders correctly and defuses tricks.** Send:
  `[steamcommunity.com/tradeoffer](https://example.com) **bold** _x_ @everyone`
  Expect the text shown literally (no link, no bold, no @everyone ping).
  Also send a bare URL containing `_`, e.g.
  `https://steamcommunity.com/id/some_name`, and check whether it is still
  clickable. If not, note it (spec says acceptable, but it may be worth
  special-casing URLs).
- [ ] **Long DM splits.** Paste a ~5,000-character message. Expect two
  embeds, only the first pings, footers say `part 1/2`, `part 2/2`, and
  nothing is missing.
- [ ] **A broken webhook does not affect Telegram or the listener.** Change
  one character of the webhook token in `.env`, restart, send a DM. Expect
  `SINK_FAILED sink="discord" status=401` (or 404), the Telegram message
  still arrives, and the next DM is still received.

## 5. Telegram

- [ ] **sendMessage to the cs-notifier chat.**
  - Steps: put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (same values as
    cs-notifier) in `.env`, restart, send a DM.
  - Expect: one plain-text Telegram message with the header lines and the
    verbatim body; `<b>` etc. shown literally.
- [ ] **Long DM splits at 4000** (same 5,000-character test): two messages,
  the second starting `(part 2/2, ...)`.

## 6. Recovery

- [ ] **Offline DMs are backfilled and not duplicated.**
  - Steps: create `runtime\STOP_REQUESTED` (service exits 0), delete it,
    send two DMs to Rukia | Skins while it is down, `npm start` again.
  - Expect: `STEAM_OFFLINE_MESSAGES count=2`, `BACKFILL_DONE queued=2`,
    both relayed with "(delivered late)". Restart once more: `BACKFILL_DONE
    queued=0 duplicate=...`, nothing re-posted.
- [ ] **Live and backfilled copies dedupe.** Send a DM, wait for the relay,
  then restart within 2 minutes (the backfill overlap re-reads it). Expect
  `duplicate=1` in `BACKFILL_DONE` and no second Discord post. If it is
  re-posted, the live and history `(server_timestamp, ordinal)` differ.
- [ ] **Phone unread badges are unaffected.** After a relayed DM the Steam
  app on the phone still shows it unread (the service never acks).
- [ ] **Laptop sleep / network loss.** Put the laptop to sleep for 10+
  minutes, send a DM meanwhile, wake it. Expect within a few minutes:
  `STEAM_RECONNECT_SCHEDULED`, then `STEAM_ONLINE`, then the DM relayed late.
  Record how long detection took.
- [ ] **Refresh-token renewal.** After the first live logon look for
  `REFRESH_TOKEN_RENEWED` (steam-user renews only when the token is close
  to expiry, so this may take weeks). The token file must still log on
  after a renewal.
- [ ] **Dead token → alert.** Replace `runtime\accounts\rukia\refresh_token`
  with a token from an *old* signin (or revoke the device in Steam), restart.
  Expect `INTERACTIVE_AUTH_REQUIRED account="rukia"` with an `eresult`, one
  Discord ping + Telegram alert, retries continuing, and the main account
  unaffected. Then `npm run signin -- --account rukia` and confirm it
  recovers without a restart. Note the actual `eresult` Steam returned.

## 7. Ops and CI

- [ ] **Register with the fleet supervisor.** Not done: the supervisor's
  config format was not read in this session. Command: `npm start` in this
  directory; stop file `runtime\STOP_REQUESTED`; log `runtime\logs\chat_relay.log`;
  readiness marker `STEAM_ONLINE`; exit 0 = clean stop, 1 = crash/lock held.
- [ ] **PAUSE.** `New-Item runtime\PAUSE`, send a DM: `RELAY_PAUSED`, the
  `dm` record is written, nothing posted. `Remove-Item runtime\PAUSE`: it is
  posted within a second or two.
- [x] **GitHub Actions CI passes.** Verified after the push: run
  [43346438911](https://github.com/ChardXBT/Auto-Steam-Chat/actions/runs/43346438911)
  succeeded on `bee5fc7` (typecheck, build, tests, no-secrets start, secret
  scan). GitHub warns that `actions/checkout@v4` and `actions/setup-node@v4`
  target the deprecated Node 20 runtime; bump them when newer majors are
  adopted fleet-wide.

---

## Verified offline in this session

- `npm run typecheck` (src and tests), `npm run build`: clean.
- `npm test`: 72 tests, 8 files, all passing. Covers dedupe persistence,
  eviction, corrupt-file quarantine, EPERM/EBUSY rename retry, formatter
  verbatim round-trip and splitting (Discord and Telegram), config and
  secret validation, sink isolation (throw, failure, hang), PAUSE, restart
  dedupe, 429/5xx retry, refresh-token inspection, the reconnect ladder, and
  the account runner against a fake steam-user client (logon details,
  logonID, persona, live DM, echoes ignored, stale-client events ignored,
  auth-required, session-replaced slowdown, wrong account, backfill).
- `npm start` with no secrets and no tokens: both accounts log
  `INTERACTIVE_AUTH_REQUIRED` on the 5 s / 15 s / 30 s ladder, no crash, no
  stdin read, empty stderr. `runtime\STOP_REQUESTED` → `SHUTDOWN
  reason="stop_file"`, exit 0. Stop file present at startup → exit 0.
- Second instance while one runs → refused, exit 1, names the PID.
- `npm run signin` without a terminal → exit 2, no prompt.
- A malformed token file → `INTERACTIVE_AUTH_REQUIRED
  reason="refresh_token_malformed"` without contacting Steam.
- Secret-scan patterns run locally over the tracked files: no matches.
