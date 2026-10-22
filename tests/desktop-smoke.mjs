import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { GatewayClient } from '/app/dist/plugin-sdk/gateway-runtime.js';

// Run only inside a disposable image container, without production volumes.
setTimeout(() => {
  console.error('Desktop smoke test exceeded its three-minute deadline');
  process.exit(1);
}, 180000).unref();
assert.equal(process.getuid(), 1000, 'the gateway must run as node, not root');
const ownStatus = await readFile('/proc/self/status', 'utf8');
assert.match(ownStatus, /^NoNewPrivs:\s+1$/m);
assert.match(ownStatus, /^Seccomp:\s+2$/m);
const config = JSON.parse(await readFile('/app/deploy/openclaw.json', 'utf8'));
assert.equal(config.desktop?.host?.managed, true);
assert.equal(config.plugins?.entries?.['cua-computer']?.enabled, true);
const stateDir = '/tmp/openclaw-desktop-smoke';
await mkdir(stateDir, { recursive: true });
const token = randomUUID();
config.gateway = { ...config.gateway, bind: 'loopback', auth: { mode: 'token', token } };
config.agents.defaults.heartbeat = { every: '0m' };
await writeFile(`${stateDir}/openclaw.json`, JSON.stringify(config));

let submitted;
let pageLoaded = false;
const fixture = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/submit') {
    submitted = url.searchParams.get('proof');
    res.end('Desktop input received');
    return;
  }
  if (url.pathname === '/ready') {
    pageLoaded = true;
    res.end('ready');
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<title>Desktop smoke test</title><h1>Desktop smoke test</h1>' +
    '<form action="/submit"><input name="proof" autofocus><button>Send</button></form>' +
    '<script>addEventListener("load", () => { document.querySelector("input").focus(); fetch("/ready"); });</script>');
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;

let logs = '';
const gateway = spawn('node', ['openclaw.mjs', 'gateway', 'run'], {
  cwd: '/app',
  detached: true,
  env: {
    ...process.env,
    OPENCLAW_CONFIG_PATH: `${stateDir}/openclaw.json`,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_ALLOWED_ORIGINS: 'http://localhost:18789',
    LITELLM_BASE_URL: 'http://127.0.0.1:9/v1',
    LITELLM_API_KEY: 'test-only-key',
    LITELLM_MODEL: 'deepseek/deepseek-v4-pro',
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_SKIP_CHANNELS: '1',
    OPENCLAW_SKIP_GMAIL_WATCHER: '1',
    OPENCLAW_SKIP_CRON: '1',
    OPENCLAW_CODEX_DISCOVERY_LIVE: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const gatewayExit = once(gateway, 'exit');
for (const output of [gateway.stdout, gateway.stderr]) {
  output.on('data', chunk => { logs = (logs + chunk).slice(-64000); });
}

async function until(check, message, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null) throw new Error(`Gateway exited: ${gateway.exitCode}`);
    if (await check()) return;
    await delay(200);
  }
  throw new Error(message);
}

let client;
let chromium;
try {
  await until(async () => {
    try { return (await fetch('http://127.0.0.1:18789/healthz', { signal: AbortSignal.timeout(2000) })).ok; }
    catch (error) {
      if (['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code) || error.name === 'TimeoutError') return false;
      throw error;
    }
  }, 'Gateway did not become healthy');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gateway connection timed out')), 30000);
    client = new GatewayClient({
      url: 'ws://127.0.0.1:18789', token, deviceIdentity: null,
      clientName: 'cli', mode: 'cli', scopes: ['operator.read', 'operator.write', 'operator.admin'],
      onHelloOk: () => { clearTimeout(timer); resolve(); },
      onConnectError: error => { clearTimeout(timer); reject(error); },
    });
    client.start();
  });

  const computer = await client.request('computer.status', {}, { timeoutMs: 90000 });
  assert.equal(computer.available, true, JSON.stringify(computer));
  assert.equal(computer.computerUse.provider.id, 'cua-computer');
  console.log('PASS: managed desktop and CUA provider are available');
  const generation = computer.computerUse.provider.generation;
  const executionId = randomUUID();
  let sequence = 0;
  async function invoke(command, params) {
    const result = await client.request('computer.invoke', {
      command, generation, params: { ...params, executionId },
      timeoutMs: 60000, idempotencyKey: `desktop-smoke-${++sequence}`,
    }, { timeoutMs: 90000 });
    return result.payload;
  }

  const observation = await client.request('desktop.observe', { source: { kind: 'host' }, control: false }, { timeoutMs: 30000 });
  const viewer = new WebSocket(new URL(observation.wsPath, 'ws://127.0.0.1:18789'));
  viewer.binaryType = 'arraybuffer';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Desktop stream did not send an RFB greeting')), 10000);
      viewer.addEventListener('message', event => {
        clearTimeout(timer);
        try { assert.match(Buffer.from(event.data).toString('ascii'), /^RFB 003\./); resolve(); }
        catch (error) { reject(error); }
      }, { once: true });
      viewer.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Desktop stream failed')); }, { once: true });
    });
    console.log('PASS: WebUI desktop endpoint speaks RFB');
  } finally { viewer.close(); }

  const screenshot = await invoke('screen.snapshot', { format: 'png', maxWidth: 1280 });
  assert.ok(screenshot.displayFrameId, 'CUA must identify the observed desktop');
  const png = Buffer.from(screenshot.base64, 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
  console.log('PASS: CUA returned a PNG desktop screenshot');

  const displays = (await readdir('/tmp/.X11-unix')).filter(name => /^X\d+$/.test(name));
  assert.equal(displays.length, 1, 'the test must use the one managed desktop');
  chromium = spawn('chromium', ['--no-first-run', '--no-default-browser-check', fixtureUrl], {
    env: { ...process.env, DISPLAY: `:${displays[0].slice(1)}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const output of [chromium.stdout, chromium.stderr]) {
    output.on('data', chunk => { logs = (logs + chunk).slice(-64000); });
  }
  await until(() => {
    assert.equal(chromium.exitCode, null, 'Chromium exited before loading the fixture');
    return pageLoaded;
  }, 'Chromium did not load the test form', 30000);
  let checkedRenderer = false;
  for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
    try {
      if ((await readFile(`/proc/${pid}/comm`, 'utf8')).trim() !== 'chromium') continue;
      // Chromium rewrites renderer argv as a space-separated process title.
      const commandLine = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
      if (!/(?:^|\s)--type=renderer(?:\s|$)/.test(commandLine)) continue;
      assert.doesNotMatch(commandLine, /(?:^|\s)--no-sandbox(?:\s|$)/);
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      assert.match(status, /^NoNewPrivs:\s+1$/m);
      assert.match(status, /^Seccomp:\s+2$/m);
      const ownFilters = Number(ownStatus.match(/^Seccomp_filters:\s+(\d+)$/m)?.[1]);
      const rendererFilters = Number(status.match(/^Seccomp_filters:\s+(\d+)$/m)?.[1]);
      assert.ok(rendererFilters > ownFilters, 'Chromium must install its own sandbox filter');
      checkedRenderer = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  assert.equal(checkedRenderer, true, 'no sandboxed Chromium renderer found');
  console.log('PASS: Chromium renderer has its own seccomp sandbox and no-new-privileges');
  const marker = `desktop-proof-${randomUUID()}`;
  const typed = await invoke('computer.act', { action: 'type', text: marker });
  assert.equal(typed.ok, true, JSON.stringify(typed));
  const entered = await invoke('computer.act', { action: 'key', keys: 'Return' });
  assert.equal(entered.ok, true, JSON.stringify(entered));
  await until(() => submitted !== undefined, 'CUA did not submit the form', 10000);
  assert.equal(submitted, marker);
  console.log('PASS: CUA typed and submitted the expected text in desktop Chromium');
  const files = await readdir('/home/node/.openclaw/desktop/chromium');
  assert.ok(files.includes('Default'), 'Chromium must use the persistent profile directory');
  console.log('PASS: Chromium used the profile inside openclaw_state');
  await invoke('computer.act', { action: '__close_execution', reason: 'smoke-test-complete' });
} catch (error) {
  console.error(logs.replaceAll(token, '<REDACTED>'));
  throw error;
} finally {
  chromium?.kill('SIGTERM');
  client?.stop();
  fixture.closeAllConnections();
  fixture.close();
  if (gateway.exitCode === null) {
    process.kill(-gateway.pid, 'SIGTERM');
    const stopped = await Promise.race([gatewayExit.then(() => true), delay(10000).then(() => false)]);
    if (!stopped) { process.kill(-gateway.pid, 'SIGKILL'); await gatewayExit; }
  }
}
