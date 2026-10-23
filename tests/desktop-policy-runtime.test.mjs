import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dockerWithTimeout, image, resourceLimits, root } from './helpers/docker-fixture.mjs';

async function patchPreview(t, content) {
  const directory = await mkdtemp(`${tmpdir()}/openclaw-patch-preview-`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = `${directory}/config.json5`;
  await writeFile(input, content, { mode: 0o644 });
  const output = await dockerWithTimeout(30000, 'run', '--rm', '--network', 'none', ...resourceLimits,
    '--entrypoint', 'node', '--mount', `type=bind,source=${input},target=/input.json5,readonly`,
    image, '/app/deploy/configuration.mjs', '/input.json5');
  assert.equal(await readFile(input, 'utf8'), content);
  return output;
}

test('the packaged CLI previews JSON5 changes without exporting private configuration', async t => {
  const output = await patchPreview(t, `// retained operator comment\n{
    gateway: { auth: { token: 'fixture-sensitive-value' } },
    tools: { alsoAllow: ['llm-task'] },
  }`);
  const patch = JSON.parse(output);
  assert.deepEqual(patch.tools.alsoAllow, ['llm-task', 'computer']);
  assert.equal(patch.gateway, undefined);
  assert.ok(!output.includes('fixture-sensitive-value'));
});

test('the packaged CLI does not leak malformed input in an error', async t => {
  await assert.rejects(() => patchPreview(t, 'fixture-sensitive-value:not-json5:{'), error => {
    assert.equal(error.stdout, '');
    assert.ok(!error.stderr.includes('fixture-sensitive-value'));
    assert.match(error.stderr, /Cannot read or parse the configuration/);
    return true;
  });
});

test('an empty allowlist preserves unrelated plugins in the actual runtime resolver', async () => {
  const output = await dockerWithTimeout(30000, 'run', '--rm', '--network', 'none', ...resourceLimits,
    '--entrypoint', 'node', image, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {normalizePluginsConfig,resolveEffectiveEnableState} from '/app/dist/plugin-sdk/plugin-config-runtime.js';
      import {buildPersistentDesktopPatch} from '/app/deploy/configuration.mjs';
      const before={allow:[],entries:{browser:{enabled:true}}};
      const patch=buildPersistentDesktopPatch({plugins:before});
      const after={...before,...patch.plugins,entries:{...before.entries,...patch.plugins.entries}};
      for(const plugins of [before,after]){
        const result=resolveEffectiveEnableState({id:'browser',origin:'bundled',config:normalizePluginsConfig(plugins),rootConfig:{plugins},enabledByDefault:true});
        assert.equal(result.enabled,true,'activation must not disable the browser plugin');
      }
      console.log('preserved');`);
  assert.equal(output, 'preserved');
});

test('the packaged activation patch enforces the real parent and child tool policies', { timeout: 190000 }, async () => {
  const output = await dockerWithTimeout(180000, 'run', '--rm', '--init', '--network', 'none',
    '--shm-size=1g', ...resourceLimits,
    '--security-opt', 'no-new-privileges:true', '--security-opt', `seccomp=${root}desktop/chromium-seccomp.json`,
    '--tmpfs', '/run/openclaw-desktop:rw,mode=0700,uid=1000,gid=1000',
    '--env', 'OPENCLAW_TEST_ACTIVATION_PATCH=1',
    '--entrypoint', 'node', '--mount', `type=bind,source=${root}tests,target=/app/tests,readonly`,
    image, '/app/tests/native-desktop-proof.mjs');
  assert.match(output, /PASS: shipped activation patch prepared the native desktop and policies/);
  assert.match(output, /PASS: native X11 CUA captured the display and typed the exact form marker/);
  for (const line of [
    'main parent computer=true', 'main child computer=true',
    'unrestricted parent computer=true', 'unrestricted child computer=true',
    'noclegi parent computer=false', 'noclegi child computer=false',
    'samorzad parent computer=false', 'samorzad child computer=false',
    'noclegi -> main spawned child computer=false',
    'samorzad -> unrestricted spawned child computer=false',
  ]) assert.ok(output.includes(`PASS: ${line}`), `missing policy proof: ${line}`);
});
