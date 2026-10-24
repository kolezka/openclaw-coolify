import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const seed = JSON.parse(readFileSync(new URL('../openclaw.json', import.meta.url), 'utf8'));

// An override of undefined removes that variable from the environment.
function compose(overrides = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OPENCLAW_GATEWAY_TOKEN: 'test-only-token',
    OPENCLAW_ALLOWED_ORIGINS: 'https://test.invalid',
    LITELLM_BASE_URL: 'https://test.invalid/v1',
    LITELLM_API_KEY: 'test-only-key',
    LITELLM_MODEL: 'test-only-model',
    DESKTOP_VNC_PASSWORD: 'testpass',
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return JSON.parse(execFileSync('docker', [
    'compose', '--project-directory', root, 'config', '--format', 'json',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }));
}

test('a new deployment attaches WebUI to the persistent display', () => {
  assert.equal(seed.desktop?.host?.enabled, true);
  assert.equal(seed.desktop?.host?.managed, false);
  assert.equal(seed.desktop.host.port, 5900);
  assert.equal(seed.desktop.host.passwordFile, '/run/openclaw-desktop/vnc-password.txt');
});

test('the gateway explicitly enables its computer provider and tool', () => {
  assert.equal(seed.plugins?.entries?.['cua-computer']?.enabled, true);
  assert.ok(seed.tools?.alsoAllow?.includes('computer'));
  assert.ok(!seed.tools?.deny?.includes('computer'));
});

test('desktop deployment retains private ports and the existing state volume', () => {
  const service = compose().services.openclaw;
  assert.deepEqual(service.ports.map(p => [p.host_ip, p.published, p.target]), [
    ['127.0.0.1', '18789', 18789],
    ['127.0.0.1', '18790', 18790],
    ['127.0.0.1', '5901', 5900],
  ]);
  assert.deepEqual(service.volumes.map(v => [v.type, v.source, v.target]), [
    ['volume', 'openclaw_state', '/home/node/.openclaw'],
  ]);
  assert.notEqual(service.privileged, true);
  assert.equal(service.network_mode, undefined);
  assert.ok(!service.cap_add?.includes('SYS_ADMIN'));
  assert.ok(Number(service.shm_size) >= 512 * 1024 * 1024, 'the desktop needs a shared-memory budget');
});

test('desktop keeps seccomp confinement and prevents privilege escalation', () => {
  const service = compose().services.openclaw;
  const options = service.security_opt ?? [];
  assert.ok(options.some(option => /^no-new-privileges[:=]true$/.test(option)));
  assert.ok(options.some(option => option.startsWith('seccomp=') && option.endsWith('desktop/chromium-seccomp.json')));
  assert.ok(options.every(option => !option.includes('unconfined')));
  const policy = JSON.parse(readFileSync(new URL('../desktop/chromium-seccomp.json', import.meta.url), 'utf8'));
  assert.equal(policy.defaultAction, 'SCMP_ACT_ERRNO');
  for (const name of ['clone', 'setns', 'unshare']) {
    assert.ok(policy.syscalls.some(rule => rule.action === 'SCMP_ACT_ALLOW' &&
      rule.names.includes(name) && !rule.args && !rule.includes && !rule.excludes));
  }
});

test('runtime secrets use private tmpfs and LAN publication must be explicit', () => {
  const service = compose({ DESKTOP_VNC_BIND_ADDRESS: '192.168.42.10' }).services.openclaw;
  const vnc = service.ports.find(port => port.target === 5900);
  assert.equal(vnc?.host_ip, '192.168.42.10');
  assert.ok(service.tmpfs?.some(mount => mount.startsWith('/run/openclaw-desktop:') &&
    /mode=0?700/.test(mount) && mount.includes('uid=1000') && mount.includes('gid=1000')));
  assert.ok(!Object.hasOwn(service.build.args, 'DESKTOP_VNC_PASSWORD'));
});

// Coolify interpolates the whole file during the build, where runtime-only secrets are absent.
// The container still refuses a missing password at startup (persistent-desktop.test.mjs).
test('Compose resolves for a build that lacks runtime-only secrets', () => {
  for (const password of [undefined, '']) {
    const service = compose({ DESKTOP_VNC_PASSWORD: password }).services.openclaw;
    assert.ok(!Object.hasOwn(service.build.args, 'DESKTOP_VNC_PASSWORD'));
    assert.equal(service.environment.DESKTOP_VNC_PASSWORD, '');
  }
});

test('Compose accepts an explicit image version without adding VNC to the proxy exposure list', () => {
  const service = compose({ OPENCLAW_VERSION: 'test-version' }).services.openclaw;
  assert.equal(service.build.args.OPENCLAW_VERSION, 'test-version');
  assert.deepEqual(service.expose, ['18789', '18790']);
});
