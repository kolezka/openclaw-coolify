import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resourceLimits } from './helpers/docker-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const image = process.env.OPENCLAW_TEST_IMAGE ?? 'openclaw-desktop:test';
const browser = process.env.OPENCLAW_TEST_BROWSER ?? 'chromium';
assert.ok(['chromium', 'google-chrome-stable'].includes(browser));
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
  DESKTOP_VNC_PASSWORD: 'testpass',
};
function docker(...args) {
  return execFileSync('docker', args, { cwd: root, env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
}
const service = JSON.parse(docker('compose', 'config', '--format', 'json')).services.openclaw;
const security = service.security_opt.flatMap(option => ['--security-opt', option]);
const hostname = service.hostname ? ['--hostname', service.hostname] : [];
const common = ['--network', 'none', '--shm-size=1g', ...security, ...hostname,
  ...resourceLimits,
  '--mount', `type=volume,source=${volume},target=/home/node/.openclaw`, '--entrypoint', browser];
const profile = `/home/node/.openclaw/desktop/${browser === 'chromium' ? 'chromium' : 'google-chrome'}`;
const marker = `saved-profile-${randomUUID()}`;
let exists = false;
let primaryError;
async function launch() {
  // Headless Chrome ignores CHROME_USER_DATA_DIR and otherwise tests a temporary profile.
  docker('run', '-d', '--name', container, ...common, image,
    '--headless', `--user-data-dir=${profile}`, '--no-first-run', '--remote-debugging-port=9222', 'about:blank');
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
}
function verifyProfile(seed) {
  const output = docker('exec', container, 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {once} from 'node:events';
    import {setTimeout as delay} from 'node:timers/promises';
    const profile=${JSON.stringify(profile)};
    assert.ok(fs.lstatSync(profile+'/SingletonLock',{throwIfNoEntry:false})?.isSymbolicLink(),'browser must lock the retained profile');
    assert.ok(fs.statSync(profile+'/Default',{throwIfNoEntry:false})?.isDirectory(),'browser must create the retained profile');
    const target=await (await fetch('http://127.0.0.1:9222/json/new?chrome://version',{method:'PUT'})).json();
    const socket=new WebSocket(target.webSocketDebuggerUrl);
    await once(socket,'open');
    let id=0;
    const pending=new Map();
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.id)pending.get(message.id)?.(message);
    });
    const timer=setTimeout(()=>{console.error('Profile inspection timed out');process.exit(1)},10000);
    try {
      let actual;
      for(let attempt=0;attempt<50;attempt++){
        const requestId=++id;
        const response=new Promise(resolve=>pending.set(requestId,resolve));
        socket.send(JSON.stringify({id:requestId,method:'Runtime.evaluate',params:{expression:'document.querySelector("#profile_path")?.textContent',returnByValue:true}}));
        const message=await response;
        pending.delete(requestId);
        assert.equal(message.error,undefined,JSON.stringify(message.error));
        actual=message.result.result.value;
        if(actual)break;
        await delay(100);
      }
      assert.equal(actual,profile+'/Default','running browser must report the retained profile');
      const file=profile+'/Default/preservation-fixture';
      if(${seed})fs.writeFileSync(file,${JSON.stringify(marker)});
      assert.equal(fs.readFileSync(file,'utf8'),${JSON.stringify(marker)},'saved profile data must survive SIGKILL');
      console.log('PASS: active profile and saved marker verified');
    } finally {clearTimeout(timer);socket.close();}
  `);
  assert.match(output, /PASS: active profile and saved marker verified/);
}
try {
  docker('volume', 'create', volume);
  await launch();
  verifyProfile(true);
  docker('kill', container);
  docker('rm', container);
  exists = false;
  await launch();
  verifyProfile(false);
  console.log(`PASS: ${browser} reopened the retained profile and preserved saved data after an unclean container replacement`);
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
