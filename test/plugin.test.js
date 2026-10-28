'use strict';
// The Homebridge platform end to end against the fake panel, with the real
// HAP-NodeJS characteristics (from the Homebridge install) and a stub API.
// Config is an example two-bedroom house with a dummy UDL.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { FakePanel } = require('./fake-panel');

const HAP_PATH = process.env.HAP_NODEJS || '/usr/local/lib/node_modules/homebridge/node_modules/@homebridge/hap-nodejs';
let hap;
try {
    hap = require(HAP_PATH);
    hap.HAPStorage.setCustomStoragePath(fs.mkdtempSync(path.join(os.tmpdir(), 'hap-')));
} catch (e) {
    hap = null;
}
const C = hap && hap.Characteristic;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function waitFor(pred, ms = 3000, step = 10) {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
            if (pred()) return resolve();
            if (Date.now() - t0 > ms) return reject(new Error('waitFor timed out'));
            setTimeout(tick, step);
        };
        tick();
    });
}

const EXAMPLE_CONFIG = {
    name: 'Texecom', platform: 'TexecomLocal', ip_address: '127.0.0.1', ip_port: 0, baud_rate: 19200, udl: '1234',
    zones: [
        { name: 'Entrance Door', zone_number: '1', zone_type: 'contact', dwell: 0 },
        { name: 'Entrance', zone_number: '2', zone_type: 'motion', dwell: 0 },
        { name: 'Bedroom 2', zone_number: '3', zone_type: 'motion', dwell: 0 },
        { name: 'Bedroom 3', zone_number: '4', zone_type: 'motion', dwell: 0 },
        { name: 'Main Hallway', zone_number: '5', zone_type: 'motion', dwell: 0 },
        { name: 'Lounge', zone_number: '6', zone_type: 'motion', dwell: 0 },
        { name: 'Main Bedroom', zone_number: '7', zone_type: 'motion', dwell: 0 },
    ],
    areas: [{ name: 'House Alarm', area_number: '1', area_type: 'securitysystem', dwell: 0, zones: [2, 3, 4, 5, 6, 7] }],
    debug: false,
};

function makeApi() {
    const api = new EventEmitter();
    api.hap = hap;
    api.registered = [];
    api.platformAccessory = class {
        constructor(name, uuid) {
            this.displayName = name;
            this.UUID = uuid;
            this.context = {};
            this._a = new hap.Accessory(name, uuid);
        }
        getService(t) { return this._a.getService(t); }
        addService(...a) { return this._a.addService(...a); }
        removeService(s) { return this._a.removeService(s); }
        get services() { return this._a.services; }
    };
    api.registerPlatform = (plugin, platform, ctor) => { api.ctor = ctor; api.names = [plugin, platform]; };
    api.registerPlatformAccessories = (p, n, accs) => api.registered.push(...accs);
    api.updatePlatformAccessories = () => { };
    api.unregisterPlatformAccessories = () => { };
    return api;
}

function makeLog() {
    const lines = [];
    const f = (lvl) => (...a) => lines.push(`${lvl} ${a.join(' ')}`);
    return { lines, info: f('INFO'), warn: f('WARN'), error: f('ERROR'), debug: f('DEBUG') };
}

async function start(panelOpts = {}, cfg = {}, cached = []) {
    const panel = new FakePanel(panelOpts);
    const port = await panel.listen();
    if (panelOpts.armed) panel.areas[0] = 'Y';
    const alertFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alert-')), 'alerts.txt');
    const api = makeApi();
    require('../plugin/index.js')(api);
    const log = makeLog();
    const config = Object.assign({}, EXAMPLE_CONFIG, {
        ip_port: port,
        alert_command: `printf '%s\\n' "$1" >> '${alertFile}'`,
        zone_trigger_grace: 0.15,
        alert_min_interval: 0,
        _linkOverrides: {
            loginRetryAfterMs: 150, loginSettleMs: 30, loginTimeoutMs: 300, commandTimeoutMs: 300, logoutAckTimeoutMs: 200, loginCooldownMs: 1000,
            sessionIdleMs: 800, postLogoutQuietMs: 50, pollIntervalMs: 200, initialPollDelayMs: 20,
            pollReplyTimeoutMs: 150, preflightTimeoutMs: 150, reconnectDelayMs: 100,
        },
    }, cfg, { _linkOverrides: Object.assign({
            loginRetryAfterMs: 150, loginSettleMs: 30, loginTimeoutMs: 300, commandTimeoutMs: 300, logoutAckTimeoutMs: 200, loginCooldownMs: 1000,
            sessionIdleMs: 800, postLogoutQuietMs: 50, pollIntervalMs: 200, initialPollDelayMs: 20,
            pollReplyTimeoutMs: 150, preflightTimeoutMs: 150, reconnectDelayMs: 100,
        }, cfg._linkOverrides || {}) });
    const platform = new api.ctor(log, config, api);
    for (const c of cached) platform.configureAccessory(c);
    const connected = new Promise(r => panel.once('client', r));
    api.emit('didFinishLaunching');
    await connected;
    const alarm = api.registered.find(a => a.displayName === 'House Alarm') || cached.find(a => a.displayName === 'House Alarm');
    const svc = alarm.getService(hap.Service.SecuritySystem);
    const cur = () => svc.getCharacteristic(C.SecuritySystemCurrentState).value;
    const tgt = () => svc.getCharacteristic(C.SecuritySystemTargetState).value;
    const set = (v) => svc.getCharacteristic(C.SecuritySystemTargetState).handleSetRequest(v);
    const alerts = () => (fs.existsSync(alertFile) ? fs.readFileSync(alertFile, 'utf8') : '');
    const done = async () => {
        api.emit('shutdown');
        await panel.close();
    };
    return { panel, api, platform, log, svc, cur, tgt, set, alerts, done, alarm };
}

const skip = hap ? false : `HAP-NodeJS not found at ${HAP_PATH}`;

test('platform registers as homebridge-texecom-local / TexecomLocal, UUIDs as upstream "Texecom:<name>"', { skip }, async () => {
    const t = await start();
    try {
        assert.deepStrictEqual(t.api.names, ['homebridge-texecom-local', 'TexecomLocal']);
        assert.strictEqual(t.alarm.UUID, hap.uuid.generate('Texecom:House Alarm'));
        assert.strictEqual(t.api.registered.length, 8);
    } finally { await t.done(); }
});

test('default target_states offer Away and Off only', { skip }, async () => {
    const t = await start();
    try {
        const props = t.svc.getCharacteristic(C.SecuritySystemTargetState).props.validValues;
        assert.deepStrictEqual(props, [C.SecuritySystemTargetState.AWAY_ARM, C.SecuritySystemTargetState.DISARM]);
    } finally { await t.done(); }
});

test('startup: HomeKit takes the real state from ASTATUS (cache said disarmed, panel armed)', { skip }, async () => {
    const t = await start({ armed: true });
    try {
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.AWAY_ARM);
        assert.strictEqual(t.tgt(), C.SecuritySystemTargetState.AWAY_ARM);
        assert.ok(t.log.lines.some(l => /Panel status: area 1 armed/.test(l)));
    } finally { await t.done(); }
});

test('ASTATUS corrects a missed disarm ("D lost): Home showed Away, panel says N', { skip }, async () => {
    const t = await start({ armed: true });
    try {
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.AWAY_ARM);
        t.panel.areas[0] = 'N';  // disarmed at the keypad, the "D never arrived
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.DISARMED);
        assert.strictEqual(t.tgt(), C.SecuritySystemTargetState.DISARM);
    } finally { await t.done(); }
});

test('exit: "X shows Arming (target Away, current Off), then "A shows Away', { skip }, async () => {
    const t = await start();
    try {
        await sleep(80);
        t.panel.event('"X0010');
        await waitFor(() => t.tgt() === C.SecuritySystemTargetState.AWAY_ARM);
        assert.strictEqual(t.cur(), C.SecuritySystemCurrentState.DISARMED);
        // ASTATUS still says N during the exit delay; that must not cancel Arming.
        await sleep(450);
        assert.strictEqual(t.tgt(), C.SecuritySystemTargetState.AWAY_ARM);
        t.panel.areas[0] = 'Y';
        t.panel.event('"A0011');
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.AWAY_ARM);
        // Zones moving during the exit delay never raised an alarm.
        assert.ok(!t.log.lines.some(l => /triggered/.test(l)));
    } finally { await t.done(); }
});

test('entry: "E then PIR -> no Triggered; PIR first and "E just after -> still no Triggered', { skip }, async () => {
    const t = await start({ armed: true });
    try {
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.AWAY_ARM);
        t.panel.event('"Z0011');      // door
        t.panel.event('"E0010');
        t.panel.event('"Z0021');      // entrance PIR
        await sleep(300);
        assert.strictEqual(t.cur(), C.SecuritySystemCurrentState.AWAY_ARM);
        t.panel.areas[0] = 'N';
        t.panel.event('"D00103');
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.DISARMED);

        // again, with the PIR reported before the "E (coalescing/ordering)
        t.panel.areas[0] = 'Y';
        t.panel.event('"A00103');
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.AWAY_ARM);
        t.panel.sendRaw('"Z0021\r\n');
        await sleep(50);
        t.panel.sendRaw('"E0010\r\n');
        await sleep(300);
        assert.strictEqual(t.cur(), C.SecuritySystemCurrentState.AWAY_ARM);
        assert.ok(!t.log.lines.some(l => /triggered/.test(l)), t.log.lines.join('\n'));
    } finally { await t.done(); }
});

test('a PIR while armed with no entry delay does show Triggered; "L always does', { skip }, async () => {
    const t = await start({ armed: true });
    try {
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.AWAY_ARM);
        t.panel.event('"Z0061');
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.ALARM_TRIGGERED);
        t.panel.areas[0] = 'N';
        t.panel.event('"D00103');
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.DISARMED);
        t.panel.areas[0] = 'Y';
        t.panel.event('"A00103');
        t.panel.event('"L001');
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.ALARM_TRIGGERED);
    } finally { await t.done(); }
});

test('HomeKit Away: \\W twice (as 4.4.0), A, logout; Arming until the panel reports "A; no alert', { skip }, async () => {
    const t = await start({ exitMs: 200 }, { show_armed_on_accept: false });
    try {
        await sleep(80);
        await t.set(C.SecuritySystemTargetState.AWAY_ARM);
        assert.strictEqual(t.panel.logins, 2);
        assert.strictEqual(t.panel.count('text', b => b === 'A\x01'), 1);
        assert.strictEqual(t.panel.count('binary'), 1);
        assert.strictEqual(t.cur(), C.SecuritySystemCurrentState.DISARMED, 'not shown armed on OK alone');
        assert.strictEqual(t.tgt(), C.SecuritySystemTargetState.AWAY_ARM);
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.AWAY_ARM);
        assert.ok(t.log.lines.some(l => /exit delay started/.test(l)));
        assert.strictEqual(t.alerts(), '');
    } finally { await t.done(); }
});

test('HomeKit Away (default show_armed_on_accept): Away on the panel OK, "A later keeps it; no alert', { skip }, async () => {
    const t = await start({ exitMs: 300 });
    try {
        await sleep(80);
        await t.set(C.SecuritySystemTargetState.AWAY_ARM);
        assert.strictEqual(t.cur(), C.SecuritySystemCurrentState.AWAY_ARM, 'Away straight after OK');
        assert.strictEqual(t.tgt(), C.SecuritySystemTargetState.AWAY_ARM);
        await waitFor(() => t.log.lines.some(l => /armed by User 29/.test(l)));
        await sleep(400);
        assert.strictEqual(t.cur(), C.SecuritySystemCurrentState.AWAY_ARM, 'still Away after X/A and ASTATUS');
        assert.strictEqual(t.alerts(), '');
    } finally { await t.done(); }
});

test('panel says OK but never arms: Away shown, then ASTATUS corrects to Off after the grace + alert', { skip }, async () => {
    const t = await start({ armTakes: false }, { optimistic_grace_seconds: 0.4 });
    try {
        await sleep(80);
        await t.set(C.SecuritySystemTargetState.AWAY_ARM);
        assert.strictEqual(t.cur(), C.SecuritySystemCurrentState.AWAY_ARM);
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.DISARMED, 3000);
        assert.strictEqual(t.tgt(), C.SecuritySystemTargetState.DISARM);
        await waitFor(() => /NOT armed/.test(t.alerts()), 2000);
    } finally { await t.done(); }
});

test('Off tapped inside the login cooldown (just after Away) is queued, then disarms; repeat taps send one D; no alert', { skip }, async () => {
    const t = await start({ exitMs: 100 }, {}, []);
    try {
        await sleep(80);
        await t.set(C.SecuritySystemTargetState.AWAY_ARM);
        assert.strictEqual(t.cur(), C.SecuritySystemCurrentState.AWAY_ARM);
        await t.set(C.SecuritySystemTargetState.DISARM);
        await t.set(C.SecuritySystemTargetState.DISARM);
        assert.strictEqual(t.panel.count('text', b => b === 'D\x01'), 0, 'nothing sent inside the cooldown');
        // the panel's late "A arrives while Off is queued: target must stay Off (Disarming...), never flip back to Away
        await waitFor(() => t.log.lines.some(l => /armed by User 29/.test(l)));
        assert.strictEqual(t.tgt(), C.SecuritySystemTargetState.DISARM, 'still Disarming after the late "A');
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.DISARMED, 4000);
        assert.strictEqual(t.panel.count('text', b => b === 'D\x01'), 1);
        assert.strictEqual(t.alerts(), '');
    } finally { await t.done(); }
});

test('HomeKit Off: disarm shows Off on OK', { skip }, async () => {
    const t = await start({ armed: true });
    try {
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.AWAY_ARM);
        await t.set(C.SecuritySystemTargetState.DISARM);
        assert.strictEqual(t.cur(), C.SecuritySystemCurrentState.DISARMED);
    } finally { await t.done(); }
});

test('failed arm (no reply): logged at normal level, alert command run, HomeKit No Response', { skip }, async () => {
    const t = await start({ commandReply: 'silent' });
    try {
        await sleep(80);
        await assert.rejects(t.set(C.SecuritySystemTargetState.AWAY_ARM), (e) => (e && e.hapStatus !== undefined ? e.hapStatus : e) === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        assert.ok(t.log.lines.some(l => /^ERROR Could not arm \(away\) House Alarm/.test(l)), t.log.lines.join('\n'));
        await waitFor(() => /could not arm \(away\) the alarm: no reply/.test(t.alerts()));
        await sleep(150);
        assert.strictEqual(t.tgt(), C.SecuritySystemTargetState.DISARM, 'target put back');
        assert.strictEqual(t.panel.logins, 2);
    } finally { await t.done(); }
});

test('extra arm taps fail fast inside the cooldown without an alert; Off is queued, not refused', { skip }, async () => {
    const t = await start();
    try {
        await sleep(80);
        await t.set(C.SecuritySystemTargetState.AWAY_ARM);
        const t0 = Date.now();
        await assert.rejects(t.set(C.SecuritySystemTargetState.AWAY_ARM));
        assert.ok(Date.now() - t0 < 100, 'fast');
        await t.set(C.SecuritySystemTargetState.DISARM);
        assert.strictEqual(t.panel.logins, 2, 'no second login sequence inside the cooldown');
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.DISARMED, 4000);
        assert.ok(!/could not/.test(t.alerts()));
    } finally { await t.done(); }
});

test('alerts can be switched off (alert_command: "")', { skip }, async () => {
    const t = await start({ commandReply: 'silent' }, { alert_command: '' });
    try {
        await sleep(80);
        await assert.rejects(t.set(C.SecuritySystemTargetState.AWAY_ARM));
        await sleep(100);
        assert.ok(t.log.lines.some(l => /Could not arm/.test(l)));
        assert.ok(!t.log.lines.some(l => /Alert sent/.test(l)));
    } finally { await t.done(); }
});

test('panel silent -> reconnect, and an offline alert after the configured time', { skip }, async () => {
    const t = await start({}, { alert_after_offline_minutes: 0.01 });
    try {
        await waitFor(() => t.panel.count('line') >= 1);
        t.panel.mute = true;
        await waitFor(() => t.panel.connections >= 2, 3000);
        await waitFor(() => /lost touch with the alarm panel/.test(t.alerts()), 3000);
        t.panel.mute = false;
        await waitFor(() => /answering again/.test(t.alerts()), 3000);
    } finally { await t.done(); }
});

test('panel unreachable from start-up -> offline alert', { skip }, async () => {
    const t = await start({}, { alert_after_offline_minutes: 0.01 });
    try {
        t.panel.mute = true;   // connected, but never answers
        await waitFor(() => /lost touch with the alarm panel/.test(t.alerts()), 3000);
    } finally { await t.done(); }
});

test('all 8 accessory UUIDs use the upstream "Texecom:<name>" seed (no HomeKit re-creation on switch-over)', { skip }, async () => {
    const t = await start();
    try {
        const names = EXAMPLE_CONFIG.zones.map(z => z.name).concat(EXAMPLE_CONFIG.areas.map(a => a.name));
        for (const acc of t.api.registered) assert.strictEqual(acc.UUID, hap.uuid.generate(`Texecom:${acc.displayName}`), acc.displayName);
        assert.deepStrictEqual(t.api.registered.map(a => a.displayName).sort(), names.sort());
    } finally { await t.done(); }
});

// ── unknown state until the panel says (never start from the cache) ─────────

// A cached House Alarm showing Off (the stale-cache failure case).
function cachedOffAlarm() {
    const api = makeApi();
    const acc = new api.platformAccessory('House Alarm', hap.uuid.generate('Texecom:House Alarm'));
    const s = acc.addService(hap.Service.SecuritySystem, 'House Alarm');
    s.getCharacteristic(C.SecuritySystemCurrentState).value = C.SecuritySystemCurrentState.DISARMED;
    s.getCharacteristic(C.SecuritySystemTargetState).value = C.SecuritySystemTargetState.DISARM;
    acc.context.texecom_state = C.SecuritySystemCurrentState.DISARMED;
    // Spy on every value pushed to HomeKit from the moment the plugin sees it,
    // including a push of Off over the cached Off (which fires no change event).
    acc.pushes = [];
    for (const ch of [C.SecuritySystemCurrentState, C.SecuritySystemTargetState]) {
        const c = s.getCharacteristic(ch);
        const orig = c.updateValue.bind(c);
        c.updateValue = (v, ...rest) => { acc.pushes.push([ch.name || 'char', v]); return orig(v, ...rest); };
    }
    return acc;
}

// Every value the plugin has pushed to HomeKit for the cached alarm.
const recorder = (t) => t.alarm.pushes;
const isOff = ([, v]) => v === C.SecuritySystemCurrentState.DISARMED;  // 3 = DISARMED = DISARM
const noResponse = (e) => (e && e.hapStatus !== undefined ? e.hapStatus : e) === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
const getCur = (t) => t.svc.getCharacteristic(C.SecuritySystemCurrentState).handleGetRequest();
const getTgt = (t) => t.svc.getCharacteristic(C.SecuritySystemTargetState).handleGetRequest();

test('required (1): cache Off + panel armed -> never reports Off; No Response until ASTATUS, then Away', { skip }, async () => {
    const t = await start({ armed: true }, { _linkOverrides: { initialPollDelayMs: 300 } }, [cachedOffAlarm()]);
    try {
        const seen = recorder(t);
        await assert.rejects(getCur(t), noResponse);
        await assert.rejects(getTgt(t), noResponse);
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.AWAY_ARM, 3000);
        assert.strictEqual(await getCur(t), C.SecuritySystemCurrentState.AWAY_ARM);
        assert.strictEqual(await getTgt(t), C.SecuritySystemTargetState.AWAY_ARM);
        assert.ok(!seen.some(isOff), `pushed Off: ${JSON.stringify(seen)}`);
        assert.ok(seen.length >= 1, 'Away was pushed');
    } finally { await t.done(); }
});

test('required (2): ASTATUS never answers -> get throws, alert sent, never Off', { skip }, async () => {
    const t = await start({}, { _linkOverrides: { initialPollDelayMs: 200 } }, [cachedOffAlarm()]);
    try {
        t.panel.mute = true;
        const seen = recorder(t);
        await waitFor(() => /cannot read the alarm state \(ASTATUS did not answer/.test(t.alerts()), 3000);
        await assert.rejects(getCur(t), noResponse);
        await assert.rejects(getTgt(t), noResponse);
        await sleep(500);
        await assert.rejects(getCur(t), noResponse);
        assert.ok(!seen.some(isOff), `pushed Off: ${JSON.stringify(seen)}`);
        assert.ok(t.log.lines.some(l => /^ERROR Alarm state still unknown/.test(l)));
    } finally { await t.done(); }
});

test('required (3): ASTATUS ERROR -> No Response + alert; then an "A event -> Away', { skip }, async () => {
    const t = await start({ astatus: false }, {}, [cachedOffAlarm()]);
    try {
        const seen = recorder(t);
        await waitFor(() => /cannot read the alarm state \(ASTATUS answered ERROR/.test(t.alerts()), 3000);
        await assert.rejects(getCur(t), noResponse);
        assert.ok(!seen.some(isOff));
        t.panel.event('"A00103');
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.AWAY_ARM);
        assert.strictEqual(await getCur(t), C.SecuritySystemCurrentState.AWAY_ARM);
        assert.ok(!seen.some(isOff), `pushed Off: ${JSON.stringify(seen)}`);
        await waitFor(() => /alarm state known again/.test(t.alerts()));
    } finally { await t.done(); }
});

test('taps before the state is known fail fast: nothing sent to the panel, alert sent', { skip }, async () => {
    const t = await start({}, { _linkOverrides: { initialPollDelayMs: 400 } }, [cachedOffAlarm()]);
    try {
        const t0 = Date.now();
        await assert.rejects(t.set(C.SecuritySystemTargetState.AWAY_ARM), noResponse);
        assert.ok(Date.now() - t0 < 100);
        assert.strictEqual(t.panel.logins, 0);
        assert.strictEqual(t.panel.received.filter(r => r.kind !== 'line').length, 0);
        await waitFor(() => /not been read from the panel yet/.test(t.alerts()));
    } finally { await t.done(); }
});

test('after a reconnect the state is unknown again until ASTATUS answers', { skip }, async () => {
    const t = await start({ armed: true });
    try {
        await waitFor(() => t.cur() === C.SecuritySystemCurrentState.AWAY_ARM);
        t.panel.client.destroy();
        await waitFor(() => t.log.lines.some(l => /Alarm state unknown until the panel answers again/.test(l)));
        await assert.rejects(getCur(t), noResponse);
        await waitFor(() => t.panel.connections >= 2);
        await waitFor(() => t.log.lines.filter(l => /Connected via IP/.test(l)).length >= 2);
        await sleep(300);
        assert.strictEqual(await getCur(t), C.SecuritySystemCurrentState.AWAY_ARM);
    } finally { await t.done(); }
});
