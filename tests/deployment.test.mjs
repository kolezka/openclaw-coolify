import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const seed = JSON.parse(readFileSync(new URL('../openclaw.json', import.meta.url), 'utf8'));

function compose(overrides = {}) {
  return JSON.parse(execFileSync('docker', [
    'compose', '--project-directory', root, 'config', '--format', 'json',
  ], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OPENCLAW_GATEWAY_TOKEN: 'test-only-token',
      OPENCLAW_ALLOWED_ORIGINS: 'https://test.invalid',
      LITELLM_BASE_URL: 'https://test.invalid/v1',
      LITELLM_API_KEY: 'test-only-key',
      LITELLM_MODEL: 'test-only-model',
      ...overrides,
    },
  }));
}

test('a new deployment selects the managed desktop, not an external VNC display', () => {
  assert.equal(seed.desktop?.host?.enabled, true);
  assert.equal(seed.desktop?.host?.managed, true);
  assert.equal(seed.desktop.host.port, undefined);
  assert.equal(seed.desktop.host.passwordFile, undefined);
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

test('Compose accepts an explicit image version without exposing desktop ports', () => {
  const service = compose({ OPENCLAW_VERSION: 'test-version' }).services.openclaw;
  assert.equal(service.build.args.OPENCLAW_VERSION, 'test-version');
  assert.deepEqual(service.expose, ['18789', '18790']);
});
