import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, rm, statfs, writeFile } from 'node:fs/promises';
import { createConnection, isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import JSON5 from 'json5';

const runtime = '/run/openclaw-desktop';
class StartupError extends Error {}

export function validateVncSettings({ password, bindAddress }) {
  if (typeof password !== 'string' || !/^[\x20-\x7e]{8}$/.test(password)) {
    throw new StartupError('DESKTOP_VNC_PASSWORD must contain exactly eight printable ASCII bytes');
  }
  const parts = bindAddress?.split('.').map(Number);
  if (isIP(bindAddress ?? '') !== 4 || !(parts[0] === 127 || parts[0] === 10 ||
      (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31))) {
    throw new StartupError('DESKTOP_VNC_BIND_ADDRESS must be a loopback or private IPv4 address');
  }
}

async function displayIsActive() {
  return new Promise((resolve, reject) => {
    const socket = createConnection('/tmp/.X11-unix/X1');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new StartupError('Cannot establish whether display :1 is already active'));
    }, 1000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', error => {
      clearTimeout(timer);
      socket.destroy();
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) resolve(false);
      else reject(new StartupError('Cannot inspect display :1; refusing to remove its lock'));
    });
  });
}

export async function prepareDesktopRuntime(env = process.env) {
  validateVncSettings({ password: env.DESKTOP_VNC_PASSWORD, bindAddress: env.DESKTOP_VNC_BIND_ADDRESS ?? '127.0.0.1' });
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const directory = await lstat(runtime);
  if (!directory.isDirectory() || directory.uid !== process.getuid()) {
    throw new StartupError('Desktop runtime directory must be owned by the container user');
  }
  if ((await statfs(runtime)).type !== 0x01021994) {
    throw new StartupError('Desktop runtime directory must be mounted as private tmpfs');
  }
  await chmod(runtime, 0o700);
  const configPath = env.OPENCLAW_CONFIG_PATH ?? `${env.OPENCLAW_STATE_DIR ?? '/home/node/.openclaw'}/openclaw.json`;
  let source;
  try { source = await readFile(configPath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT' || configPath !== '/home/node/.openclaw/openclaw.json') {
      throw new StartupError('Cannot read the retained OpenClaw configuration');
    }
    source = await readFile('/app/deploy/openclaw.json', 'utf8');
  }
  let config;
  try { config = JSON5.parse(source); }
  catch { throw new StartupError('OpenClaw configuration must be valid JSON5 before desktop startup'); }
  const host = config.desktop?.host;
  if (host?.managed !== false || host?.port !== 5900 || host?.passwordFile !== `${runtime}/vnc-password.txt`) {
    throw new StartupError('Persistent desktop requires managed=false, port=5900 and the runtime passwordFile; apply the retained-volume patch first');
  }
  if (await displayIsActive()) throw new StartupError('Display :1 is already active; refusing to replace it');
  await rm('/tmp/.X1-lock', { force: true });
  await rm('/tmp/.X11-unix/X1', { force: true });
  const result = spawnSync('tigervncpasswd', ['-f'], {
    input: `${env.DESKTOP_VNC_PASSWORD}\n`, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0 || result.stdout.length !== 8) {
    throw new StartupError('Could not prepare the VNC authentication file');
  }
  await writeFile(`${runtime}/vnc-password.txt`, env.DESKTOP_VNC_PASSWORD, { flag: 'wx', mode: 0o600 });
  await writeFile(`${runtime}/vnc-password.hash`, result.stdout, { flag: 'wx', mode: 0o600 });
  const authority = `${runtime}/Xauthority`;
  await writeFile(authority, '', { flag: 'wx', mode: 0o600 });
  const xauth = spawnSync('xauth', ['-q', '-f', authority], {
    input: `add :1 MIT-MAGIC-COOKIE-1 ${randomBytes(16).toString('hex')}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (xauth.error || xauth.status !== 0) throw new StartupError('Could not prepare X11 authentication');
  await chmod(authority, 0o600);
  // Retained volumes do not receive directories added to a newer image.
  for (const name of ['Desktop', 'Downloads', 'Documents', 'xfce4']) {
    await mkdir(`/home/node/.openclaw/desktop/${name}`, { recursive: true, mode: 0o700 });
  }
  const desktop = '/home/node/.openclaw/desktop/Desktop';
  for (const name of ['terminal.desktop', 'browser.desktop']) {
    try {
      await copyFile(`/app/deploy/launchers/${name}`, `${desktop}/${name}`, constants.COPYFILE_EXCL);
      await chmod(`${desktop}/${name}`, 0o755);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await prepareDesktopRuntime(); }
  catch (error) {
    console.error(error instanceof StartupError ? error.message : `Desktop initialization failed (${error.code ?? 'runtime error'})`);
    process.exitCode = 1;
  }
}
