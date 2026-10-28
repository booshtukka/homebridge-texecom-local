# homebridge-texecom-local (fork of homebridge-texecom-full 4.4.1-beta.1)

A fork of [homebridge-texecom-full](https://github.com/K1LL3R234/homebridge-texecom)
**4.4.1-beta.1** (MIT, Chris Posthumus), shared so the fixes can be replicated upstream.
It runs in daily use on a **Texecom Premier Elite with a ComIP** (Crestron/Simple-protocol
port, IP only). Every change below came from a real failure on that panel.

It registers as package `homebridge-texecom-local`, platform `TexecomLocal`, so it can sit
beside the npm plugin. Accessory UUIDs still use upstream's `"Texecom:<name>"` seed, so
switching from `Texecom` to `TexecomLocal` keeps the same HomeKit accessories.

## Layout

The code was restructured rather than patched, so a diff against `index.js` is not useful:

- `plugin/index.js`: platform and accessories. Accessory model, `target_states`, `"E` entry
  handling and arm-state resolution (`remote_users`, `app_users`, `default_arm_state`) are
  upstream's.
- `lib/panel-link.js`: new. The single TCP link and every rule for writing to the panel
  (login, command, logout, ASTATUS, heartbeat, cooldowns).
- `lib/protocol.js`: framing (several messages per packet), parsing, the binary Wintex frames.
- `lib/alert.js`, `bin/texecom-alert`: optional failure alerts.
- `test/`: `node --test` against `test/fake-panel.js`, a local TCP fake of the ComIP that
  models the behaviour described below.

Not carried over: serial, panel clock sync (it needs a login), external accessories.

## What changed and why

### 1. Login: resend `\W` after 2 s; send the command only after an OK

**Why:** the panel never answers the first `\W<udl>/` after idle; it answers the resend at
once (same as the upstream #26 trace). With a single `\W` the login got no reply and the
command got `ERROR`. A third `\W` into an open session can wedge the port (`\W` unanswered,
text commands `ERROR`) until a power cycle. So: `\W`, then one resend if no OK within 2 s,
then up to 6 s for the OK; never a third. The command is sent only after an OK (a late OK to
the first `\W` is swallowed in a short settle window so it isn't taken for the command's).
Every command is followed by the binary Wintex logout `03 48 B4` (ACK `03 06 F6`).

**Where:** `lib/panel-link.js` `runCommand()` / login sequence; `DEFAULTS.loginRetryAfterMs`,
`loginTimeoutMs`, `loginSettleMs`, `sendCommandWithoutLoginOk`. Frames in `lib/protocol.js`.

### 2. One login per 60 s; 35 s quiet after logout

**Why:** while a session is open the panel holds back all event output, and after the
logout ACK it keeps events back and NAKs `ASTATUS` (`03 0F ED`) for about 30 s. Logging in
again in that window is what risks a second `\W` into an open session. So: at most one login
sequence per `login_cooldown` (60 s); a preflight `ASTATUS` before each login (a NAK means a
session is open, so nothing is sent); with no logout ACK the session is assumed open for
65 s; and no `ASTATUS` is sent for 35 s after the logout.

**Where:** `lib/panel-link.js` `loginCooldownMs`, `sessionIdleMs`, `postLogoutQuietMs`,
`preflightStatus`.

### 3. Never start from cached state; ASTATUS heartbeat

**Why:** after a restart the cached accessory said Off while the panel was armed, and Home
showed Off. Now an area is unknown until the panel says otherwise (a valid `ASTATUS` letter or
an `"A`/`"D`/`"L` event). Until then HomeKit reads throw `SERVICE_COMMUNICATION_FAILURE` (No
Response), nothing is pushed, and taps fail at once with nothing sent. The same applies again
after every reconnect (`unknown_after_reconnect`). `ASTATUS` (no login needed) runs on connect
and every 60 s while no session is open; it also catches a missed event. Two unanswered in a
row means the link is dead: drop the socket and reconnect. `ERROR`/NAK still count as alive.
If the state stays unknown after `state_alert_tries`, an alert goes out.

**Where:** `plugin/index.js` `areasKnown`, `_statusFailed()`, the characteristic get
handlers; `lib/panel-link.js` poll / heartbeat (`pollIntervalMs`, `maxMissedPolls`).

### 4. Show Away on the panel's OK; ASTATUS corrects

**Why:** the panel's own `"A` only arrives ~30 s after the logout (events are held back until
then), so waiting for it left Home on "Arming…" long after the panel had accepted the arm. With `show_armed_on_accept` (default on) Home shows Away
as soon as the panel OKs the arm. If `ASTATUS` still says disarmed after
`optimistic_grace_seconds` (60), Home is corrected to Off and an alert goes out. Separately, `"X`
(exit delay started, e.g. a keypad arm) shows Arming… until `"A`. If an accepted arm is never
confirmed within `arm_confirm_seconds`, an alert goes out.

**Where:** `plugin/index.js` arm path after `runCommand()` resolves, and the ASTATUS handler.

### 5. Off inside the cooldown is queued, not refused

**Why:** after arming, the 60 s cooldown made Off from Home fail for a minute, which is the
wrong way round for a disarm. Now Off inside the cooldown (or while a session may be open) is
queued: Home shows Disarming… and the `\D` is sent as soon as the panel can take a login.
Repeat taps send one `\D`, no alert. A late `"A` released after the earlier logout does not
flip Home back to Away while the Off is pending. Extra arm taps inside the cooldown still fail
fast with nothing sent.

**Where:** `plugin/index.js` target-state set handler (queued disarm) and the `"A` event
handler.

### 6. Alert hook for failures

**Why:** a failed arm used to show only in the log. Failed commands, unknown state, an
accepted arm that never armed, and the panel offline for `alert_after_offline_minutes` (and
back again) now run `alert_command`. The message is `$1`, `$TEXECOM_ALERT` and stdin; exit 0
counts as sent; identical alerts are not repeated within `alert_min_interval`. Unset = off.
`"alert_command": true` runs the bundled `bin/texecom-alert`, an example that sends via the
Telegram Bot API using `TEXECOM_TELEGRAM_BOT_TOKEN` and `TEXECOM_TELEGRAM_CHAT_ID`.

**Where:** `lib/alert.js`; calls to `this.alerter.send()` in `plugin/index.js`.

### 7. `target_states` default: Away and Off

**Why:** with one arm mode, Home and Siri can't pick the wrong one: "Arm the House Alarm"
always means Away. (Siri sends "turn on the alarm" to clock alarms, so say "arm".) This is
the same `target_states` setting as 4.4.1-beta.1; only the default differs. Set it to bring
the other modes back (`away`, `home`, `night`, `off`).

**Where:** `plugin/index.js`, `target_states` handling.

## Config options

All optional; defaults shown; times in seconds unless the name says minutes.

- `target_states` `["away","off"]`, `away_arm_command` `"A"`, `stay_arm_command` `"Y"`
- `login_retry` true, `login_retry_after` 2, `login_timeout` 6,
  `send_command_without_login_ok` false
- `command_timeout` 5, `login_cooldown` 60, `preflight_status` true
- `status_poll` true, `status_poll_interval` 60, `status_max_missed` 2,
  `state_alert_tries` 2, `unknown_after_reconnect` true
- `show_armed_on_accept` true, `optimistic_grace_seconds` 60, `arm_confirm_seconds` 300,
  `exit_max_seconds` 300
- `zone_triggers_alarm` true, `zone_trigger_grace` 5 (wait for a late `"E`/`"D`/`"L` before
  treating a zone as an alarm)
- `alert_command` (unset = off), `alert_min_interval` 30, `alert_after_offline_minutes` 10
  (0 = off)

Plus upstream's `ip_address`, `ip_port`, `udl`, `zones`, `areas`, `debug`. See
`config.schema.json` for the full list.

## Tests

```
npm test
```

Node 20+. The plugin tests use the real HAP-NodeJS from a global Homebridge install
(`/usr/local/lib/node_modules/homebridge/...`); point `HAP_NODEJS` at another copy if needed,
otherwise those tests are skipped. Nothing touches a real panel.

## Licence

MIT, as upstream. See `LICENSE`.
