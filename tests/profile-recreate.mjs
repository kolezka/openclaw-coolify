import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const image = process.env.OPENCLAW_TEST_IMAGE ?? 'openclaw-desktop:test';
const id = `openclaw-profile-test-${randomUUID()}`;
const container = `${id}-browser`;
const volume = `${id}-state`;
const env = {
  ...process.env,
  OPENCLAW_GATEWAY_TOKEN: 'test-only-token',
  OPENCLAW_ALLOWED_ORIGINS: 'https://test.invalid',
  LITELLM_BASE_URL: 'https://test.invalid/v1',
  LITELLM_API_KEY: 'test-only-key',
  LITELLM_MODEL: 'test-only-model',
};
function docker(...args) {
  return execFileSync('docker', args, { cwd: root, env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
}
const service = JSON.parse(docker('compose', 'config', '--format', 'json')).services.openclaw;
const security = service.security_opt.flatMap(option => ['--security-opt', option]);
const hostname = service.hostname ? ['--hostname', service.hostname] : [];
const common = ['--network', 'none', '--shm-size=1g', ...security, ...hostname,
  '--mount', `type=volume,source=${volume},target=/home/node/.openclaw`, '--entrypoint', 'chromium'];
let exists = false;
let primaryError;
try {
  docker('volume', 'create', volume);
  docker('run', '-d', '--name', container, ...common, image,
    '--headless', '--no-first-run', '--remote-debugging-port=9222', 'about:blank');
  exists = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = docker('exec', container, 'node', '-e',
        'fetch("http://127.0.0.1:9222/json/version").then(r=>r.json()).then(r=>console.log(r.Browser)).catch(()=>process.exit(1))');
      assert.match(response, /Chrome\//);
      ready = true;
      break;
    } catch (error) {
      const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', container));
      if (!state.Running) throw new Error(`Chromium exited: ${docker('logs', container)}`, { cause: error });
      if (attempt === 59) throw error;
      await delay(100);
    }
  }
  assert.equal(ready, true);
  docker('kill', container);
  docker('rm', container);
  exists = false;
  const html = docker('run', '--rm', ...common, image,
    '--headless', '--no-first-run', '--dump-dom', 'data:text/html,<title>profile-reopened</title>');
  assert.match(html, /<title>profile-reopened<\/title>/);
  console.log('PASS: Chromium reopened the retained profile after an unclean container replacement');
} catch (error) {
  primaryError = error;
  if (error.stderr) console.error(error.stderr.toString());
  throw error;
} finally {
  try {
    if (exists) docker('rm', '-f', container);
    docker('volume', 'rm', volume);
  } catch (error) {
    if (!primaryError) throw error;
    console.error('Test resource cleanup failed:', error.message);
  }
}
