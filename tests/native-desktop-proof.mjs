import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { mergePatch } from './helpers/merge-patch.mjs';

assert.equal(process.getuid(), 1000);
const root = await mkdtemp(`${tmpdir()}/openclaw-native-proof-`);
const token = randomUUID();
const verifyPatch = process.env.OPENCLAW_TEST_ACTIVATION_PATCH === '1';
const runtime = verifyPatch ? '/run/openclaw-desktop' : `${root}/runtime`;
await mkdir(runtime, { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  DISPLAY: ':1',
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
  OPENCLAW_CONFIG_PATH: `${root}/openclaw.json`,
  OPENCLAW_STATE_DIR: root,
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
};
Object.assign(process.env, env);
let config = JSON.parse(await readFile('/app/deploy/openclaw.json', 'utf8'));
config.gateway = { ...config.gateway, bind: 'loopback', auth: { mode: 'token', token },
  // The operator RPC surface otherwise adds its own computer deny to every child.
  tools: { allow: ['sessions_spawn', 'computer'] },
};
config.desktop = { host: { enabled: true, managed: false, port: 5900, passwordFile: `${runtime}/vnc-password.txt` } };
config.agents.ownership = 'explicit';
config.agents.defaults.heartbeat = { every: '0m', agentId: 'main' };
config.agents.defaults.systemAgent = { agentId: 'main' };
config.agents.entries = Object.fromEntries(['main', 'unrestricted', 'noclegi', 'samorzad'].map(id => [id, {
  workspace: `${root}/workspaces/${id}`,
  subagents: { allowAgents: ['*'] },
  ...['noclegi', 'samorzad'].includes(id) ? { tools: { deny: ['computer', 'gateway'] } } : {},
}]));
if (verifyPatch) {
  config.desktop = { host: { enabled: true, managed: true } };
  config.plugins.entries['cua-computer'].enabled = false;
  config.tools.alsoAllow = ['llm-task'];
  for (const id of ['noclegi', 'samorzad']) config.agents.entries[id].tools.deny = ['gateway'];
  const { buildPersistentDesktopPatch } = await import('/app/deploy/configuration.mjs');
  config = mergePatch(config, buildPersistentDesktopPatch(config));
  console.log('PASS: shipped activation patch prepared the native desktop and policies');
}
await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config), { mode: 0o600 });
await writeFile(`${runtime}/vnc-password.txt`, 'testpass', { mode: 0o600 });
const password = spawnSync('tigervncpasswd', ['-f'], { input: 'testpass\n', env });
assert.equal(password.status, 0, password.stderr?.toString());
await writeFile(`${runtime}/password.hash`, password.stdout, { mode: 0o600 });

const { GatewayClient } = await import('/app/dist/plugin-sdk/gateway-runtime.js');
const { upsertSessionEntry, getSessionEntry, resolveStorePath } = await import('/app/dist/plugin-sdk/session-store-runtime.js');
const sessions = [];
for (const agentId of Object.keys(config.agents.entries)) {
  await mkdir(config.agents.entries[agentId].workspace, { recursive: true });
  const storePath = resolveStorePath(undefined, { agentId, env });
  const parentKey = `agent:${agentId}:native-proof`;
  const parent = { sessionId: randomUUID(), updatedAt: Date.now() };
  await upsertSessionEntry({ agentId, storePath, env, sessionKey: parentKey, entry: parent });
  sessions.push({ agentId, parentKey, allowed: !['noclegi', 'samorzad'].includes(agentId) });
}

const children = [];
let logs = '';
function launch(name, args) {
  const child = spawn(name, args, { cwd: '/app', env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const output of [child.stdout, child.stderr]) output.on('data', data => { logs = (logs + data).slice(-64000); });
  child.on('error', error => { logs += `${name}: ${error.message}\n`; });
  return child;
}
async function until(check, message, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const dead = children.find(child => child.exitCode !== null || child.signalCode !== null);
    if (dead) throw new Error(`${message}: child exited (${dead.exitCode ?? dead.signalCode})`);
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}
const deadline = setTimeout(() => { console.error('Native proof timed out'); process.exit(1); }, 180000);
deadline.unref();
let client;
let loaded = false;
let submitted;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ready') { loaded = true; res.end('ready'); return; }
  if (url.pathname === '/submit') { submitted = url.searchParams.get('proof'); res.end('received'); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end('<title>Native desktop proof</title><form action="/submit"><input name="proof"><button>Send</button></form>' +
    '<script>addEventListener("load",()=>{document.querySelector("input").focus();fetch("/ready")})</script>');
});
try {
  launch('dbus-daemon', ['--session', '--nofork', '--nopidfile', `--address=${env.DBUS_SESSION_BUS_ADDRESS}`]);
  launch('Xtigervnc', [':1', '-geometry', '1280x800', '-depth', '24', '-localhost', 'yes',
    '-rfbport', '5900', '-SecurityTypes', 'VncAuth', '-PasswordFile', `${runtime}/password.hash`,
    '-AlwaysShared', '-nolisten', 'tcp', '-ac']);
  await until(async () => {
    try { return (await stat('/tmp/.X11-unix/X1')).isSocket() && (await stat(`${runtime}/bus`)).isSocket(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, 'Native display and bus did not start', 10000);
  launch('startxfce4', []);
  launch('node', ['openclaw.mjs', 'gateway', 'run']);
  await until(async () => {
    try { return (await fetch('http://127.0.0.1:18789/healthz', { signal: AbortSignal.timeout(2000) })).ok; }
    catch (error) {
      if (['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code) || error.name === 'TimeoutError') return false;
      throw error;
    }
  }, 'Native gateway did not become healthy');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gateway connect timeout')), 30000);
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
  const executionId = randomUUID();
  let sequence = 0;
  async function invoke(command, params) {
    const result = await client.request('computer.invoke', {
      command, generation: computer.computerUse.provider.generation,
      params: { ...params, executionId }, timeoutMs: 60000,
      idempotencyKey: `native-proof-${++sequence}`,
    }, { timeoutMs: 90000 });
    return result.payload;
  }
  const screenshot = await invoke('screen.snapshot', { format: 'png', maxWidth: 1280 });
  assert.ok(screenshot.displayFrameId);
  assert.equal(Buffer.from(screenshot.base64, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  launch('chromium', ['--no-first-run', '--no-default-browser-check', `http://127.0.0.1:${server.address().port}`]);
  await until(() => loaded, 'Chromium did not show the native-display fixture', 30000);
  const marker = `native-cua-${randomUUID()}`;
  assert.equal((await invoke('computer.act', { action: 'type', text: marker })).ok, true);
  assert.equal((await invoke('computer.act', { action: 'key', keys: 'Return' })).ok, true);
  await until(() => submitted !== undefined, 'Native CUA did not submit the form', 10000);
  assert.equal(submitted, marker);
  console.log('PASS: native X11 CUA captured the display and typed the exact form marker');
  await invoke('computer.act', { action: '__close_execution', reason: 'native-proof-complete' });

  async function checkPolicy(agentId, sessionKey, allowed, label) {
    const effective = await client.request('tools.effective', { agentId, sessionKey }, { timeoutMs: 60000 });
    assert.ok(Array.isArray(effective.groups), 'real tool inventory is required');
    const present = effective.groups.flatMap(group => group.tools).some(tool => tool.id === 'computer');
    assert.equal(present, allowed, `${label} computer permission`);
    console.log(`PASS: ${label} computer=${present}`);
  }
  async function spawnChild(parent, target) {
    const response = await client.request('tools.invoke', {
      name: 'sessions_spawn', agentId: parent.agentId, sessionKey: parent.parentKey,
      args: { task: 'Isolated policy fixture. Reply ok.', agentId: target, cleanup: 'keep' },
    }, { timeoutMs: 60000 });
    assert.equal(response.ok, true, JSON.stringify(response));
    const result = JSON.parse(response.output.content.find(part => part.type === 'text').text);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    assert.ok(result.childSessionKey.startsWith(`agent:${target}:subagent:`));
    const storePath = resolveStorePath(undefined, { agentId: target, env });
    const stored = getSessionEntry({ agentId: target, storePath, env, sessionKey: result.childSessionKey });
    assert.equal(stored.spawnedBy, parent.parentKey, 'real spawn must persist parent provenance');
    assert.equal(stored.spawnDepth, 1);
    assert.equal(stored.inheritedToolPolicyVersion, 1);
    assert.equal(stored.inheritedToolDeny?.includes('computer') ?? false, !parent.allowed,
      'real spawn must inherit the parent computer deny, not a hand-written fixture');
    return result.childSessionKey;
  }
  for (const session of sessions) {
    await checkPolicy(session.agentId, session.parentKey, session.allowed, `${session.agentId} parent`);
    const childKey = await spawnChild(session, session.agentId);
    await checkPolicy(session.agentId, childKey, session.allowed, `${session.agentId} child`);
  }
  // An unrestricted target removes the child's own agent deny as a false positive.
  for (const [parentId, target] of [['noclegi', 'main'], ['samorzad', 'unrestricted']]) {
    const parent = sessions.find(session => session.agentId === parentId);
    const childKey = await spawnChild(parent, target);
    await checkPolicy(target, childKey, false, `${parentId} -> ${target} spawned child`);
  }
} catch (error) {
  console.error(logs.replaceAll(token, '<REDACTED>'));
  throw error;
} finally {
  client?.stop();
  server.closeAllConnections();
  server.close();
  for (const child of children.toReversed()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await delay(500);
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  clearTimeout(deadline);
}
