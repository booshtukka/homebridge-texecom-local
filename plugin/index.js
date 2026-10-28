'use strict';
// homebridge-texecom-local: a fork of homebridge-texecom-full 4.4.1-beta.1
// (https://github.com/K1LL3R234/homebridge-texecom, MIT). The accessory and
// arm-state logic is upstream's; the panel link (lib/panel-link.js) is new and
// is the reason the fork exists. See README.md for what changed and why.

const crypto = require('crypto');
const { PanelLink } = require('../lib/panel-link');
const P = require('../lib/protocol');
const { Alerter } = require('../lib/alert');
const LogUtil = require('./logutil');

const PLUGIN_NAME = 'homebridge-texecom-local';
const PLATFORM_NAME = 'TexecomLocal';

// Accessory UUIDs are still generated from "Texecom:<name>", exactly as
// upstream does, so the HomeKit identity of every accessory survives the swap
// from homebridge-texecom-full.
const UUID_NAMESPACE = 'Texecom';

module.exports = (api) => {
    api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, TexecomPlatform);
};

function seconds(value, fallback) {
    const n = Number(value);
    return value === undefined || value === null || value === '' || !Number.isFinite(n) || n < 0 ? fallback : n;
}

// ─── Platform ────────────────────────────────────────────────────────────────
class TexecomPlatform {
    constructor(log, config, api) {
        this.log = new LogUtil(config.debug, config.name, log);
        this.api = api;
        this.hap = api.hap;
        this.config = config;

        this.zones = config.zones || [];
        this.areas = config.areas || [];
        this.area_groups = config.area_groups || [];
        this.ip_address = config.ip_address;
        this.ip_port = config.ip_port || 10001;
        this.udl = (config.udl === null || config.udl === undefined || String(config.udl).trim() === '')
            ? null : String(config.udl).trim();

        this.remote_users = parseUserList(config.remote_users);
        this.app_users = parseUserList(config.app_users);
        this.default_arm_state = String(config.default_arm_state || 'away').toLowerCase();

        // Away and Off unless the config says otherwise (upstream offered every mode).
        const ts = config.target_states;
        this.target_states = (ts === undefined || ts === null || ts === '' || (Array.isArray(ts) && ts.length === 0)) ? ['away', 'off'] : ts;

        // The command letter sent for Away.
        this.away_arm_command = String(config.away_arm_command || 'A').trim().toUpperCase();
        // ... and for Home/Night. Y is the documented part arm (part arm 1).
        this.stay_arm_command = String(config.stay_arm_command || 'Y').trim().toUpperCase();

        this.zone_trigger_grace_ms = seconds(config.zone_trigger_grace, 5) * 1000;
        this.zone_triggers_alarm = config.zone_triggers_alarm !== false;
        this.exit_max_ms = seconds(config.exit_max_seconds, 300) * 1000;
        this.arm_confirm_ms = seconds(config.arm_confirm_seconds, 300) * 1000;
        // Show Away as soon as the panel answers OK to the arm, instead of waiting
        // ~30 s for its "A event (it holds events back after a login). ASTATUS
        // still has the last word: if it says disarmed once the grace is up,
        // Home is corrected and an alert goes out.
        this.show_armed_on_accept = config.show_armed_on_accept !== false;
        this.optimistic_grace_ms = seconds(config.optimistic_grace_seconds, 60) * 1000;
        this.offline_alert_ms = seconds(config.alert_after_offline_minutes, 10) * 60000;
        this.state_alert_tries = Math.max(1, Math.round(seconds(config.state_alert_tries, 2)));
        this.unknown_after_reconnect = config.unknown_after_reconnect !== false;

        if (config.serial_device) {
            this.log.error('serial_device is not supported by homebridge-texecom-local, only ip_address');
        }
        if (Number(config.time_sync_interval) > 0) {
            this.log.log('time_sync_interval is ignored: the panel clock sync needs a login, which this fork keeps for arm/disarm only');
        }

        this.alerter = new Alerter({
            command: config.alert_command,
            log: this.log,
            minIntervalMs: seconds(config.alert_min_interval, 30) * 1000,
        });

        this.linkOptions = Object.assign({
            host: this.ip_address,
            port: this.ip_port,
            udl: this.udl,
            log: this.log,
            loginRetryAfterMs: seconds(config.login_retry_after, 2) * 1000,
            loginRetry: config.login_retry !== false,
            loginTimeoutMs: seconds(config.login_timeout, 6) * 1000,
            commandTimeoutMs: seconds(config.command_timeout, 5) * 1000,
            loginCooldownMs: seconds(config.login_cooldown, 60) * 1000,
            pollIntervalMs: seconds(config.status_poll_interval, 60) * 1000,
            maxMissedPolls: Math.max(1, Math.round(seconds(config.status_max_missed, 2))),
            statusPoll: config.status_poll !== false,
            sendCommandWithoutLoginOk: config.send_command_without_login_ok === true,
            preflightStatus: config.preflight_status !== false,
        }, config._linkOverrides || {});

        this.cachedAccessories = new Map();
        this.api.on('didFinishLaunching', () => this._setup());
        this.api.on('shutdown', () => this._shutDown());
    }

    configureAccessory(accessory) {
        this.log.debug(`Restoring cached accessory ${accessory.displayName}`);
        this.cachedAccessories.set(accessory.UUID, accessory);
    }

    findAreaAccessory(area_number) {
        return (this._areaAccessories || []).find(a => Number(a.zone_number) === Number(area_number));
    }

    _shutDown() {
        this._shutting_down = true;
        clearTimeout(this._offlineTimer);
        if (this.link) this.link.stop();
        for (const t of this._zoneTriggerTimers ? this._zoneTriggerTimers.values() : []) clearTimeout(t);
        for (const a of this._areaAccessories || []) clearTimeout(a.arm_confirm_timer);
    }

    _setup() {
        const platform = this;
        const { hap, api } = this;

        const zoneAccessories = this.zones.map(z => new TexecomAccessory(this.log, z, hap, 'zone'));
        const areaAccessories = this.areas.map(a => new TexecomAccessory(this.log, a, hap, 'area'));
        const groupAccessories = this.area_groups.map(g => new TexecomAccessory(this.log, g, hap, 'group'));
        this._areaAccessories = areaAccessories;
        this._groupAccessories = groupAccessories;
        this._zoneAccessories = zoneAccessories;

        // Panel-side state per area number.
        this.areaStates = new Map();      // area -> SecuritySystemCurrentState
        this.areasArmed = new Set();      // confirmed armed ("A or ASTATUS Y)
        // Areas whose state has come from the panel since start-up (or since
        // the last reconnect). Until then HomeKit reads get No Response and
        // nothing is pushed: the cached state is never shown (a cache saying
        // Off while the panel is armed is the failure this prevents).
        this.areasKnown = new Set();
        this._statusFailures = 0;
        this.areasInEntry = new Set();
        this.areasInExit = new Map();     // area -> time the exit delay started
        this._zoneTriggerTimers = new Map();

        const activeUUIDs = new Set();
        for (const acc of [...zoneAccessories, ...areaAccessories, ...groupAccessories]) {
            const uuid = hap.uuid.generate(`${UUID_NAMESPACE}:${acc.name}`);
            if (activeUUIDs.has(uuid)) {
                platform.log.error(`Duplicate accessory name "${acc.name}" in config, names must be unique. Skipping.`);
                continue;
            }
            activeUUIDs.add(uuid);
            let hapAccessory = platform.cachedAccessories.get(uuid);
            const isNew = !hapAccessory;
            if (isNew) {
                platform.log.log(`Adding accessory ${acc.name}`);
                hapAccessory = new api.platformAccessory(acc.name, uuid);
            }
            acc.setupServices(hapAccessory, platform);
            if (isNew) api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [hapAccessory]);
            else api.updatePlatformAccessories([hapAccessory]);
            platform.cachedAccessories.set(uuid, hapAccessory);
        }
        const stale = [...platform.cachedAccessories.entries()].filter(([uuid]) => !activeUUIDs.has(uuid));
        if (stale.length > 0) {
            stale.forEach(([uuid, accessory]) => {
                platform.log.log(`Removing accessory ${accessory.displayName}, no longer in config`);
                platform.cachedAccessories.delete(uuid);
            });
            api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale.map(([, a]) => a));
        }

        // No state from the cache: areas stay unknown (No Response) until the
        // panel answers ASTATUS or reports the area with "A/"D/"L.

        if (!this.ip_address) {
            this.log.error('ip_address is not set, nothing to connect to');
            return;
        }
        if (this.udl == null) {
            this.log.log('No UDL configured: status and events only, arming from HomeKit is off');
        }

        this.link = new PanelLink(this.linkOptions);
        this.link.on('event', (ev) => this._safely(() => this.handleEvent(ev)));
        this.link.on('astatus', (letters) => this._safely(() => this.handleAstatus(letters)));
        this.link.on('astatus-error', () => {
            this._statusFailed('answered ERROR');
            if (!this._astatusErrorWarned) {
                this._astatusErrorWarned = true;
                this.log.warn('Panel answered ERROR to ASTATUS. Either this panel does not support it, or the port is wedged by an open session. State is taken from events only until it answers.');
            }
        });
        // Without the status poll a TCP connect is all the proof we get.
        this.link.on('connected', () => this._online(!this.linkOptions.statusPoll));
        this.link.on('alive', () => this._online(true));
        this.link.on('disconnected', () => {
            this._offline('connection closed');
            // Events may have been missed while the link was down.
            if (this.unknown_after_reconnect) this._forgetState('connection to the panel closed');
        });
        this.link.on('poll-missed', () => {
            this._offline('panel not answering ASTATUS');
            this._statusFailed('did not answer');
        });
        this._offline('no answer from the panel since start-up');
        this.link.start();
    }

    // ── is the state known? ──────────────────────────────────────────────────
    isKnown(accessory) {
        return accessory.area_numbers.length > 0 && accessory.area_numbers.every(n => this.areasKnown.has(n));
    }

    _markKnown(n) {
        if (this.areasKnown.has(n)) return;
        this.areasKnown.add(n);
        if (this._areaNumbers().every(a => this.areasKnown.has(a))) {
            this._statusFailures = 0;
            if (this._unknownAlerted) {
                this._unknownAlerted = false;
                this.alerter.send('alarm state known again; Home shows the real state.');
            }
        }
    }

    _areaNumbers() {
        return [...new Set([...(this._areaAccessories || []).map(a => Number(a.zone_number)),
            ...(this._groupAccessories || []).flatMap(g => g.area_numbers)])];
    }

    _forgetState(reason) {
        if (this.areasKnown.size === 0) return;
        this.log.log(`Alarm state unknown until the panel answers again (${reason}); Home shows No Response meanwhile`);
        this.areasKnown.clear();
        this.areaStates.clear();
        this.areasArmed.clear();
        this.areasInEntry.clear();
        this.areasInExit.clear();
        for (const n of [...this._zoneTriggerTimers.keys()]) this._cancelZoneTriggers(n);
    }

    // ASTATUS answered ERROR or nothing. After state_alert_tries in a row with
    // an area still unknown, send an alert; Home keeps showing No Response.
    _statusFailed(what) {
        if (this._areaNumbers().every(n => this.areasKnown.has(n))) {
            this._statusFailures = 0;
            return;
        }
        this._statusFailures += 1;
        if (this._statusFailures >= this.state_alert_tries && !this._unknownAlerted) {
            this._unknownAlerted = true;
            this.log.error(`Alarm state still unknown: ASTATUS ${what} ${this._statusFailures} times. Home shows No Response until the panel answers or reports an arm/disarm.`);
            this.alerter.send(`cannot read the alarm state (ASTATUS ${what}, ${this._statusFailures} tries). Home shows the alarm as No Response until the panel answers or reports an arm/disarm.`);
        }
    }

    _safely(fn) {
        try {
            fn();
        } catch (err) {
            this.log.error(`Could not process panel message: ${err.stack || err.message}`);
        }
    }

    // ── offline watch (alerts when Home has been deaf for a while) ──────────
    _offline(reason) {
        if (this._shutting_down || this.offline_alert_ms <= 0 || this._offlineTimer) return;
        this._offlineSince = Date.now();
        this._offlineTimer = setTimeout(() => {
            this._offlineAlerted = true;
            this.alerter.send(`lost touch with the alarm panel for ${Math.round(this.offline_alert_ms / 60000)} min (${reason}). Home will not see an alarm until it is back.`);
        }, this.offline_alert_ms);
    }

    _online(answered) {
        if (!answered) return; // a TCP connect alone is not proof; wait for ASTATUS
        clearTimeout(this._offlineTimer);
        this._offlineTimer = null;
        if (this._offlineAlerted) {
            this._offlineAlerted = false;
            this.alerter.send(`alarm panel answering again after ${Math.round((Date.now() - this._offlineSince) / 60000)} min.`);
        }
    }

    // ── combined areas ───────────────────────────────────────────────────────
    refreshGroups() {
        const hap = this.hap;
        const Current = hap.Characteristic.SecuritySystemCurrentState;
        (this._groupAccessories || []).forEach(group => {
            if (!this.isKnown(group)) return;
            const states = group.area_numbers.map(n => this.areaStates.get(n));
            if (states.some(s => s === Current.ALARM_TRIGGERED)) {
                group.changeHandler(Current.ALARM_TRIGGERED);
                return;
            }
            const armed = states.filter(s => s !== undefined && s !== Current.DISARMED);
            if (states.length === 0 || armed.length !== states.length) {
                group.changeHandler(Current.DISARMED);
                return;
            }
            let stateValue;
            if (group.pending_target_state != null) stateValue = targetToCurrentState(hap.Characteristic, group.pending_target_state);
            else if (armed.every(s => s === armed[0])) stateValue = armed[0];
            else stateValue = Current.AWAY_ARM;
            group.changeHandler(stateValue);
        });
    }

    setAreaState(n, stateValue, user) {
        const area = this.findAreaAccessory(n);
        if (area) area.changeHandler(stateValue, user);
        // An Off is queued (login cooldown): keep Home on "Disarming..." even if
        // the panel's late "armed" event arrives meanwhile.
        if (area && this._queuedDisarm && area.showDisarming) area.showDisarming();
        this.areaStates.set(n, stateValue);
        this.refreshGroups();
    }

    clearPending(n) {
        const area = this.findAreaAccessory(n);
        if (area) {
            area.pending_target_state = null;
            clearTimeout(area.arm_confirm_timer);
            area.arm_requested_at = null;
            area.optimistic_armed_at = null;
        }
        (this._groupAccessories || []).forEach(g => {
            if (g.area_numbers.includes(n)) g.pending_target_state = null;
        });
    }

    // ── panel events ─────────────────────────────────────────────────────────
    handleEvent(ev) {
        const hap = this.hap;
        const Current = hap.Characteristic.SecuritySystemCurrentState;
        switch (ev.type) {
            case 'zone': return this.handleZone(ev);
            case 'entry':
                // Someone came in through the entry route: the panel is timing
                // the entry delay. Not an alarm; "L says if it becomes one.
                this.areasInEntry.add(ev.area);
                this._cancelZoneTriggers(ev.area);
                this.log.log(`Area ${ev.area} entry delay started`);
                return;
            case 'exit': {
                // Exit delay running. HomeKit shows "Arming..." while the
                // target is armed and the current state is not yet.
                this.areasInExit.set(ev.area, Date.now());
                this.log.log(`Area ${ev.area} exit delay started`);
                const area = this.findAreaAccessory(ev.area);
                if (area && this.areasKnown.has(ev.area)) area.showArming();
                return;
            }
            case 'user':
                this.log.debug(`Code entered at a keypad: ${ev.raw}`);
                return;
            case 'alarm':
                this.areasInEntry.delete(ev.area);
                this.areasInExit.delete(ev.area);
                this.log.log(`Area ${ev.area} triggered`);
                this._markKnown(ev.area);
                this.setAreaState(ev.area, Current.ALARM_TRIGGERED);
                return;
            case 'disarmed':
                this.areasInEntry.delete(ev.area);
                this.areasInExit.delete(ev.area);
                this._cancelZoneTriggers(ev.area);
                this.areasArmed.delete(ev.area);
                this.clearPending(ev.area);
                this.log.log(`Area ${ev.area} disarmed by User ${ev.user}`);
                this._markKnown(ev.area);
                this.setAreaState(ev.area, Current.DISARMED, ev.user);
                return;
            case 'armed': {
                this.areasInEntry.delete(ev.area);
                this.areasInExit.delete(ev.area);
                const area = this.findAreaAccessory(ev.area);
                const stateValue = resolveArmedState(this, area, ev.user, ev.area);
                if (stateValue == null) return;
                if (area) {
                    clearTimeout(area.arm_confirm_timer);
                    area.arm_requested_at = null;
                    area.optimistic_armed_at = null;
                }
                this.areasArmed.add(ev.area);
                this._markKnown(ev.area);
                this.setAreaState(ev.area, stateValue, ev.user);
                return;
            }
        }
    }

    handleZone(ev) {
        const Current = this.hap.Characteristic.SecuritySystemCurrentState;
        this.log.debug(`Zone update received for zone ${ev.zone} active: ${ev.active}`);
        const zone = (this._zoneAccessories || []).find(z => Number(z.zone_number) === ev.zone);
        if (zone) zone.changeHandler(ev.active);
        if (!ev.active || !this.zone_triggers_alarm) return;

        for (const area of this._areaAccessories) {
            const n = Number(area.zone_number);
            if (!area.zones.includes(pad(ev.zone, 3)) || !this.areasArmed.has(n)) continue;
            if (this.areasInEntry.has(n) || this.areasInExit.has(n)) {
                this.log.debug(`Zone ${ev.zone} active during the entry/exit delay for area ${n}, leaving it to the panel`);
                continue;
            }
            if (this.areaStates.get(n) === Current.ALARM_TRIGGERED || this._zoneTriggerTimers.has(n)) continue;
            // Give the panel a moment to say "E (entry route) or "L itself:
            // the door zone and the "E can arrive after the first PIR.
            this._zoneTriggerTimers.set(n, setTimeout(() => {
                this._zoneTriggerTimers.delete(n);
                if (!this.areasArmed.has(n) || this.areasInEntry.has(n) || this.areasInExit.has(n)) return;
                if (this.areaStates.get(n) === Current.ALARM_TRIGGERED) return;
                this.log.log(`Area ${n} manual triggered (zone ${ev.zone} active while armed)`);
                this.setAreaState(n, Current.ALARM_TRIGGERED);
            }, this.zone_trigger_grace_ms));
        }
    }

    _cancelZoneTriggers(n) {
        const t = this._zoneTriggerTimers.get(n);
        if (t) {
            clearTimeout(t);
            this._zoneTriggerTimers.delete(n);
        }
    }

    // ── real state from ASTATUS ──────────────────────────────────────────────
    handleAstatus(letters) {
        const Current = this.hap.Characteristic.SecuritySystemCurrentState;
        const first = !this._astatusSeen;
        this._astatusSeen = true;
        this._astatusErrorWarned = false;
        for (const n of this._areaNumbers()) {
            const st = P.astatusArea(letters, n);
            const shown = this.areaStates.get(n);
            const wasKnown = this.areasKnown.has(n);
            if (first) this.log.log(`Panel status: area ${n} ${st} (ASTATUS "${letters.join('')}")`);
            if (st === 'unknown') {
                this.log.debug(`ASTATUS letter for area ${n} not understood: "${letters.join('')}"`);
                continue;
            }
            if (st === 'armed') {
                this.areasArmed.add(n);
                this.areasInExit.delete(n);
                this._markKnown(n);
                const armedArea = this.findAreaAccessory(n);
                if (armedArea && armedArea.optimistic_armed_at) {
                    armedArea.optimistic_armed_at = null;
                    clearTimeout(armedArea.arm_confirm_timer);
                    armedArea.arm_requested_at = null;
                }
                if (shown === undefined || shown === Current.DISARMED) {
                    const area = armedArea;
                    if (area) {
                        clearTimeout(area.arm_confirm_timer);
                        area.arm_requested_at = null;
                    }
                    const stateValue = resolveArmedState(this, area, '?', n, 'ASTATUS');
                    if (stateValue != null) this.setAreaState(n, stateValue);
                }
                continue;
            }
            // disarmed
            const exitStarted = this.areasInExit.get(n);
            const area = this.findAreaAccessory(n);
            this._markKnown(n);
            if (exitStarted !== undefined && Date.now() - exitStarted < this.exit_max_ms) {
                // still arming: first time known, show Off with target armed
                if (!wasKnown) {
                    this.setAreaState(n, Current.DISARMED);
                    if (area) area.showArming();
                }
                continue;
            }
            const optimisticStale = !!(area && area.optimistic_armed_at && Date.now() - area.optimistic_armed_at >= this.optimistic_grace_ms);
            if (!optimisticStale && area && area.arm_requested_at && Date.now() - area.arm_requested_at < this.arm_confirm_ms) continue;
            if (optimisticStale) {
                this.log.error(`${area.name}: Home showed armed after the panel said OK, but ASTATUS says area ${n} is disarmed`);
                this.alerter.send(`the panel accepted the arm from HomeKit, but it now says ${area.name} is NOT armed. Home is corrected to Off. Check the keypad.`);
                area.optimistic_armed_at = null;
            }
            this.areasInExit.delete(n);
            this.areasArmed.delete(n);
            if (shown !== Current.DISARMED || (area && area.isArming())) {
                if (shown !== undefined) this.log.log(`ASTATUS says area ${n} is disarmed; HomeKit showed ${shown}, correcting it`);
                this.clearPending(n);
                this.setAreaState(n, Current.DISARMED);
            }
        }
    }

    // ── arm / disarm from HomeKit ────────────────────────────────────────────
    async requestTargetState(accessory, value) {
        const { Characteristic } = this.hap;
        const Target = Characteristic.SecuritySystemTargetState;
        const mask = P.areaMask(accessory.area_numbers);
        if (mask === null) throw new Error(`Area ${accessory.zone_number} is out of range (1-8)`);
        const maskChar = String.fromCharCode(mask);

        let letter;
        if (value === Target.AWAY_ARM) letter = this.away_arm_command;
        else if (value === Target.STAY_ARM || value === Target.NIGHT_ARM) letter = this.stay_arm_command;
        else if (value === Target.DISARM) letter = 'D';
        else throw new Error(`Unknown target state ${value}`);

        const label = { [Target.AWAY_ARM]: 'arm (away)', [Target.STAY_ARM]: 'arm (home)', [Target.NIGHT_ARM]: 'arm (night)', [Target.DISARM]: 'disarm' }[value];
        const where = `${accessory.name} (area ${accessory.zone_number})`;
        this.log.log(`HomeKit asked to ${label} ${where}`);

        // Off is never refused for timing: inside the login cooldown (e.g. just
        // after arming) it is queued and sent the moment the panel can take a
        // login. Home shows "Disarming..." until then. No alert unless it fails.
        if (value === Target.DISARM && this.isKnown(accessory) && this.link) {
            const wait = this.link.msUntilReady();
            if (wait > 0) {
                if (this._queuedDisarm) {
                    this.log.log(`HomeKit asked to ${label} ${where} again; already queued`);
                    return;
                }
                this.log.log(`HomeKit asked to ${label} ${where}; the panel can take a login in ${Math.ceil(wait / 1000)}s, disarming then`);
                this._queuedDisarm = setTimeout(() => {
                    this._queuedDisarm = null;
                    this.requestTargetState(accessory, value).catch(() => {
                        // requestTargetState has logged and alerted; put Home back to the real state
                        const Current = Characteristic.SecuritySystemCurrentState;
                        if (accessory.currentValue && accessory.currentValue() !== Current.DISARMED && accessory.showArming) accessory.showArming();
                    });
                }, wait + 250);
                return;
            }
        }

        if (!this.isKnown(accessory)) {
            const err = new Error('the alarm state has not been read from the panel yet');
            err.code = 'state-unknown';
            this.log.error(`Could not ${label} ${where}: ${err.message} (nothing sent to the panel)`);
            this.alerter.send(`HomeKit could not ${label} the alarm: ${err.message}. Check the keypad.`);
            throw err;
        }

        try {
            const res = await this.link.runCommand(`${letter}${maskChar}`, label);
            this.log.log(`Panel accepted ${label} for ${where}${res.loginOk ? '' : ' (login reply never came)'}`);
            this._lastCommand = { value, at: Date.now() };
        } catch (err) {
            const failFast = ['busy', 'cooldown', 'session-open', 'not-connected'].includes(err.code);
            this.log.error(`Could not ${label} ${where}: ${err.message}${failFast ? ' (nothing sent to the panel)' : ''}`);
            // An ignored repeat of the same request is harmless; anything else
            // means the alarm is not in the state the user just asked for.
            const sameAsLast = this._lastCommand && this._lastCommand.value === value && err.code === 'cooldown';
            if (!sameAsLast) {
                this.alerter.send(`HomeKit could not ${label} the alarm: ${err.message}. Check the keypad.`);
            }
            throw err;
        }

        const pending = value === Target.DISARM ? null : value;
        accessory.pending_target_state = pending;
        accessory.area_numbers.forEach(n => {
            const member = this.findAreaAccessory(n);
            if (member && member !== accessory) member.pending_target_state = pending;
        });

        if (value === Target.DISARM) {
            const Current = Characteristic.SecuritySystemCurrentState;
            for (const n of accessory.area_numbers) {
                this.areasArmed.delete(n);
                this.areasInExit.delete(n);
                this.areasInEntry.delete(n);
                this._cancelZoneTriggers(n);
                this.clearPending(n);
                this.setAreaState(n, Current.DISARMED);
            }
            if (accessory.kind === 'group') accessory.changeHandler(Current.DISARMED);
            return;
        }

        // Armed is only shown once the panel says so ("A at the end of the exit
        // delay, or ASTATUS). Until then HomeKit shows "Arming...".
        const targets = accessory.kind === 'group' ? accessory.area_numbers.map(n => this.findAreaAccessory(n)).filter(Boolean) : [accessory];
        for (const area of targets) {
            area.arm_requested_at = Date.now();
            clearTimeout(area.arm_confirm_timer);
            if (this.arm_confirm_ms > 0) {
                area.arm_confirm_timer = setTimeout(() => {
                    area.arm_requested_at = null;
                    if (this.areasArmed.has(Number(area.zone_number))) return;
                    this.log.error(`${area.name}: panel accepted ${label} but has not reported armed after ${this.arm_confirm_ms / 1000}s`);
                    this.alerter.send(`the panel accepted "${label}" from HomeKit but has not reported ${area.name} armed after ${Math.round(this.arm_confirm_ms / 60000)} min. Check the keypad.`);
                }, this.arm_confirm_ms);
            }
        }

        if (this.show_armed_on_accept) {
            const shownState = targetToCurrentState(Characteristic, value);
            for (const area of targets) {
                area.optimistic_armed_at = Date.now();
                this.setAreaState(Number(area.zone_number), shownState);
            }
            this.log.log(`${where}: showing ${label} in Home on the panel's OK (its own "armed" event follows in ~30 s)`);
        }
    }
}

// ─── Working out what "armed" means (upstream) ──────────────────────────────
function resolveArmedState(platform, area, user, updated_area, source) {
    const Characteristic = platform.hap.Characteristic;
    const user_number = normaliseUser(user);
    const via = source ? ` (${source})` : ` by User ${user}`;

    if (user_number !== null && platform.remote_users.includes(user_number)) {
        platform.log.log(`Area ${updated_area} armed (away) by remote User ${user}`);
        return Characteristic.SecuritySystemCurrentState.AWAY_ARM;
    }
    const pending = area ? area.pending_target_state : null;
    if (pending != null) {
        const stateValue = targetToCurrentState(Characteristic, pending);
        if (stateValue == null) {
            platform.log.error(`Unknown target state: ${pending}`);
            return null;
        }
        platform.log.log(`Area ${updated_area} armed${via}, using the state requested from HomeKit (${stateValue})`);
        return stateValue;
    }
    switch (platform.default_arm_state) {
        case 'night':
            platform.log.log(`Area ${updated_area} armed (night)${via}`);
            return Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
        case 'stay':
        case 'home':
            platform.log.log(`Area ${updated_area} armed (home)${via}`);
            return Characteristic.SecuritySystemCurrentState.STAY_ARM;
        default:
            platform.log.log(`Area ${updated_area} armed (away)${via}`);
            return Characteristic.SecuritySystemCurrentState.AWAY_ARM;
    }
}

function targetToCurrentState(Characteristic, targetState) {
    const T = Characteristic.SecuritySystemTargetState, C = Characteristic.SecuritySystemCurrentState;
    switch (targetState) {
        case T.AWAY_ARM: return C.AWAY_ARM;
        case T.STAY_ARM: return C.STAY_ARM;
        case T.NIGHT_ARM: return C.NIGHT_ARM;
        case T.DISARM: return C.DISARMED;
        default: return null;
    }
}

function currentToTargetState(Characteristic, currentState) {
    const T = Characteristic.SecuritySystemTargetState, C = Characteristic.SecuritySystemCurrentState;
    switch (currentState) {
        case C.NIGHT_ARM: return T.NIGHT_ARM;
        case C.AWAY_ARM: return T.AWAY_ARM;
        case C.STAY_ARM: return T.STAY_ARM;
        case C.DISARMED: return T.DISARM;
        default: return null;
    }
}

const TARGET_STATE_NAMES = { away: 'AWAY_ARM', home: 'STAY_ARM', stay: 'STAY_ARM', night: 'NIGHT_ARM', off: 'DISARM', disarm: 'DISARM' };

function parseTargetStates(Characteristic, value, log, name) {
    const Target = Characteristic.SecuritySystemTargetState;
    const all = [Target.STAY_ARM, Target.AWAY_ARM, Target.NIGHT_ARM, Target.DISARM];
    if (value === null || value === undefined || value === '') return all;
    const names = Array.isArray(value) ? value : String(value).split(',');
    const offered = new Set([Target.DISARM]);
    names.forEach(n => {
        const key = TARGET_STATE_NAMES[String(n).trim().toLowerCase()];
        if (key) offered.add(Target[key]);
        else log.error(`${name}: unknown arm mode "${n}" in target_states, use away, home, night or off`);
    });
    if (offered.size === 1) {
        log.error(`${name}: target_states offers no way to arm, offering every mode instead`);
        return all;
    }
    return all.filter(v => offered.has(v));
}

function offeredArmState(Characteristic, offered) {
    const Target = Characteristic.SecuritySystemTargetState;
    if (offered.includes(Target.AWAY_ARM)) return Target.AWAY_ARM;
    return offered.find(v => v !== Target.DISARM);
}

function parseUserList(value) {
    if (value === null || value === undefined || value === '') return [];
    const values = Array.isArray(value) ? value : String(value).split(',');
    return values.map(normaliseUser).filter(v => v !== null);
}

function normaliseUser(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const n = Number(String(value).trim());
    return Number.isNaN(n) ? null : n;
}

function pad(value, width) {
    return String(value).padStart(width, '0');
}

// ─── Accessory (upstream, trimmed to bridged accessories) ───────────────────
const MODELS = { zone: 'Zone', area: 'Area', group: 'Combined Area' };

function TexecomAccessory(log, config, hap, kind) {
    this.log = log;
    this.hap = hap;
    this.kind = kind || 'zone';
    this.name = config.name;
    this.dwell_time = config.dwell || 0;
    this.dwell_timer = null;
    this.target_states = config.target_states;
    this.pending_target_state = null;
    this.arm_requested_at = null;
    this.arm_confirm_timer = null;

    if (this.kind === 'group') {
        this.area_numbers = (config.areas || []).map(Number).filter(n => !Number.isNaN(n));
        this.zone_number = this.area_numbers.join('+');
        this.zone_type = 'securitysystem';
    } else {
        this.zone_number = pad(config.zone_number || config.area_number, 3);
        this.zone_type = this.kind === 'area' ? 'securitysystem' : (config.zone_type || 'motion');
        this.area_numbers = this.zone_type === 'securitysystem' ? [Number(this.zone_number)] : [];
    }

    this.changeHandler = function () { };
    this.showArming = function () { };
    this.showDisarming = function () { };
    this.isArming = function () { return false; };

    if (Array.isArray(config.zones)) this.zones = config.zones.map(z => pad(z, 3));
    else if (config.zones !== null && config.zones !== undefined && config.zones !== '') this.zones = [pad(config.zones, 3)];
    else this.zones = [];

    if (config.sn) {
        this.sn = config.sn;
    } else {
        const shasum = crypto.createHash('sha1');
        shasum.update(this.kind === 'group' ? `group:${this.zone_number}`
            : this.zone_type === 'securitysystem' ? `area:${this.zone_number}` : this.zone_number);
        this.sn = shasum.digest('base64');
    }
}

TexecomAccessory.prototype.setupServices = function (hapAccessory, platform) {
    const { Service, Characteristic } = this.hap;
    const me = this;
    const hap = this.hap;
    this._platform = platform;

    hapAccessory.getService(Service.AccessoryInformation)
        .setCharacteristic(Characteristic.Name, this.name)
        .setCharacteristic(Characteristic.Manufacturer, 'Texecom')
        .setCharacteristic(Characteristic.Model, `Texecom ${MODELS[this.kind] || 'Zone'}`)
        .setCharacteristic(Characteristic.SerialNumber, this.sn);

    let ServiceType;
    switch (this.zone_type) {
        case 'contact': ServiceType = Service.ContactSensor; break;
        case 'smoke': ServiceType = Service.SmokeSensor; break;
        case 'carbonmonoxide': ServiceType = Service.CarbonMonoxideSensor; break;
        case 'securitysystem': ServiceType = Service.SecuritySystem; break;
        default: ServiceType = Service.MotionSensor;
    }
    hapAccessory.services
        .filter(s => s.UUID !== Service.AccessoryInformation.UUID && s.UUID !== ServiceType.UUID)
        .forEach(s => hapAccessory.removeService(s));
    const service = hapAccessory.getService(ServiceType) || hapAccessory.addService(ServiceType, this.name);

    let changeAction;
    switch (this.zone_type) {
        case 'contact':
            changeAction = (on) => service.getCharacteristic(Characteristic.ContactSensorState).updateValue(on
                ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED : Characteristic.ContactSensorState.CONTACT_DETECTED);
            break;
        case 'smoke':
            changeAction = (on) => service.getCharacteristic(Characteristic.SmokeDetected).updateValue(on
                ? Characteristic.SmokeDetected.SMOKE_DETECTED : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED);
            break;
        case 'carbonmonoxide':
            changeAction = (on) => service.getCharacteristic(Characteristic.CarbonMonoxideDetected).updateValue(on
                ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL : Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL);
            break;
        case 'securitysystem': {
            const Target = Characteristic.SecuritySystemTargetState;
            const Current = Characteristic.SecuritySystemCurrentState;
            const offered = parseTargetStates(Characteristic,
                this.target_states != null ? this.target_states : (platform && platform.target_states), me.log, me.name);
            this.offered = offered;
            const targetChar = service.getCharacteristic(Target);
            const currentChar = service.getCharacteristic(Current);
            // Set the props without pushing a state. The value held here is
            // never shown while unknown (onGet below throws).
            if (!offered.includes(targetChar.value)) targetChar.value = offered[0];
            targetChar.setProps({ validValues: offered });

            changeAction = function (newState) {
                const asked = currentToTargetState(Characteristic, newState);
                if (asked != null && !offered.includes(asked)) {
                    newState = targetToCurrentState(Characteristic, offeredArmState(Characteristic, offered));
                }
                const targetState = currentToTargetState(Characteristic, newState);
                // updateValue, never setValue: setValue would send it back to the panel.
                if (targetState != null) targetChar.updateValue(targetState);
                currentChar.updateValue(newState);
                me.log.debug(`${me.name}: target ${targetState}, current ${newState}`);
                hapAccessory.context.texecom_state = newState;
            };

            // Exit delay: target armed, current unchanged -> Home shows "Arming...".
            this.showArming = function () {
                let want = me.pending_target_state;
                if (want == null || !offered.includes(want)) want = offeredArmState(Characteristic, offered);
                targetChar.updateValue(want);
            };
            this.showDisarming = function () {
                if (currentChar.value !== Current.DISARMED) targetChar.updateValue(Target.DISARM);
            };
            this.isArming = function () {
                return targetChar.value !== Target.DISARM && currentChar.value === Current.DISARMED;
            };
            this.currentValue = () => currentChar.value;
            this.targetValue = () => targetChar.value;

            const failure = () => hap.HapStatusError
                ? new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE) : new Error('Command failed');

            // No state from the cache. Until the panel has told us, reads get
            // No Response rather than a guess.
            const known = () => !!(me._platform && me._platform.isKnown && me._platform.isKnown(me));
            currentChar.onGet(() => {
                if (!known()) throw failure();
                return currentChar.value;
            });
            targetChar.onGet(() => {
                if (!known()) throw failure();
                return targetChar.value;
            });

            targetChar.onSet(async (value) => {
                const p = me._platform;
                if (!offered.includes(value)) {
                    me.log.error(`${me.name}: arm mode ${value} is not one target_states offers, ignoring it`);
                    throw hap.HapStatusError ? new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST) : new Error('Arm mode not offered');
                }
                if (!p || p.udl == null || !p.link) {
                    me.log.error('No UDL configured (or no panel link). Add the UDL to arm and disarm from HomeKit.');
                    throw failure();
                }
                try {
                    await p.requestTargetState(me, value);
                } catch (err) {
                    // Put the target back to what the panel is really doing, so
                    // the Home app does not sit on "Arming..." for a command
                    // that never went through.
                    setTimeout(() => {
                        if (!known()) return;
                        const back = currentToTargetState(Characteristic, currentChar.value);
                        if (back != null) targetChar.updateValue(back);
                    }, 100);
                    throw failure();
                }
            });
            break;
        }
        default:
            changeAction = (on) => service.getCharacteristic(Characteristic.MotionDetected).updateValue(on);
    }

    this.changeHandler = function (status, user) {
        if (me.dwell_timer) {
            clearTimeout(me.dwell_timer);
            me.dwell_timer = null;
        }
        if (!status && me.dwell_time > 0) {
            me.dwell_timer = setTimeout(() => {
                me.dwell_timer = null;
                changeAction(status);
            }, me.dwell_time);
        } else {
            changeAction(status);
        }
        me.log.debug(`${me.name}: state ${status}${user ? ` by User ${user}` : ''}`);
    };
    return service;
};

module.exports.TexecomPlatform = TexecomPlatform;
module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.PLATFORM_NAME = PLATFORM_NAME;
module.exports.UUID_NAMESPACE = UUID_NAMESPACE;
