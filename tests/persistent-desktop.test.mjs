import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { docker, fixture } from './helpers/docker-fixture.mjs';

for (const [label, options, supplied] of [
  ['missing', { omitPassword: true }, undefined],
  ['empty', { password: '' }, ''],
  ['short', { password: 'short' }, 'short'],
  ['long', { password: 'too-long-secret' }, 'too-long-secret'],
  ['non-ASCII', { password: 'żabcdefg' }, 'żabcdefg'],
  ['control-character', { password: 'abc\ndefg' }, 'abc\ndefg'],
]) {
  test(`${label} VNC credential fails closed before startup`, { timeout: 20000 }, async t => {
    const f = await fixture(t, options);
    await f.until(async () => !(await f.state()).Running, 'Invalid credentials did not stop startup', 5000);
    const state = await f.state();
    assert.notEqual(state.ExitCode, 0);
    const logs = await docker('logs', f.name);
    assert.match(logs, /DESKTOP_VNC_PASSWORD/);
    if (supplied) assert.ok(!logs.includes(supplied), 'the credential leaked into the logs');
    assert.ok(!logs.includes('VNC extension running'), 'VNC started before credential validation');
  });
}

for (const address of ['0.0.0.0', '8.8.8.8', '::', 'not-an-address']) {
  test(`unsafe VNC bind ${address} is rejected`, { timeout: 20000 }, async t => {
    const f = await fixture(t, { bindAddress: address });
    await f.until(async () => !(await f.state()).Running, 'Unsafe bind did not stop startup', 5000);
    assert.notEqual((await f.state()).ExitCode, 0);
    assert.match(await docker('logs', f.name), /DESKTOP_VNC_BIND_ADDRESS/);
  });
}

test('VNC credentials refuse persistent runtime storage', { timeout: 20000 }, async t => {
  const f = await fixture(t, { runtimeTmpfs: false });
  await f.until(async () => !(await f.state()).Running, 'Missing tmpfs did not stop startup', 5000);
  assert.notEqual((await f.state()).ExitCode, 0);
  assert.match(await docker('logs', f.name), /tmpfs/);
});

test('retained JSON5 configuration stays byte-for-byte unchanged', { timeout: 120000 }, async t => {
  const seed = JSON.parse(await readFile(new URL('../openclaw.json', import.meta.url), 'utf8'));
  seed.ui = { prefs: { locale: 'pl' } };
  const configSource = `// Preserve this operator comment.\n${JSON.stringify(seed, null, 2)}\n`;
  const f = await fixture(t, { configSource });
  await f.ready();
  const digest = await f.evaluate('import fs from "node:fs";import crypto from "node:crypto";console.log(crypto.createHash("sha256").update(fs.readFileSync("/home/node/.openclaw/openclaw.json")).digest("hex"))');
  assert.equal(digest, createHash('sha256').update(configSource).digest('hex'));
});

test('a retained managed display requires explicit migration before startup', { timeout: 20000 }, async t => {
  const seed = JSON.parse(await readFile(new URL('../openclaw.json', import.meta.url), 'utf8'));
  seed.desktop = { host: { enabled: true, managed: true } };
  const f = await fixture(t, { configSource: JSON.stringify(seed) });
  await f.until(async () => !(await f.state()).Running, 'Mismatched desktop mode did not stop startup', 5000);
  assert.notEqual((await f.state()).ExitCode, 0);
  assert.match(await docker('logs', f.name), /managed=false/);
});

test('VNC authenticates and closing viewers preserves the display', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await f.ready();
  const wrong = await f.auth('wrongpwd');
  assert.equal(wrong.authenticated, false);
  assert.match(wrong.reason, /auth|password/i);
  const first = await f.auth();
  assert.equal(first.authenticated, true);
  assert.equal(first.width, 1920);
  assert.equal(first.height, 1080);
  const before = await f.processes();
  assert.equal(before.Xtigervnc.length, 1);
  assert.equal(before['openclaw-gateway'].length, 1);
  assert.equal((await f.auth()).authenticated, true);
  const after = await f.processes();
  assert.deepEqual(after.Xtigervnc, before.Xtigervnc);
  assert.deepEqual(after['openclaw-gateway'], before['openclaw-gateway']);
  const guard = JSON.parse(await f.evaluate(`import fs from 'node:fs';
    const paths=['/run/openclaw-desktop/vnc-password.txt','/run/openclaw-desktop/vnc-password.hash'];
    console.log(JSON.stringify(paths.map(path=>{const s=fs.statSync(path);return {mode:s.mode&511,uid:s.uid}})));`));
  assert.deepEqual(guard, [{ mode: 0o600, uid: 1000 }, { mode: 0o600, uid: 1000 }]);
  for (const pids of Object.values(after)) for (const pid of pids) {
    const exposed = await f.evaluate(`import fs from 'node:fs';console.log(fs.readFileSync('/proc/${pid}/environ','utf8').split('\\0').some(v=>v.startsWith('DESKTOP_VNC_PASSWORD=')))`);
    assert.equal(exposed, 'false', 'desktop children inherited the VNC secret');
  }
});

test('XFCE logout restarts only the visual session', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await f.ready();
  const before = await f.processes();
  assert.equal(before['xfce4-session'].length, 1);
  await f.exec('kill', '-TERM', String(before['xfce4-session'][0]));
  await f.until(async () => {
    const current = await f.processes();
    return current['xfce4-session']?.length === 1 && current['xfce4-session'][0] !== before['xfce4-session'][0];
  }, 'XFCE did not restart on its existing display', 30000);
  const after = await f.processes();
  assert.deepEqual(after.Xtigervnc, before.Xtigervnc);
  assert.deepEqual(after['openclaw-gateway'], before['openclaw-gateway']);
  assert.equal((await f.auth()).authenticated, true);
});

for (const processName of ['Xtigervnc', 'dbus-daemon']) {
  test(`${processName} failure stops the whole stack and allows restart`, { timeout: 180000 }, async t => {
    const f = await fixture(t);
    await f.ready();
    const originalConfig = await f.evaluate('import fs from "node:fs";import crypto from "node:crypto";console.log(crypto.createHash("sha256").update(fs.readFileSync("/home/node/.openclaw/openclaw.json")).digest("hex"))');
    const before = await f.processes();
    assert.equal(before[processName].length, 1);
    await f.exec('kill', '-KILL', String(before[processName][0]));
    await f.until(async () => !(await f.state()).Running, 'Critical failure left the gateway running', 20000);
    assert.notEqual((await f.state()).ExitCode, 0);
    await docker('start', f.name);
    await f.ready();
    const currentConfig = await f.evaluate('import fs from "node:fs";import crypto from "node:crypto";console.log(crypto.createHash("sha256").update(fs.readFileSync("/home/node/.openclaw/openclaw.json")).digest("hex"))');
    assert.equal(currentConfig, originalConfig, 'restart rewrote retained configuration');
  });
}

test('normal shutdown exits without forced termination', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await f.ready();
  await docker('stop', '--time', '20', f.name);
  const state = await f.state();
  assert.equal(state.ExitCode, 0);
  assert.equal(state.OOMKilled, false);
});
