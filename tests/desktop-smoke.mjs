import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { connectVnc } from './vnc-client.mjs';

assert.equal(process.env.OPENCLAW_TEST_FIXTURE, '1', 'run only in a disposable test fixture');
assert.equal(process.getuid(), 1000);
const { GatewayClient } = await import('/app/dist/plugin-sdk/gateway-runtime.js');
const watchdog = setTimeout(() => { console.error('Desktop smoke test timed out'); process.exit(1); }, 180000);
watchdog.unref();
const ownStatus = await readFile('/proc/self/status', 'utf8');
assert.match(ownStatus, /^NoNewPrivs:\s+1$/m);
assert.match(ownStatus, /^Seccomp:\s+2$/m);
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
assert.ok(token);
let loaded = false;
let input = '';
let submitted;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ready') { loaded = true; res.end('ready'); return; }
  if (url.pathname === '/progress') { input = url.searchParams.get('value'); res.end('received'); return; }
  if (url.pathname === '/submit') { submitted = url.searchParams.get('proof'); res.end('received'); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end('<title>Desktop smoke test</title><h1>Desktop smoke test</h1>' +
    '<form action="/submit"><input name="proof"><button>Send</button></form>' +
    '<script>addEventListener("load",()=>{const e=document.querySelector("input");e.focus();' +
    'e.addEventListener("input",()=>fetch("/progress?value="+encodeURIComponent(e.value)));fetch("/ready")})</script>');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const children = [];
let logs = '';
const childEnv = { ...process.env };
delete childEnv.DESKTOP_VNC_PASSWORD;
function launch(command, args) {
  const child = spawn(command, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const output of [child.stdout, child.stderr]) output.on('data', chunk => { logs = (logs + chunk).slice(-64000); });
  return child;
}
async function until(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}
let client;
let nativeViewer;
try {
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
  const computer = await client.request('computer.status', {}, { timeoutMs: 60000 });
  assert.equal(computer.available, true, JSON.stringify(computer));
  assert.equal(computer.computerUse.provider.id, 'cua-computer');
  const executionId = randomUUID();
  let sequence = 0;
  async function invoke(command, params) {
    const result = await client.request('computer.invoke', {
      command, generation: computer.computerUse.provider.generation,
      params: { ...params, executionId }, timeoutMs: 60000,
      idempotencyKey: `desktop-smoke-${++sequence}`,
    }, { timeoutMs: 90000 });
    return result.payload;
  }
  const observation = await client.request('desktop.observe', { source: { kind: 'host' }, control: false }, { timeoutMs: 30000 });
  const viewer = new WebSocket(new URL(observation.wsPath, 'ws://127.0.0.1:18789'));
  viewer.binaryType = 'arraybuffer';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebUI desktop greeting timed out')), 10000);
      viewer.addEventListener('message', event => {
        clearTimeout(timer);
        try { assert.match(Buffer.from(event.data).toString('ascii'), /^RFB 003\./); resolve(); }
        catch (error) { reject(error); }
      }, { once: true });
      viewer.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebUI desktop stream failed')); }, { once: true });
    });
  } finally { viewer.close(); }
  console.log('PASS: WebUI desktop endpoint reaches the persistent display');
  const screenshot = await invoke('screen.snapshot', { format: 'png', maxWidth: 1280 });
  assert.ok(screenshot.displayFrameId);
  assert.equal(Buffer.from(screenshot.base64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  console.log('PASS: native CUA returned a PNG desktop screenshot');

  const terminalTitle = `Desktop terminal ${randomUUID()}`;
  launch('xfce4-terminal', ['--disable-server', '--title', terminalTitle]);
  await until(async () => {
    const result = await invoke('computer.act', { action: 'list_windows' });
    assert.equal(result.ok, true);
    return JSON.stringify(result.details).includes(terminalTitle);
  }, 'CUA could not discover the terminal window');
  console.log('PASS: terminal window is visible to CUA');
  launch('openclaw-desktop-browser', [`http://127.0.0.1:${server.address().port}`]);
  await until(() => loaded, 'The desktop browser did not load the fixture');
  let browserWindow;
  await until(async () => {
    const windows = await invoke('computer.act', { action: 'list_windows' });
    assert.ok(Array.isArray(windows.details?.windows), 'CUA must return real window records');
    browserWindow = windows.details.windows.find(window => window.title?.includes('Desktop smoke test'));
    return Boolean(browserWindow?.windowRef);
  }, 'Browser window was not discovered by CUA');
  assert.equal((await invoke('computer.act', { action: 'bring_to_front', windowRef: browserWindow.windowRef })).ok, true);

  let checkedRenderer = false;
  for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
    try {
      if (!['chrome', 'chromium'].includes((await readFile(`/proc/${pid}/comm`, 'utf8')).trim())) continue;
      const commandLine = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
      if (!/(?:^|\s)--type=renderer(?:\s|$)/.test(commandLine)) continue;
      assert.doesNotMatch(commandLine, /(?:^|\s)--no-sandbox(?:\s|$)/);
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      assert.match(status, /^NoNewPrivs:\s+1$/m);
      assert.match(status, /^Seccomp:\s+2$/m);
      assert.ok(Number(status.match(/^Seccomp_filters:\s+(\d+)$/m)?.[1]) >
        Number(ownStatus.match(/^Seccomp_filters:\s+(\d+)$/m)?.[1]));
      checkedRenderer = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.equal(checkedRenderer, true);
  console.log('PASS: browser renderer has its own seccomp sandbox and no-new-privileges');
  nativeViewer = await connectVnc({ password: process.env.VNC_TEST_PASSWORD ?? 'testpass' });
  assert.equal(nativeViewer.authenticated, true);
  const prefix = `vnc-${randomUUID()}`;
  const suffix = `-cua-${randomUUID()}`;
  nativeViewer.type(prefix);
  await until(() => input === prefix, 'Native VNC input did not reach the browser form');
  assert.equal((await invoke('computer.act', { action: 'type', text: suffix })).ok, true);
  await until(() => input === prefix + suffix, 'CUA did not append to the same browser input');
  assert.equal((await invoke('computer.act', { action: 'key', keys: 'Return' })).ok, true);
  await until(() => submitted !== undefined, 'The shared form was not submitted');
  assert.equal(submitted, prefix + suffix);
  console.log('PASS: native VNC and CUA submitted the exact combined marker');
  const profile = process.arch === 'x64' ? '/home/node/.openclaw/desktop/google-chrome' : '/home/node/.openclaw/desktop/chromium';
  assert.ok((await readdir(profile)).includes('Default'));
  console.log('PASS: browser profile is inside the persistent state volume');
  await invoke('computer.act', { action: '__close_execution', reason: 'smoke-test-complete' });
} catch (error) {
  console.error(logs.replaceAll(token, '<REDACTED>'));
  throw error;
} finally {
  nativeViewer?.close();
  for (const child of children) child.kill('SIGTERM');
  client?.stop();
  server.closeAllConnections();
  server.close();
  clearTimeout(watchdog);
}
