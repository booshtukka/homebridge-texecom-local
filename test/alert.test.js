'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Alerter, DEFAULT_COMMAND } = require('../lib/alert');

const quiet = { log() { }, debug() { }, warn() { }, error() { } };

test('alert command gets the message as $1, $TEXECOM_ALERT and stdin', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-'));
    const f = path.join(dir, 'out');
    const a = new Alerter({ command: `{ printf '%s|' "$1" "$TEXECOM_ALERT"; cat; } > '${f}'`, log: quiet });
    assert.strictEqual(await a.send('it\'s "quoted" $HOME `id`'), true);
    const msg = 'Texecom: it\'s "quoted" $HOME `id`';
    assert.strictEqual(fs.readFileSync(f, 'utf8'), `${msg}|${msg}|${msg}`);
});

test('identical alerts are not repeated within the interval; empty command = off; failures reported', async () => {
    let n = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-'));
    const f = path.join(dir, 'out');
    const a = new Alerter({ command: `echo x >> '${f}'`, log: quiet, minIntervalMs: 10000 });
    await a.send('one');
    await a.send('one');
    await a.send('two');
    n = fs.readFileSync(f, 'utf8').trim().split('\n').length;
    assert.strictEqual(n, 2);
    assert.strictEqual(new Alerter({ command: '', log: quiet }).enabled, false);
    assert.strictEqual(new Alerter({ command: false, log: quiet }).enabled, false);
    assert.strictEqual(new Alerter({ log: quiet }).enabled, false, 'unset = off');
    assert.strictEqual(new Alerter({ command: true, log: quiet }).command, DEFAULT_COMMAND);
    const errs = [];
    const bad = new Alerter({ command: 'exit 3', log: Object.assign({}, quiet, { error: (m) => errs.push(m) }) });
    assert.strictEqual(await bad.send('x'), false);
    assert.match(errs[0], /exit 3/);
});
