import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const image = process.env.OPENCLAW_TEST_IMAGE ?? 'openclaw-desktop:test';
export const resourceLimits = [
  ...process.env.OPENCLAW_TEST_CPUS ? ['--cpus', process.env.OPENCLAW_TEST_CPUS] : [],
  ...process.env.OPENCLAW_TEST_MEMORY ? ['--memory', process.env.OPENCLAW_TEST_MEMORY] : [],
  ...process.env.OPENCLAW_TEST_PIDS_LIMIT ? ['--pids-limit', process.env.OPENCLAW_TEST_PIDS_LIMIT] : [],
];
export async function dockerWithTimeout(timeout, ...args) {
  const result = await run('docker', args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim();
}
export const docker = (...args) => dockerWithTimeout(30000, ...args);

export async function fixture(t, { password = 'testpass', omitPassword = false, bindAddress = '127.0.0.1', runtimeTmpfs = true, configSource } = {}) {
  const name = `openclaw-persistent-test-${randomUUID()}`;
  let directory;
  let created = false;
  const configMount = [];
  t.after(async () => {
    if (created) await docker('rm', '--force', '--volumes', name);
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  if (configSource !== undefined) {
    directory = await mkdtemp(`${tmpdir()}/openclaw-config-fixture-`);
    await writeFile(`${directory}/openclaw.json`, configSource, { mode: 0o644 });
    configMount.push('--mount', `type=bind,source=${directory}/openclaw.json,target=/home/node/.openclaw/openclaw.json,readonly`);
  }
  const variables = {
    OPENCLAW_TEST_FIXTURE: '1',
    OPENCLAW_GATEWAY_TOKEN: 'test-only-token',
    OPENCLAW_ALLOWED_ORIGINS: 'http://localhost:18789',
    LITELLM_BASE_URL: 'http://127.0.0.1:9/v1',
    LITELLM_API_KEY: 'test-only-key',
    LITELLM_MODEL: 'deepseek/deepseek-v4-pro',
    OPENCLAW_SKIP_CHANNELS: '1',
    OPENCLAW_SKIP_GMAIL_WATCHER: '1',
    OPENCLAW_SKIP_CRON: '1',
    OPENCLAW_CODEX_DISCOVERY_LIVE: '0',
    DESKTOP_VNC_BIND_ADDRESS: bindAddress,
    ...omitPassword ? {} : { DESKTOP_VNC_PASSWORD: password },
  };
  await docker('create', '--name', name, '--hostname', 'openclaw-desktop', '--network', 'none',
    '--shm-size=1g', '--security-opt', 'no-new-privileges:true',
    ...resourceLimits,
    '--security-opt', `seccomp=${root}desktop/chromium-seccomp.json`,
    ...runtimeTmpfs ? ['--tmpfs', '/run/openclaw-desktop:rw,mode=0700,uid=1000,gid=1000'] : [],
    '--mount', `type=bind,source=${root}tests,target=/app/tests,readonly`, ...configMount,
    ...Object.entries(variables).flatMap(([key, value]) => ['--env', `${key}=${value}`]), image);
  created = true;
  await docker('start', name);
  const state = async () => JSON.parse(await docker('inspect', '--format', '{{json .State}}', name));
  const exec = (...args) => docker('exec', name, ...args);
  const evaluate = source => exec('node', '--input-type=module', '-e', source);
  async function until(check, message, timeout = 60000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(100);
    }
    throw new Error(`${message}\n${await docker('logs', name)}`);
  }
  async function ready() {
    await until(async () => {
      const current = await state();
      if (!current.Running) throw new Error(`Container exited: ${await docker('logs', name)}`);
      try {
        return await evaluate('const r=await fetch("http://127.0.0.1:18789/healthz",{signal:AbortSignal.timeout(1000)});console.log(r.ok)') === 'true';
      } catch (error) {
        if (error.code !== 0) return false;
        throw error;
      }
    }, 'Gateway did not become ready');
    await until(async () => {
      try { return (await auth()).authenticated; }
      catch (error) {
        if ((await state()).Running) return false;
        throw error;
      }
    }, 'Native VNC did not become ready');
  }
  async function auth(value = 'testpass') {
    return JSON.parse(await docker('exec', '--env', `VNC_TEST_PASSWORD=${value}`, name, 'node', '/app/tests/vnc-client.mjs'));
  }
  async function processes() {
    return JSON.parse(await evaluate(`import fs from 'node:fs';
      const result={};
      for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){
        try {
          const comm=fs.readFileSync('/proc/'+pid+'/comm','utf8').trim();
          const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');
          const title=args[0];
          for(const expected of ['Xtigervnc','dbus-daemon','xfce4-session','openclaw-gateway']){
            // AT-SPI owns another bus; only the desktop bus is lifecycle-critical.
            if(expected==='dbus-daemon'&&!args.includes('--address=unix:path=/run/openclaw-desktop/bus'))continue;
            if(comm===expected||title===expected)(result[expected]??=[]).push(Number(pid));
          }
        } catch(e){if(e.code!=='ENOENT')throw e;}
      }
      console.log(JSON.stringify(result));`));
  }
  return { name, state, exec, evaluate, until, ready, auth, processes };
}
