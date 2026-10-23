import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { docker, fixture, image, resourceLimits } from './helpers/docker-fixture.mjs';

if (process.env.OPENCLAW_REQUIRE_NATIVE_AMD64 === '1') {
  const architecture = await docker('version', '--format', '{{.Server.Arch}}');
  assert.equal(architecture, 'amd64', 'production Chrome acceptance requires a native amd64 Docker engine');
}

test('the image provides terminal and browser launchers for its architecture', { timeout: 30000 }, async () => {
  const result = await docker('run', '--rm', '--network', 'none', ...resourceLimits, '--entrypoint', 'node', image,
    '--input-type=module', '-e', `import assert from 'node:assert/strict';
      import fs from 'node:fs';import {spawnSync} from 'node:child_process';
      for(const [file,pattern] of [['terminal.desktop',/xfce4-terminal/i],['browser.desktop',/Chrom(e|ium)/i]]){
        assert.ok(fs.existsSync('/app/deploy/launchers/'+file),file+' is not installed');
        const text=fs.readFileSync('/app/deploy/launchers/'+file,'utf8');
        const executable=text.match(/^Exec=(\\S+)/m)?.[1];
        assert.ok(executable, file+' lacks an executable');
        const version=spawnSync(executable,['--version'],{encoding:'utf8'});
        assert.equal(version.status,0, file+': '+version.stderr);
        assert.match(version.stdout,pattern);
        if(file==='browser.desktop'&&process.arch==='x64')assert.match(version.stdout,/Google Chrome/);
      }
      assert.equal(process.env.CHROME_USER_DATA_DIR,'/home/node/.openclaw/desktop/google-chrome');
      assert.equal(fs.realpathSync('/home/node/Desktop'),'/home/node/.openclaw/desktop/Desktop');
      console.log('PASS: terminal and browser launchers on '+process.arch);`);
  assert.match(result, /PASS: terminal and browser launchers/);
});

test('startup seeds visible desktop shortcuts without replacing user files', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await f.ready();
  const result = await f.evaluate(`import assert from 'node:assert/strict';import fs from 'node:fs';
    for(const name of ['terminal.desktop','browser.desktop']){
      const p='/home/node/Desktop/'+name;
      const s=fs.statSync(p);assert.ok(s.isFile());assert.ok(s.mode&64);assert.equal(s.uid,1000);
      assert.match(fs.readFileSync(p,'utf8'),/^Type=Application$/m);
    }
    fs.writeFileSync('/home/node/Desktop/operator-note.txt','preserve-me');
    fs.writeFileSync('/home/node/Desktop/browser.desktop','operator-custom-launcher');
    console.log('seeded');`);
  assert.equal(result, 'seeded');
  await docker('stop', '--time', '20', f.name);
  await docker('start', f.name);
  await f.ready();
  const preserved = await f.evaluate(`import assert from 'node:assert/strict';import fs from 'node:fs';
    assert.equal(fs.readFileSync('/home/node/Desktop/operator-note.txt','utf8'),'preserve-me');
    assert.equal(fs.readFileSync('/home/node/Desktop/browser.desktop','utf8'),'operator-custom-launcher');
    console.log('preserved');`);
  assert.equal(preserved, 'preserved');
});

test('standard folders and XFCE settings survive container replacement on retained state', { timeout: 60000 }, async () => {
  const volume = `openclaw-files-test-${randomUUID()}`;
  await docker('volume', 'create', volume);
  try {
    const common = ['--rm', '--network', 'none', ...resourceLimits,
      '--mount', `type=volume,source=${volume},target=/home/node/.openclaw`,
      '--tmpfs', '/run/openclaw-desktop:rw,mode=0700,uid=1000,gid=1000',
      '--env', 'DESKTOP_VNC_PASSWORD=testpass', '--entrypoint', 'node', image, '--input-type=module', '-e'];
    // A retained volume need not contain directories introduced by a newer image.
    await docker('run', ...common, `import fs from 'node:fs';
      for(const path of ['Downloads','Documents','xfce4'])fs.rmSync('/home/node/.openclaw/desktop/'+path,{recursive:true,force:true});
      fs.writeFileSync('/home/node/.openclaw/preservation-control','retained-state');`);
    const paths = ['/home/node/Desktop', '/home/node/Downloads', '/home/node/Documents', '/home/node/.config/xfce4'];
    await docker('run', ...common, `import fs from 'node:fs';
      import {prepareDesktopRuntime} from '/app/deploy/prepare-runtime.mjs';
      await prepareDesktopRuntime();
      for(const [index,path] of ${JSON.stringify(paths)}.entries()){
        fs.mkdirSync(path,{recursive:true});
        fs.writeFileSync(path+'/preservation-fixture','saved-value-'+index);
      }`);
    const result = await docker('run', ...common, `import assert from 'node:assert/strict';import fs from 'node:fs';
      import {prepareDesktopRuntime} from '/app/deploy/prepare-runtime.mjs';
      await prepareDesktopRuntime();
      assert.equal(fs.readFileSync('/home/node/.openclaw/preservation-control','utf8'),'retained-state');
      for(const [index,path] of ${JSON.stringify(paths)}.entries()){
        assert.ok(fs.existsSync(path+'/preservation-fixture'),path+' lost user data on replacement');
        assert.equal(fs.readFileSync(path+'/preservation-fixture','utf8'),'saved-value-'+index);
      }
      console.log('PASS: saved desktop files and settings survived replacement');`);
    assert.match(result, /PASS: saved desktop files and settings survived replacement/);
  } finally {
    await docker('volume', 'rm', volume);
  }
});

test('native VNC and CUA share the browser while the renderer stays sandboxed', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  await f.ready();
  const result = await f.exec('node', '/app/tests/desktop-smoke.mjs');
  assert.match(result, /PASS: native VNC and CUA submitted the exact combined marker/);
  assert.match(result, /PASS: terminal window is visible to CUA/);
  assert.match(result, /PASS: browser renderer has its own seccomp sandbox and no-new-privileges/);
});
