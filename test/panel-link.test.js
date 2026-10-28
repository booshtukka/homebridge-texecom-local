'use strict';
// PanelLink against the fake panel: login safety, logout, ASTATUS, framing,
// heartbeat/reconnect. Timings are scaled down (ms instead of s).
const test = require('node:test');
const assert = require('node:assert');
const { FakePanel, LOGOUT } = require('./fake-panel');
const { PanelLink } = require('../lib/panel-link');
const P = require('../lib/protocol');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const quiet = { log() { }, debug() { }, warn() { }, error() { } };

const FAST = {
    loginRetryAfterMs: 150,
    loginSettleMs: 30,
    loginTimeoutMs: 300,
    commandTimeoutMs: 300,
    logoutAckTimeoutMs: 200,
    loginCooldownMs: 1500,
    sessionIdleMs: 800,
    postLogoutQuietMs: 50,
    pollIntervalMs: 200,
    initialPollDelayMs: 20,
    pollReplyTimeoutMs: 150,
    maxMissedPolls: 2,
    preflightTimeoutMs: 150,
    reconnectDelayMs: 100,
    connectTimeoutMs: 1000,
};

async function setup(panelOpts = {}, linkOpts = {}) {
    const panel = new FakePanel(panelOpts);
    const port = await panel.listen();
    const link = new PanelLink(Object.assign({ host: '127.0.0.1', port, udl: '1234', log: quiet }, FAST, linkOpts));
    const events = [];
    const statuses = [];
    link.on('event', (e) => events.push(e));
    link.on('astatus', (l) => statuses.push(l.join('')));
    const connected = new Promise(r => link.once('connected', r));
    link.start();
    await connected;
    const done = async () => {
        link.stop();
        await panel.close();
    };
    return { panel, link, events, statuses, done };
}

function waitFor(pred, ms = 2000, step = 10) {
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

test('protocol: logout frame is 03 48 B4, ACK 03 06 F6, NAK 03 0F ED (Wintex checksum)', () => {
    assert.deepStrictEqual([...P.LOGOUT], [0x03, 0x48, 0xB4]);
    assert.deepStrictEqual([...P.ACK], [0x03, 0x06, 0xF6]);
    assert.deepStrictEqual([...P.NAK], [0x03, 0x0F, 0xED]);
    assert.deepStrictEqual([...P.frameCommand('A\x01')], [0x5C, 0x41, 0x01, 0x2F]);
    assert.strictEqual(P.describeWrite(P.frameCommand('W1234')), '\\W****/', 'UDL never logged');
    assert.strictEqual(P.describeWrite(Buffer.from('ASTATUS\r\n')), 'ASTATUS\r\n');
});

test('protocol: ASTATUS reply and events parse; ASTATUS letters are not mistaken for events', () => {
    assert.deepStrictEqual(P.parseLine('"YNNNNNNN'), { type: 'astatus', letters: 'YNNNNNNN'.split('') });
    assert.deepStrictEqual(P.parseLine('"N'), { type: 'astatus', letters: ['N'] });
    assert.strictEqual(P.astatusArea(['Y', 'N'], 1), 'armed');
    assert.strictEqual(P.astatusArea(['Y', 'N'], 2), 'disarmed');
    assert.strictEqual(P.astatusArea(['Y'], 3), 'unknown');
    assert.deepStrictEqual(P.parseLine('"X0010'), { type: 'exit', area: 1 });
    assert.deepStrictEqual(P.parseLine('"E001'), { type: 'entry', area: 1 });
    assert.deepStrictEqual(P.parseLine('"A00129'), { type: 'armed', area: 1, user: '29' });
    assert.deepStrictEqual(P.parseLine('"D001103'), { type: 'disarmed', area: 1, user: '103' });
    assert.deepStrictEqual(P.parseLine('"L001'), { type: 'alarm', area: 1, user: '' });
    assert.strictEqual(P.parseLine('"Z0021').active, true);
    assert.strictEqual(P.parseLine('NOT READY').type, 'notready');
});

test('splitter: multi-message packets, split messages and bare Wintex frames', () => {
    const s = new P.StreamSplitter();
    const a = s.push('"Z0011\r\n"A00103\r\n"Z00');
    assert.deepStrictEqual(a.map(x => x.text), ['"Z0011', '"A00103']);
    const b = s.push(Buffer.concat([Buffer.from('10\r\n'), P.ACK, Buffer.from('OK\r\n'), P.NAK]));
    assert.deepStrictEqual(b.map(x => x.kind === 'line' ? x.text : x.kind), ['"Z0010', 'ack', 'OK', 'nak']);
});

test('ASTATUS is sent (plain line, no login) on connect and parsed', async () => {
    const { panel, statuses, done } = await setup();
    try {
        panel.areas[0] = 'Y';
        await waitFor(() => statuses.length >= 1);
        assert.strictEqual(statuses[0][0], 'Y');
        assert.ok(panel.count('line', b => b === 'ASTATUS') >= 1);
        assert.strictEqual(panel.logins, 0, 'no login for a status read');
    } finally { await done(); }
});

const seqOf = (panel) => panel.received.filter(r => r.kind !== 'line' || r.body !== 'ASTATUS').map(r => r.kind === 'binary' ? [...r.body] : r.body);

test('command: \\W, \\W resent after no OK (as 4.4.0), the command, then binary logout; events released after logout', async () => {
    const { panel, link, events, done } = await setup({}, { pollIntervalMs: 60000 });
    try {
        await sleep(60);
        const t0 = Date.now();
        const res = await link.runCommand('A\x01', 'arm');
        assert.strictEqual(res.loginOk, true);
        assert.ok(Date.now() - t0 >= 140, 'resend only after loginRetryAfterMs');
        assert.deepStrictEqual(seqOf(panel), ['W1234', 'W1234', 'A\x01', [...LOGOUT]]);
        assert.strictEqual(panel.logins, 2);
        assert.strictEqual(panel.wedged, false);
        await waitFor(() => events.some(e => e.type === 'armed'));
        assert.deepStrictEqual(events.map(e => e.type), ['exit', 'armed']);
    } finally { await done(); }
});

test('command: a panel that answers the first \\W gets no resend', async () => {
    const { panel, link, done } = await setup({ loginMode: 'single' }, { pollIntervalMs: 60000 });
    try {
        await sleep(60);
        const res = await link.runCommand('A\x01', 'arm');
        assert.strictEqual(res.loginOk, true);
        assert.deepStrictEqual(seqOf(panel), ['W1234', 'A\x01', [...LOGOUT]]);
        assert.strictEqual(panel.wedged, false);
    } finally { await done(); }
});

test('single-\\W failure reproduced: one \\W, no reply, arm sent anyway -> ERROR; logout ACK; ASTATUS NAKed after it', async () => {
    // The live sequence: preflight ASTATUS "N, \W, 6 s silence, \A -> ERROR,
    // 03 48 B4 -> ACK, ASTATUS 5 s later -> NAK, "N again a minute later.
    const { panel, link, statuses, done } = await setup({ postLogoutNakMs: 400, sessionTimeoutMs: 2000 },
        { pollIntervalMs: 60000, loginRetry: false, sendCommandWithoutLoginOk: true, postLogoutQuietMs: 50, sessionIdleMs: 600 });
    try {
        await waitFor(() => statuses.length >= 1);
        await assert.rejects(link.runCommand('A\x01', 'arm'), (e) => e.code === 'error' && /login was never acknowledged/.test(e.message));
        assert.deepStrictEqual(seqOf(panel), ['W1234', 'A\x01', [...LOGOUT]]);
        assert.strictEqual(panel.logins, 1);
        const pre = panel.received.findIndex(r => r.kind === 'text');
        assert.strictEqual(panel.received[pre - 1].body, 'ASTATUS', 'preflight ASTATUS just before the login');
        const reply = await link.readStatus(150);
        assert.ok(reply && reply.type === 'nak', 'ASTATUS NAKed shortly after the logout ACK');
        await sleep(450);
        const later = await link.readStatus(150);
        assert.strictEqual(later.type, 'astatus', 'answered again once the panel is done');
        assert.strictEqual(panel.wedged, false);
    } finally { await done(); }
});

test('single-\\W failure fixed: same panel, the fork now resends \\W once, arms, and leaves ASTATUS alone through the post-logout quiet', async () => {
    const { panel, link, events, statuses, done } = await setup({ postLogoutNakMs: 300, sessionTimeoutMs: 2000 },
        { pollIntervalMs: 100, postLogoutQuietMs: 400 });
    try {
        await waitFor(() => statuses.length >= 1);
        const res = await link.runCommand('A\x01', 'arm');
        assert.strictEqual(res.loginOk, true);
        assert.deepStrictEqual(seqOf(panel), ['W1234', 'W1234', 'A\x01', [...LOGOUT]]);
        const tLogout = panel.received.find(r => r.kind === 'binary').t;
        await waitFor(() => events.some(e => e.type === 'armed'), 3000);
        const after = () => panel.received.filter(r => r.kind === 'line' && r.t > tLogout);
        await waitFor(() => after().length >= 1, 3000);
        const astatusAfter = after();
        assert.ok(astatusAfter[0].t - tLogout >= 380, 'no ASTATUS inside the post-logout quiet');
        assert.strictEqual(panel.wedged, false);
    } finally { await done(); }
});

test('login: both \\W frames unanswered -> exactly two, the command is NOT sent, logout sent', async () => {
    const { panel, link, done } = await setup({ loginReply: 'silent' }, { pollIntervalMs: 60000 });
    try {
        await sleep(50);
        const t0 = Date.now();
        await assert.rejects(link.runCommand('A\x01', 'arm'), (e) => e.code === 'login-timeout');
        assert.ok(Date.now() - t0 >= 430, 'waited the retry gap plus the full login timeout');
        assert.strictEqual(panel.logins, 2, 'exactly two login frames, never a third');
        assert.strictEqual(panel.count('text', b => b.startsWith('A')), 0);
        assert.strictEqual(panel.count('binary'), 1, 'logout sent');
        assert.strictEqual(panel.wedged, false);
    } finally { await done(); }
});

test('login: a late OK to the first \\W (inside the retry gap) is accepted, never repeated', async () => {
    const { panel, link, done } = await setup({ loginMode: 'single', loginReply: 'late', loginDelayMs: 80 }, { pollIntervalMs: 60000 });
    try {
        await sleep(50);
        const res = await link.runCommand('D\x01', 'disarm');
        assert.strictEqual(res.loginOk, true);
        assert.strictEqual(panel.logins, 1);
    } finally { await done(); }
});

test('login wedge avoidance: concurrent tap fails fast (busy), tap inside cooldown fails fast with nothing sent', async () => {
    const { panel, link, done } = await setup({}, { pollIntervalMs: 60000 });
    try {
        await sleep(50);
        const first = link.runCommand('A\x01', 'arm');
        await assert.rejects(link.runCommand('A\x01', 'arm'), (e) => e.code === 'busy');
        await first;
        const before = panel.received.length;
        const t0 = Date.now();
        await assert.rejects(link.runCommand('D\x01', 'disarm'), (e) => e.code === 'cooldown');
        assert.ok(Date.now() - t0 < 50, 'failed fast');
        assert.strictEqual(panel.received.length, before, 'nothing written to the panel');
        assert.strictEqual(panel.logins, 2);
        await sleep(1500);   // cooldown over
        await link.runCommand('D\x01', 'disarm');
        assert.strictEqual(panel.logins, 4);
        assert.strictEqual(panel.wedged, false);
    } finally { await done(); }
});

test('logout not acknowledged: session treated as open; no login and no ASTATUS until it must have timed out', async () => {
    const { panel, link, done } = await setup({ ackLogout: false, sessionTimeoutMs: 600 },
        { loginCooldownMs: 100, sessionIdleMs: 800, pollIntervalMs: 100 });
    try {
        await sleep(60);
        await link.runCommand('A\x01', 'arm');
        const tEnd = Date.now();
        await sleep(150);
        await assert.rejects(link.runCommand('D\x01', 'disarm'), (e) => e.code === 'session-open');
        assert.strictEqual(panel.logins, 2);
        const polledDuring = panel.received.filter(r => r.kind === 'line' && r.t > tEnd && r.t < tEnd + 600).length;
        assert.strictEqual(polledDuring, 0, 'no ASTATUS while the session may be open');
        await sleep(900);
        await link.runCommand('D\x01', 'disarm');
        assert.strictEqual(panel.logins, 4);
        assert.strictEqual(panel.wedged, false);
    } finally { await done(); }
});

test('preflight: ASTATUS NAK (session already open) -> refuses to log in', async () => {
    const { panel, link, done } = await setup({ sessionTimeoutMs: 5000 }, { pollIntervalMs: 60000 });
    try {
        await sleep(50);
        panel.openSession();
        await assert.rejects(link.runCommand('A\x01', 'arm'), (e) => e.code === 'session-open');
        assert.strictEqual(panel.logins, 0);
        assert.strictEqual(panel.wedged, false);
    } finally { await done(); }
});

test('fake sanity: a third \\W, into the OK\'d session, wedges the port', async () => {
    // Sanity check of the fake itself, so the tests above mean something.
    const panel = new FakePanel();
    const port = await panel.listen();
    const net = require('net');
    const s = net.createConnection(port, '127.0.0.1');
    await new Promise(r => s.on('connect', r));
    let got = '';
    s.on('data', d => { got += d.toString('latin1'); });
    s.write('\\W1234/');   // swallowed
    await sleep(50);
    assert.strictEqual(got, '');
    s.write('\\W1234/');   // the 4.4.0 resend: OK
    await sleep(50);
    assert.strictEqual(got, 'OK\r\n');
    assert.strictEqual(panel.wedged, false);
    s.write('\\W1234/');   // one too many
    await sleep(50);
    s.write('\\A\x01/');
    await sleep(50);
    assert.strictEqual(panel.wedged, true);
    assert.match(got, /ERROR/);
    s.destroy();
    await panel.close();
});

test('command failures: no reply -> timeout (logout still sent); NOT READY; login ERROR', async () => {
    let ctx = await setup({ commandReply: 'silent' }, { pollIntervalMs: 60000 });
    try {
        await sleep(50);
        await assert.rejects(ctx.link.runCommand('A\x01', 'arm'), (e) => e.code === 'timeout');
        assert.strictEqual(ctx.panel.count('binary'), 1, 'logout sent after the timeout');
    } finally { await ctx.done(); }

    ctx = await setup({ commandReply: 'notready' }, { pollIntervalMs: 60000 });
    try {
        await sleep(50);
        await assert.rejects(ctx.link.runCommand('A\x01', 'arm'), (e) => e.code === 'notready');
    } finally { await ctx.done(); }

    ctx = await setup({ loginReply: 'error' }, { pollIntervalMs: 60000 });
    try {
        await sleep(50);
        await assert.rejects(ctx.link.runCommand('A\x01', 'arm'), (e) => e.code === 'login-error');
        assert.strictEqual(ctx.panel.count('text', b => b.startsWith('A')), 0, 'no command after a refused login');
    } finally { await ctx.done(); }
});

test('OK sharing a TCP packet with an event: both are seen', async () => {
    const { panel, link, events, done } = await setup({ commandReply: 'silent' }, { pollIntervalMs: 60000 });
    try {
        await sleep(50);
        panel.on('received', (kind, body) => {
            if (kind === 'text' && body === 'A\x01') panel.sendRaw('OK\r\n"Z0021\r\n');
        });
        await link.runCommand('A\x01', 'arm');
        await waitFor(() => events.some(e => e.type === 'zone' && e.zone === 2));
    } finally { await done(); }
});

test('multi-message packet: zone + arm + zone in one write, and a message split across writes', async () => {
    const { panel, events, done } = await setup({}, { pollIntervalMs: 60000 });
    try {
        await sleep(50);
        panel.sendRaw('"Z0011\r\n"A00103\r\n"Z0010\r\n"D0');
        await sleep(30);
        panel.sendRaw('0103\r\n');
        await waitFor(() => events.length >= 4);
        assert.deepStrictEqual(events.map(e => e.type), ['zone', 'armed', 'zone', 'disarmed']);
        assert.strictEqual(events[1].user, '03');
    } finally { await done(); }
});

test('reconnect on silence: ASTATUS unanswered twice -> socket dropped and reopened', async () => {
    const { panel, link, done } = await setup();
    try {
        let missed = 0;
        link.on('poll-missed', () => { missed += 1; });
        await waitFor(() => panel.count('line') >= 1);
        panel.mute = true;     // TCP up, panel side dead
        await waitFor(() => panel.connections >= 2, 3000);
        assert.ok(missed >= 2);
        panel.mute = false;
        const before = panel.count('line');
        await waitFor(() => panel.count('line') > before, 2000);
    } finally { await done(); }
});

test('ASTATUS answered ERROR counts as alive (no reconnect) and is reported', async () => {
    const { panel, link, done } = await setup({ astatus: false });
    try {
        let errs = 0;
        link.on('astatus-error', () => { errs += 1; });
        await sleep(700);
        assert.ok(errs >= 2);
        assert.strictEqual(panel.connections, 1);
    } finally { await done(); }
});
