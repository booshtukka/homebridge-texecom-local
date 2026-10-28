'use strict';
// Texecom Premier Elite "Simple Protocol" on a Crestron-mode com port (ComIP).
// Pure functions only: framing, parsing, the binary Wintex frames we use.
//
// Sources (see README "What changed and why"):
//   - K1LL3R234/homebridge-texecom PR #28 review (real-panel testing)
//   - metaljay/ha-texecom docs/development/protocol.md
//   - openHAB thread 38703, Samyoue/TexecomVeraPlugin
//
//   command      \<text>/           e.g. \W1234/ login, \A<mask>/ arm, \D<mask>/ disarm
//   reply        OK | ERROR | NOT READY, each ending CR LF
//   status read  ASTATUS CR LF (plain line, no \ /, no login) -> "<one letter per area> CR LF
//   events       "Zzzzs  "Aaaauu  "Daaauu  "Laaa  "Eaaa  "Xaaa  "U...   (CR LF)
//   binary       03 48 B4 = Wintex logout, ACK 03 06 F6, NAK 03 0F ED (no CR LF)

// Wintex frames are [length, command, checksum] with checksum = 0xFF - (sum & 0xFF).
function wintexFrame(cmd) {
    const len = 3;
    return Buffer.from([len, cmd, (0xFF - ((len + cmd) & 0xFF)) & 0xFF]);
}

const LOGOUT = wintexFrame(0x48);   // 03 48 B4
const ACK = wintexFrame(0x06);      // 03 06 F6
const NAK = wintexFrame(0x0F);      // 03 0F ED

function toBuffer(data) {
    return Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1');
}

// Wraps a command in \ and /. latin1 so the area bitmask byte goes out as one byte.
function frameCommand(command) {
    return Buffer.concat([Buffer.from('\\', 'latin1'), toBuffer(command), Buffer.from('/', 'latin1')]);
}

// For the log: what was written, with the UDL in a login masked.
function describeWrite(buf) {
    const text = toBuffer(buf).toString('latin1');
    return text.replace(/^\\W[^/]*\//, '\\W****/');
}

// Area 1 is the low bit. Null if any area is outside 1..8.
function areaMask(area_numbers) {
    let mask = 0;
    for (const value of area_numbers) {
        const area = Number(value);
        if (!Number.isInteger(area) || area < 1 || area > 8) {
            return null;
        }
        mask |= 1 << (area - 1);
    }
    return mask === 0 ? null : mask;
}

// Splits the byte stream into items. Text messages end in LF (CR stripped);
// the 3-byte Wintex frames (ACK/NAK) carry no terminator, so they are picked
// out whenever one starts at a message boundary.
class StreamSplitter {
    constructor() {
        this.buf = Buffer.alloc(0);
    }

    push(chunk) {
        this.buf = Buffer.concat([this.buf, toBuffer(chunk)]);
        const out = [];
        for (;;) {
            if (this.buf.length === 0) break;
            if (this.buf[0] === 0x03) {
                if (this.buf.length < 3) break;
                const frame = this.buf.subarray(0, 3);
                if (frame.equals(ACK)) out.push({ kind: 'ack' });
                else if (frame.equals(NAK)) out.push({ kind: 'nak' });
                else out.push({ kind: 'binary', bytes: Buffer.from(frame) });
                this.buf = this.buf.subarray(3);
                continue;
            }
            const nl = this.buf.indexOf(0x0A);
            if (nl < 0) {
                // Guard against a stream that never sends LF.
                if (this.buf.length > 4096) {
                    out.push({ kind: 'line', text: this.buf.toString('latin1').replace(/\r/g, '').trim() });
                    this.buf = Buffer.alloc(0);
                }
                break;
            }
            const text = this.buf.subarray(0, nl).toString('latin1').replace(/\r/g, '').trim();
            this.buf = this.buf.subarray(nl + 1);
            if (text) out.push({ kind: 'line', text });
        }
        return out;
    }

    reset() {
        this.buf = Buffer.alloc(0);
    }
}

// Classifies one text line from the panel.
function parseLine(text) {
    let m;
    if (text === 'OK') return { type: 'ok' };
    if (text === 'ERROR') return { type: 'error' };
    if (text === 'NOT READY') return { type: 'notready' };
    if ((m = /^"Z(\d{3})(\d)/.exec(text))) {
        return { type: 'zone', zone: Number(m[1]), state: Number(m[2]), active: m[2] !== '0' };
    }
    if ((m = /^"([ADL])(\d{3})(\d*)/.exec(text))) {
        const type = { A: 'armed', D: 'disarmed', L: 'alarm' }[m[1]];
        return { type, area: Number(m[2]), user: m[3] };
    }
    if ((m = /^"E(\d{3})/.exec(text))) return { type: 'entry', area: Number(m[1]) };
    if ((m = /^"X(\d{3})/.exec(text))) return { type: 'exit', area: Number(m[1]) };
    if (/^"U/.test(text)) return { type: 'user', raw: text };
    // ASTATUS reply: " then one letter per area, no digits.
    if ((m = /^"([A-Za-z]+)$/.exec(text))) return { type: 'astatus', letters: m[1].toUpperCase().split('') };
    return { type: 'unknown', raw: text };
}

// Y = armed, N = disarmed (community-documented). Anything else is unknown.
function astatusArea(letters, area_number) {
    const letter = letters[area_number - 1];
    if (letter === 'Y') return 'armed';
    if (letter === 'N') return 'disarmed';
    return 'unknown';
}

module.exports = { LOGOUT, ACK, NAK, wintexFrame, frameCommand, describeWrite, areaMask, StreamSplitter, parseLine, astatusArea, toBuffer };
