'use strict';
// The one TCP connection to the panel's Crestron/Simple-protocol port, and the
// rules for talking to it safely. Everything that writes to the panel goes
// through here.
//
// Why the rules exist (README "What changed and why"): on a Crestron-mode port a UDL
// login (\W<udl>/) opens a Wintex session that holds back all event output
// until it ends, and a second \W while one may be open can wedge the port
// (\W unanswered, text commands -> ERROR) until the panel or ComIP is power
// cycled. So:
//   - the login is exactly what 4.4.0 sends, the only sequence proven on this
//     panel: \W, and if there is no OK within 2 s, \W once more. The panel
//     never answers the first \W after idle and answers the resend with OK at
//     once (upstream #26 trace; also seen with 4.4.0 on a Premier Elite + ComIP).
//     Sent once only, the login gets no reply and the command gets ERROR. Never a
//     third \W, never while a session may be open, and one login sequence
//     per login_cooldown (60 s);
//   - the command is only sent after the login's OK;
//   - the binary Wintex logout 03 48 B4 always follows the command; events
//     and ASTATUS only come back about 30 s after its ACK;
//   - ASTATUS (no login) reads the real arm state on connect and every 60 s
//     while no session is open, and is the heartbeat: unanswered twice in a
//     row means the link is dead, so the socket is dropped and reopened.

const net = require('net');
const EventEmitter = require('events');
const P = require('./protocol');

const DEFAULTS = {
    // \W, then one resend if no OK after loginRetryAfterMs (4.4.0: 2 s), then
    // up to loginTimeoutMs for the OK to the resend.
    loginRetryAfterMs: 2000,
    loginRetry: true,
    loginTimeoutMs: 6000,
    // After an OK to the resent \W, a late OK to the first one could be taken
    // for the command's; any OK in this window is swallowed first.
    loginSettleMs: 250,
    commandTimeoutMs: 5000,
    logoutAckTimeoutMs: 2000,
    loginCooldownMs: 60000,
    // With no logout ACK the panel closes the session itself after ~60 s idle.
    sessionIdleMs: 65000,
    // After a logout ACK, events resume and ASTATUS stops being NAKed in about
    // 30 s (observed: ASTATUS NAKed 5 s after the ACK).
    postLogoutQuietMs: 35000,
    pollIntervalMs: 60000,
    initialPollDelayMs: 1000,
    pollReplyTimeoutMs: 5000,
    maxMissedPolls: 2,
    preflightTimeoutMs: 1500,
    preflightStatus: true,
    // Observed: a command sent without the login's OK got ERROR. Off.
    sendCommandWithoutLoginOk: false,
    reconnectDelayMs: 10000,
    connectTimeoutMs: 10000,
    keepAliveMs: 30000,
    statusPoll: true,
    astatusCommand: 'ASTATUS\r\n',
};

class CommandError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

class PanelLink extends EventEmitter {
    constructor(opts) {
        super();
        this.o = Object.assign({}, DEFAULTS, opts);
        this.log = opts.log || { log() { }, debug() { }, warn() { }, error() { } };
        this.socket = null;
        this.connected = false;
        this.splitter = new P.StreamSplitter();
        this.waiter = null;            // { accept(item) -> bool }
        this.busy = false;             // a command sequence is running
        this.lastLoginAt = -Infinity;
        this.sessionMaybeOpenUntil = -Infinity;
        this.missedPolls = 0;
        this.pollTimer = null;
        this.reconnectTimer = null;
        this.stopped = false;
        this.pollInFlight = null;
        this.lastAnswerAt = null;
    }

    now() {
        return Date.now();
    }

    start() {
        this.stopped = false;
        this._connect();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.pollTimer);
        clearTimeout(this.reconnectTimer);
        if (this.socket) this.socket.destroy();
    }

    // ── connection ───────────────────────────────────────────────────────────
    _connect() {
        if (this.stopped) return;
        this.log.log(`Connecting to Texecom at ${this.o.host}:${this.o.port}...`);
        const socket = net.createConnection(this.o.port, this.o.host);
        this.socket = socket;
        this.splitter.reset();
        socket.setNoDelay(true);
        socket.setKeepAlive(true, this.o.keepAliveMs);

        const connectTimer = setTimeout(() => {
            this.log.error(`No connection to the panel after ${this.o.connectTimeoutMs / 1000}s, trying again`);
            socket.destroy();
        }, this.o.connectTimeoutMs);

        socket.on('connect', () => {
            clearTimeout(connectTimer);
            this.connected = true;
            this.missedPolls = 0;
            this.log.log('Connected via IP');
            this.emit('connected');
            this._schedulePoll(this.o.initialPollDelayMs);
        });
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', (err) => this.log.error(`IP connection error: ${err.message}`));
        socket.on('end', () => this.log.log('IP connection ended by the panel'));
        socket.on('close', () => {
            clearTimeout(connectTimer);
            if (this.socket !== socket) return;
            const was = this.connected;
            this.connected = false;
            this.socket = null;
            clearTimeout(this.pollTimer);
            if (this.waiter) this.waiter.fail(new CommandError('disconnected', 'connection to the panel closed'));
            if (was) this.emit('disconnected');
            if (this.stopped) return;
            this.log.error(`IP connection closed. Reconnecting in ${this.o.reconnectDelayMs / 1000}s...`);
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = setTimeout(() => this._connect(), this.o.reconnectDelayMs);
        });
    }

    // Drops the socket so it is reopened; used when the panel stops answering.
    reconnect(reason) {
        this.log.error(`Dropping the panel connection: ${reason}`);
        if (this.socket) this.socket.destroy();
    }

    _onData(chunk) {
        this.log.debug(`IP data received: ${JSON.stringify(P.toBuffer(chunk).toString('latin1'))}`);
        for (const item of this.splitter.push(chunk)) {
            const parsed = item.kind === 'line' ? P.parseLine(item.text) : { type: item.kind, bytes: item.bytes };
            if (item.kind === 'line') parsed.raw = parsed.raw || item.text;
            if (this.waiter && this.waiter.accept(parsed)) continue;
            switch (parsed.type) {
                case 'zone': case 'armed': case 'disarmed': case 'alarm':
                case 'entry': case 'exit': case 'user':
                    this.emit('event', parsed);
                    break;
                case 'ack': case 'nak':
                    this.log.debug(`Unexpected Wintex ${parsed.type} from the panel`);
                    break;
                default:
                    this.log.log(`Unexpected message from Texecom: ${parsed.raw || parsed.type}`);
            }
        }
    }

    _write(buf) {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.connected) {
                reject(new CommandError('not-connected', 'not connected to the panel'));
                return;
            }
            this.log.debug(`IP data sent: ${JSON.stringify(P.describeWrite(buf))}`);
            this.socket.write(buf, (err) => err ? reject(err) : resolve());
        });
    }

    // Waits for the first item `match` returns a value for; resolves with that
    // value, or with null on timeout. Only one waiter at a time.
    _await(match, timeoutMs) {
        return new Promise((resolve, reject) => {
            const done = (fn, v) => {
                clearTimeout(timer);
                if (this.waiter === w) this.waiter = null;
                fn(v);
            };
            const w = {
                accept: (item) => {
                    const v = match(item);
                    if (v === undefined) return false;
                    done(resolve, v);
                    return true;
                },
                fail: (err) => done(reject, err),
            };
            const timer = setTimeout(() => done(resolve, null), timeoutMs);
            this.waiter = w;
        });
    }

    // How long until runCommand would accept a command (0 = now): the login
    // cooldown, a session that may still be open, or a command in progress.
    msUntilReady() {
        if (!this.connected) return 0;
        const now = this.now();
        let wait = 0;
        if (this.busy) wait = 1000;
        wait = Math.max(wait, this.lastLoginAt + this.o.loginCooldownMs - now);
        if (this.sessionMaybeOpen()) wait = Math.max(wait, this.sessionMaybeOpenUntil - now);
        return Math.max(0, wait);
    }

    sessionMaybeOpen() {
        return this.now() < this.sessionMaybeOpenUntil;
    }

    // ── status poll / heartbeat ──────────────────────────────────────────────
    _schedulePoll(delay) {
        clearTimeout(this.pollTimer);
        if (!this.o.statusPoll || this.stopped) return;
        this.pollTimer = setTimeout(() => this._pollTick(), delay);
    }

    async _pollTick() {
        if (!this.connected) return;
        if (this.busy || this.sessionMaybeOpen()) {
            // Never poll into a session: the panel NAKs it, and the session
            // holds events back anyway. Try again once it is over.
            const wait = Math.max(1000, this.sessionMaybeOpenUntil - this.now());
            this._schedulePoll(this.busy ? 1000 : wait);
            return;
        }
        const reply = await this.readStatus(this.o.pollReplyTimeoutMs).catch(() => undefined);
        if (reply === undefined) return; // disconnected meanwhile
        if (reply === null) {
            this.missedPolls += 1;
            this.log.error(`Panel did not answer ASTATUS (${this.missedPolls}/${this.o.maxMissedPolls})`);
            this.emit('poll-missed', this.missedPolls);
            if (this.missedPolls >= this.o.maxMissedPolls) {
                this.missedPolls = 0;
                this.reconnect('no answer to the status heartbeat');
                return;
            }
        }
        this._schedulePoll(this.o.pollIntervalMs);
    }

    // Sends ASTATUS once. Resolves { type: 'astatus', letters } | { type: 'nak' }
    // | { type: 'error' } or null if nothing came back.
    async readStatus(timeoutMs) {
        if (this.pollInFlight) return this.pollInFlight;
        const run = (async () => {
            const wait = this._await((item) => {
                if (item.type === 'astatus' || item.type === 'nak' || item.type === 'error') return item;
                return undefined;
            }, timeoutMs);
            try {
                await this._write(Buffer.from(this.o.astatusCommand, 'latin1'));
            } catch (err) {
                if (this.waiter) this.waiter.fail(err);
                return wait;
            }
            const reply = await wait;
            if (reply) {
                this.missedPolls = 0;
                this.lastAnswerAt = this.now();
                this.emit('alive');
                if (reply.type === 'astatus') {
                    this.emit('astatus', reply.letters);
                } else if (reply.type === 'nak') {
                    // A UDL session is open on this port. Treat it as ours and
                    // keep away from the port until it must have timed out.
                    this.log.log('Panel NAKed ASTATUS: a programming session is open, waiting for it to close');
                    this.sessionMaybeOpenUntil = Math.max(this.sessionMaybeOpenUntil, this.now() + this.o.sessionIdleMs);
                } else {
                    this.emit('astatus-error');
                }
            }
            return reply;
        })();
        this.pollInFlight = run;
        try {
            return await run;
        } finally {
            this.pollInFlight = null;
        }
    }

    // ── commands ─────────────────────────────────────────────────────────────
    // Runs login + command + logout. Resolves { loginOk } when the panel said
    // OK to the command; rejects CommandError otherwise. Fails fast without
    // touching the panel when another command, a recent login or a possibly
    // open session makes a login unsafe.
    async runCommand(command, label) {
        if (!this.connected) throw new CommandError('not-connected', 'not connected to the panel');
        if (this.busy) throw new CommandError('busy', 'another command is still running');
        const now = this.now();
        const cooldownEnds = this.lastLoginAt + this.o.loginCooldownMs;
        if (now < cooldownEnds) {
            throw new CommandError('cooldown', `a login was sent ${Math.round((now - this.lastLoginAt) / 1000)}s ago; one login per ${this.o.loginCooldownMs / 1000}s`);
        }
        if (this.sessionMaybeOpen()) {
            throw new CommandError('session-open', `a panel session may still be open for ${Math.ceil((this.sessionMaybeOpenUntil - now) / 1000)}s`);
        }
        this.busy = true;
        clearTimeout(this.pollTimer);
        try {
            if (this.pollInFlight) await this.pollInFlight.catch(() => null);

            if (this.o.preflightStatus) {
                const pre = await this.readStatus(this.o.preflightTimeoutMs);
                if (pre && pre.type === 'nak') {
                    throw new CommandError('session-open', 'the panel reports a programming session already open (ASTATUS NAK); not logging in again');
                }
            }

            // From here on a session may be open, whatever the panel says.
            this.lastLoginAt = this.now();
            this.sessionMaybeOpenUntil = this.now() + this.o.sessionIdleMs;
            const loginFrame = P.frameCommand(`W${this.o.udl}`);
            const firstWait = this._await(replyMatch, this.o.loginRetry ? this.o.loginRetryAfterMs : this.o.loginTimeoutMs);
            await this._write(loginFrame);
            let login = await firstWait;
            let resent = false;
            if (!login && this.o.loginRetry) {
                // What 4.4.0 does, and what this panel needs: the first \W
                // after idle goes unanswered, the resend gets OK. Once only.
                resent = true;
                this.log.debug(`No reply to the login within ${this.o.loginRetryAfterMs / 1000}s, sending it once more (as 4.4.0 does)`);
                const secondWait = this._await(replyMatch, this.o.loginTimeoutMs);
                await this._write(loginFrame);
                login = await secondWait;
            }
            const loginOk = Boolean(login && login.type === 'ok');
            const tries = resent ? 'both login frames' : 'the login';
            if (!loginOk) {
                const what = login ? login.type.toUpperCase() : 'no reply';
                if (login && login.type === 'error') {
                    // The port refused the login outright: the wedged signature.
                    await this._logout();
                    throw new CommandError('login-error', `login answered ERROR (wrong UDL, or the port may be wedged)`);
                }
                if (!this.o.sendCommandWithoutLoginOk) {
                    await this._logout();
                    throw new CommandError('login-timeout', `${tries} got ${what}; ${label} not sent`);
                }
                this.log.log(`${tries} got ${what}; sending ${label} once anyway (send_command_without_login_ok)`);
            } else if (resent) {
                this.log.debug('Login OK to the resend');
                await this._swallowOk(this.o.loginSettleMs);
            } else {
                this.log.debug('Login OK');
            }

            const cmdWait = this._await(replyMatch, this.o.commandTimeoutMs);
            await this._write(P.frameCommand(command));
            this.sessionMaybeOpenUntil = this.now() + this.o.sessionIdleMs;
            const reply = await cmdWait;
            await this._logout();

            if (reply && reply.type === 'ok') return { loginOk };
            if (!reply) throw new CommandError('timeout', `no reply to ${label} within ${this.o.commandTimeoutMs / 1000}s`);
            if (reply.type === 'notready') throw new CommandError('notready', `panel answered NOT READY to ${label} (zone open, or already in that state)`);
            throw new CommandError('error', `panel answered ERROR to ${label}${loginOk ? '' : ' (login was never acknowledged)'}`);
        } finally {
            this.busy = false;
            if (this.connected) this._schedulePoll(Math.max(1000, this.sessionMaybeOpenUntil - this.now()));
        }
    }

    // Drops any OK arriving within ms (a late answer to the first \W).
    async _swallowOk(ms) {
        if (!(ms > 0)) return;
        const extra = await this._await((item) => item.type === 'ok' ? item : undefined, ms);
        if (extra) this.log.debug('Swallowed a second login OK before the command');
    }

    async _logout() {
        if (!this.connected) return false;
        const wait = this._await((item) => (item.type === 'ack' || item.type === 'nak') ? item : undefined, this.o.logoutAckTimeoutMs);
        try {
            await this._write(P.LOGOUT);
        } catch (err) {
            if (this.waiter) this.waiter.fail(err);
            await wait.catch(() => null);
            return false;
        }
        const reply = await wait.catch(() => null);
        if (reply && reply.type === 'ack') {
            this.log.debug('Logout acknowledged');
            this.sessionMaybeOpenUntil = this.now() + this.o.postLogoutQuietMs;
            return true;
        }
        this.log.log(`Logout ${reply ? 'NAKed' : 'not acknowledged'}; assuming the session stays open until it times out (${this.o.sessionIdleMs / 1000}s)`);
        return false;
    }
}

function replyMatch(item) {
    if (item.type === 'ok' || item.type === 'error' || item.type === 'notready') return item;
    return undefined;
}

module.exports = { PanelLink, CommandError, DEFAULTS };
