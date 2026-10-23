import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { mergePatch } from './helpers/merge-patch.mjs';

async function build(config) {
  const path = new URL('../desktop/configuration.mjs', import.meta.url);
  assert.ok(existsSync(path), 'persistent desktop patch helper is not implemented');
  const { buildPersistentDesktopPatch } = await import(path.href);
  return buildPersistentDesktopPatch(config);
}

function currentConfig() {
  return {
    gateway: { mode: 'local', auth: { token: 'fixture-sensitive-value' } },
    desktop: { host: { enabled: true, managed: true } },
    plugins: {
      allow: ['hindsight-openclaw', 'llm-task'],
      entries: {
        'hindsight-openclaw': { enabled: true, config: { apiKey: 'fixture-sensitive-value' } },
        'cua-computer': { enabled: false, config: { driverPath: 'preserve-existing' } },
      },
    },
    tools: { alsoAllow: ['llm-task'], deny: ['gateway'], byProvider: { fixture: { deny: ['web_search'] } } },
    agents: {
      ownership: 'explicit',
      entries: {
        main: { name: 'KWAK', workspace: '/existing/main', model: 'fixture/existing' },
        noclegi: { workspace: '/existing/noclegi', tools: { deny: ['gateway', 'terminal'] } },
        samorzad: { workspace: '/existing/samorzad', tools: { deny: ['screen', 'computer', 'secrets'] } },
        other: { tools: { alsoAllow: ['browser'] }, identity: { name: 'Keep me' } },
      },
    },
    models: { providers: { fixture: { apiKey: 'fixture-sensitive-value' } } },
    memory: { search: { provider: 'fixture' } },
    skills: { load: { extraDirs: ['/home/node/brain/skills'] } },
  };
}

test('the activation patch sets only the intended desktop and global grants', async () => {
  const patch = await build(currentConfig());
  assert.deepEqual(patch.desktop, { host: {
    enabled: true, managed: false, port: 5900,
    passwordFile: '/run/openclaw-desktop/vnc-password.txt',
  } });
  assert.deepEqual(patch.tools, { alsoAllow: ['llm-task', 'computer'] });
  assert.deepEqual(patch.plugins, {
    allow: ['hindsight-openclaw', 'llm-task', 'cua-computer'],
    entries: { 'cua-computer': { enabled: true } },
  });
  assert.ok(!JSON.stringify(patch).includes('fixture-sensitive-value'));
});

test('both excluded agents keep their other denials and metadata', async () => {
  const original = currentConfig();
  const result = mergePatch(original, await build(original));
  assert.deepEqual(result.agents.entries.noclegi.tools.deny, ['gateway', 'terminal', 'computer']);
  assert.deepEqual(result.agents.entries.samorzad.tools.deny, ['screen', 'computer', 'secrets']);
  assert.equal(result.agents.entries.noclegi.workspace, '/existing/noclegi');
  assert.equal(result.agents.entries.samorzad.workspace, '/existing/samorzad');
  assert.deepEqual(result.agents.entries.main, original.agents.entries.main);
  assert.deepEqual(result.agents.entries.other, original.agents.entries.other);
});

test('the patch preserves credentials, models, memory, brain and unrelated tool rules', async () => {
  const original = currentConfig();
  const before = structuredClone(original);
  const patch = await build(original);
  const result = mergePatch(original, patch);
  assert.deepEqual(original, before, 'building a patch mutated its input');
  for (const key of ['gateway', 'models', 'memory', 'skills']) {
    assert.equal(patch[key], undefined);
    assert.deepEqual(result[key], original[key]);
  }
  assert.deepEqual(result.tools.deny, original.tools.deny);
  assert.deepEqual(result.tools.byProvider, original.tools.byProvider);
  assert.deepEqual(result.plugins.entries['hindsight-openclaw'], original.plugins.entries['hindsight-openclaw']);
  assert.deepEqual(result.plugins.entries['cua-computer'].config, original.plugins.entries['cua-computer'].config);
});

test('repeated activation does not duplicate grants or agent denials', async () => {
  const first = mergePatch(currentConfig(), await build(currentConfig()));
  const second = mergePatch(first, await build(first));
  assert.deepEqual(second, first);
});

test('a new or minimal configuration does not acquire invented agents or a plugin allowlist', async () => {
  const patch = await build({});
  assert.equal(patch.agents, undefined);
  assert.equal(patch.plugins.allow, undefined);
  assert.deepEqual(patch.tools.alsoAllow, ['computer']);
});

test('an empty unrestricted plugin allowlist is not narrowed to CUA alone', async () => {
  const config = { plugins: { allow: [], entries: { browser: { enabled: true } } } };
  const patch = await build(config);
  assert.equal(patch.plugins.allow, undefined);
  const result = mergePatch(config, patch);
  assert.deepEqual(result.plugins.allow, []);
  assert.deepEqual(result.plugins.entries.browser, { enabled: true });
});

test('existing case-insensitive computer entries are not duplicated', async () => {
  const config = currentConfig();
  config.tools.alsoAllow = ['COMPUTER', 'llm-task'];
  config.agents.entries.noclegi.tools.deny = ['Computer', 'gateway'];
  const patch = await build(config);
  assert.deepEqual(patch.tools.alsoAllow, ['COMPUTER', 'llm-task']);
  assert.deepEqual(patch.agents.entries.noclegi.tools.deny, ['Computer', 'gateway']);
});

test('legacy rosters and malformed policy lists fail instead of silently replacing permissions', async () => {
  await assert.rejects(() => build({ agents: { list: [{ id: 'main' }] } }), /agents\.entries/);
  await assert.rejects(() => build({ tools: { alsoAllow: 'computer' } }), /tools\.alsoAllow/);
  await assert.rejects(() => build({ plugins: { allow: [17] } }), /plugins\.allow/);
  await assert.rejects(() => build({ agents: { entries: { noclegi: { tools: { deny: null } } } } }), /noclegi.*deny/);
});
