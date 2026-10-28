'use strict';
// Sends an alert by running a configurable shell command. The message is
// given to the command three ways: as $1, in $TEXECOM_ALERT, and on stdin.
// No command (unset, empty or false) means alerts off. alert_command: true
// runs the bundled example bin/texecom-alert (Telegram Bot API, configured
// by environment variables).

const { spawn } = require('child_process');
const path = require('path');

const DEFAULT_COMMAND = path.join(__dirname, '..', 'bin', 'texecom-alert');

class Alerter {
    constructor({ command, log, minIntervalMs = 30000, timeoutMs = 30000, prefix = 'Texecom' }) {
        this.command = command === true ? DEFAULT_COMMAND
            : command === undefined || command === null || command === false ? '' : String(command).trim();
        this.log = log;
        this.minIntervalMs = minIntervalMs;
        this.timeoutMs = timeoutMs;
        this.prefix = prefix;
        this.lastSent = new Map();   // text -> time, so one problem is one message
    }

    get enabled() {
        return this.command !== '';
    }

    // Resolves true when the command ran and exited 0.
    send(text) {
        const msg = `${this.prefix}: ${text}`;
        if (!this.enabled) {
            this.log.debug(`Alert not sent (alerts off): ${msg}`);
            return Promise.resolve(false);
        }
        const now = Date.now();
        const last = this.lastSent.get(msg);
        if (last !== undefined && now - last < this.minIntervalMs) {
            this.log.debug(`Alert not repeated within ${this.minIntervalMs / 1000}s: ${msg}`);
            return Promise.resolve(false);
        }
        this.lastSent.set(msg, now);

        return new Promise((resolve) => {
            let out = '';
            const child = spawn('/bin/sh', ['-c', this.command, 'texecom-alert', msg], {
                env: Object.assign({}, process.env, { TEXECOM_ALERT: msg }),
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            const timer = setTimeout(() => {
                this.log.error(`Alert command took over ${this.timeoutMs / 1000}s, killed`);
                child.kill('SIGKILL');
            }, this.timeoutMs);
            child.stdout.on('data', (d) => { out += d; });
            child.stderr.on('data', (d) => { out += d; });
            child.on('error', (err) => {
                clearTimeout(timer);
                this.log.error(`Alert command could not run: ${err.message}`);
                resolve(false);
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) {
                    this.log.log(`Alert sent: ${msg}`);
                    resolve(true);
                } else {
                    this.log.error(`Alert command failed (exit ${code}): ${out.trim().slice(0, 300)}`);
                    resolve(false);
                }
            });
            child.stdin.on('error', () => { });
            child.stdin.end(msg);
        });
    }
}

module.exports = { Alerter, DEFAULT_COMMAND };
