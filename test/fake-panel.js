'use strict';
// A fake Texecom ComIP on 127.0.0.1, modelled on what the community has seen
// real Premier Elite panels do on a Crestron-mode port (README "What changed and why"):
//   - one TCP client at a time, a second is dropped;
//   - loginMode 'double' (the default, what the tested panel and the upstream
//     #26 reporter's do): the first \W<udl>/ after idle is NOT answered; it puts
//     the port in a pending state (events held, ASTATUS NAKed, text commands
//     ERROR). A second \W then gets OK and opens the session. This is why
//     4.4.0's 2 s login resend works and a single \W fails.
//     loginMode 'single': the first \W is answered (the old model);
//   - \W into an open (OK'd) session WEDGES the port: \W is never answered
//     again and every text command gets ERROR (until restart);
//   - while a session is open, events are held back and released when it ends,
//     ASTATUS is NAKed (03 0F ED);
//   - binary logout 03 48 B4 -> ACK 03 06 F6, session over, but ASTATUS is
//     still NAKed and events held for postLogoutNakMs (real panel: ~30 s);
//   - the session times out by itself after sessionTimeoutMs idle;
//   - \A<mask>/ -> OK, "X0010 (exit), then "A<area><user> after exitMs;
//     \D<mask>/ -> OK, "D<area><user>.
// It never talks to anything but the test that started it.

const net = require('net');
const EventEmitter = require('events');

const LOGOUT = Buffer.from([0x03, 0x48, 0xB4]);
const ACK = Buffer.from([0x03, 0x06, 0xF6]);
const NAK = Buffer.from([0x03, 0x0F, 0xED]);

class FakePanel extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.o = Object.assign({
            udl: '1234',
            loginMode: 'double',       // double | single
            postLogoutNakMs: 0,
            loginReply: 'ok',          // answer to the \W that is answered: ok | silent | late | error
            loginDelayMs: 0,
            commandReply: 'auto',      // auto | ok | silent | error | notready
            sessionTimeoutMs: 600,
            releaseDelayMs: 30,
            exitMs: 150,
            user: '29',
            ackLogout: true,
            astatus: true,             // false: answer ASTATUS with ERROR (unsupported)
            armTakes: true,            // false: answer OK to an arm but never arm (no X/A events, stays N)
        }, opts);
        this.areas = ['N', 'N', 'N', 'N', 'N', 'N', 'N', 'N'];
        this.received = [];            // { t, kind, body }
        this.logins = 0;
        this.connections = 0;
        this.sessionOpen = false;      // events held, ASTATUS NAKed
        this.loggedIn = false;         // a \W was answered OK: commands accepted
        this.wedged = false;
        this.mute = false;
        this.held = [];
        this.client = null;
        this.buf = Buffer.alloc(0);
        this.timers = new Set();
    }

    listen() {
        return new Promise((resolve) => {
            this.server = net.createServer((sock) => this._onClient(sock));
            this.server.listen(0, '127.0.0.1', () => {
                this.port = this.server.address().port;
                resolve(this.port);
            });
        });
    }

    close() {
        for (const t of this.timers) clearTimeout(t);
        if (this.client) this.client.destroy();
        return new Promise((resolve) => this.server.close(() => resolve()));
    }

    _later(ms, fn) {
        const t = setTimeout(() => {
            this.timers.delete(t);
            fn();
        }, ms);
        this.timers.add(t);
        return t;
    }

    _onClient(sock) {
        if (this.client) {
            sock.destroy();            // the ComIP takes one client
            return;
        }
        this.connections += 1;
        this.client = sock;
        this.buf = Buffer.alloc(0);
        this.emit('client');
        sock.on('data', (d) => this._onData(d));
        sock.on('error', () => { });
        sock.on('close', () => {
            if (this.client === sock) this.client = null;
        });
    }

    write(data) {
        if (this.client && !this.client.destroyed) this.client.write(data);
    }

    // Raw bytes, exactly as given: for multi-message packets.
    sendRaw(text) {
        this.write(Buffer.from(text, 'latin1'));
    }

    // A panel event: held while a session is open.
    event(text) {
        if (this.sessionOpen) this.held.push(text);
        else this.write(text + '\r\n');
    }

    // Opens an OK'd session (also used by tests to fake one already open).
    openSession() {
        this.sessionOpen = true;
        this.loggedIn = true;
        this._touchSession();
    }

    _pendingSession() {
        this.sessionOpen = true;
        this.loggedIn = false;
        this._touchSession();
    }

    _touchSession() {
        clearTimeout(this.sessionTimer);
        this.sessionTimer = this._later(this.o.sessionTimeoutMs, () => this._endSession('timeout'));
    }

    _endSession(why) {
        if (!this.sessionOpen) return;
        this.loggedIn = false;
        clearTimeout(this.sessionTimer);
        if (why === 'logout' && this.o.postLogoutNakMs > 0) {
            // Still busy for a while after the ACK: NAK and held events go on.
            clearTimeout(this.quietTimer);
            this.quietTimer = this._later(this.o.postLogoutNakMs, () => this._release(why));
            return;
        }
        this._release(why);
    }

    _release(why) {
        this.sessionOpen = false;
        this.emit('session-end', why);
        this._later(this.o.releaseDelayMs, () => {
            const held = this.held;
            this.held = [];
            if (held.length) this.write(held.map(h => h + '\r\n').join(''));   // one burst
        });
    }

    count(kind, pred) {
        return this.received.filter(r => r.kind === kind && (!pred || pred(r.body))).length;
    }

    _onData(d) {
        this.buf = Buffer.concat([this.buf, d]);
        for (;;) {
            if (!this.buf.length) return;
            if (this.buf[0] === 0x03) {
                if (this.buf.length < 3) return;
                const f = this.buf.subarray(0, 3);
                this.buf = this.buf.subarray(3);
                this._handle('binary', Buffer.from(f));
                continue;
            }
            if (this.buf[0] === 0x5C) {
                const end = this.buf.indexOf(0x2F, 1);
                if (end < 0) return;
                const body = this.buf.subarray(1, end).toString('latin1');
                this.buf = this.buf.subarray(end + 1);
                this._handle('text', body);
                continue;
            }
            const nl = this.buf.indexOf(0x0A);
            if (nl < 0) return;
            const line = this.buf.subarray(0, nl).toString('latin1').replace(/\r/g, '');
            this.buf = this.buf.subarray(nl + 1);
            this._handle('line', line);
        }
    }

    _handle(kind, body) {
        this.received.push({ t: Date.now(), kind, body });
        this.emit('received', kind, body);
        if (this.mute) return;

        if (kind === 'binary') {
            if (Buffer.compare(body, LOGOUT) === 0) {
                if (!this.o.ackLogout) return;
                this.write(ACK);
                this._endSession('logout');
            }
            return;
        }

        if (kind === 'line') {
            if (body === 'ASTATUS') {
                if (this.wedged) this.write('ERROR\r\n');
                else if (this.sessionOpen) this.write(NAK);
                else if (!this.o.astatus) this.write('ERROR\r\n');
                else this.write('"' + this.areas.join('') + '\r\n');
            }
            return;
        }

        // \...\/ text commands
        if (body.startsWith('W')) {
            this.logins += 1;
            if (this.wedged) return;
            const single = this.o.loginMode === 'single';
            if (this.loggedIn || (single && this.sessionOpen)) {
                this.wedged = true;    // re-login into an open session
                this.emit('wedged');
                return;
            }
            if (!single && !this.sessionOpen) {
                // First \W after idle: swallowed, port now pending.
                this._pendingSession();
                return;
            }
            if (this.o.loginReply === 'silent') {
                // single: the session opens without a word (old model);
                // double: the resend is not answered either, still pending.
                if (single) this.openSession();
                else this._touchSession();
                return;
            }
            if (this.o.loginReply === 'error') {
                this.write('ERROR\r\n');
                return;
            }
            if (body.slice(1) !== this.o.udl) {
                this.write('ERROR\r\n');
                return;
            }
            this.openSession();
            if (this.o.loginReply === 'ok') this.write('OK\r\n');
            else if (this.o.loginReply === 'late') this._later(this.o.loginDelayMs, () => this.write('OK\r\n'));
            return;
        }

        if (this.wedged || !this.loggedIn) {
            this.write('ERROR\r\n');
            return;
        }
        this._touchSession();
        const letter = body[0];
        const mask = body.charCodeAt(1);
        const areas = [];
        for (let i = 0; i < 8; i++) if (mask & (1 << i)) areas.push(i + 1);

        let reply = this.o.commandReply;
        if (reply === 'auto') {
            if ((letter === 'A' || letter === 'Y') && areas.some(a => this.areas[a - 1] === 'Y')) reply = 'notready';
            else reply = 'ok';
        }
        if (reply === 'silent') return;
        if (reply === 'error') return this.write('ERROR\r\n');
        if (reply === 'notready') return this.write('NOT READY\r\n');
        this.write('OK\r\n');

        if ((letter === 'A' || letter === 'Y') && this.o.armTakes) {
            for (const a of areas) {
                const aaa = String(a).padStart(3, '0');
                this.event(`"X${aaa}0`);
                this._later(this.o.exitMs, () => {
                    this.areas[a - 1] = 'Y';
                    this.event(`"A${aaa}${this.o.user}`);
                });
            }
        } else if (letter === 'D') {
            for (const a of areas) {
                this.areas[a - 1] = 'N';
                this.event(`"D${String(a).padStart(3, '0')}${this.o.user}`);
            }
        }
    }
}

module.exports = { FakePanel, LOGOUT, ACK, NAK };
