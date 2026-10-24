import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { docker, fixture, image, resourceLimits, root } from './helpers/docker-fixture.mjs';

test('native VNC is isolated by default and requires explicit LAN selection', { timeout: 180000 }, async t => {
  const network = `openclaw-network-test-${randomUUID()}`;
  await docker('network', 'create', '--internal', network);
  t.after(() => docker('network', 'rm', network));
  for (const [label, bindAddress, reachable] of [
    ['default WebUI-only mode', undefined, false],
    ['explicit LAN mode', '192.168.42.10', true],
  ]) {
    await t.test(label, async t => {
      const f = await fixture(t, { network, bindAddress });
      await f.ready();
      assert.equal((await f.auth()).authenticated, true, 'the in-container gateway path must still work');
      const peer = await docker('create', '--name', `${f.name}-peer`, '--network', network, ...resourceLimits,
        '--entrypoint', 'node', '--mount', `type=bind,source=${root}tests,target=/app/tests,readonly`,
        image, '--input-type=module', '-e', `
          import assert from 'node:assert/strict';
          import {connectVnc} from '/app/tests/vnc-client.mjs';
          const host=${JSON.stringify(f.name)};
          const response=await fetch('http://'+host+':18789/healthz',{signal:AbortSignal.timeout(5000)});
          assert.equal(response.status,200,'the peer must reach the gateway on the same network');
          assert.equal((await response.json()).ok,true);
          if(${reachable}){
            const connection=await connectVnc({host,password:'testpass'});
            assert.equal(connection.authenticated,true);
            connection.close();
          } else {
            await assert.rejects(async()=>{
              const connection=await connectVnc({host,password:'testpass'});
              connection.close();
            },{code:'ECONNREFUSED'},'default VNC must refuse direct Docker-peer access');
          }
          console.log('PASS: peer gateway positive control and VNC boundary');`);
      t.after(() => docker('rm', '--force', '--volumes', peer));
      const output = await docker('start', '--attach', peer);
      assert.equal(JSON.parse(await docker('inspect', '--format', '{{json .State}}', peer)).ExitCode, 0);
      assert.match(output, /PASS: peer gateway positive control and VNC boundary/);
      assert.equal((await f.auth()).authenticated, true);
    });
  }
});

test('X11 requires runtime authority while authenticated desktop clients work', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await f.ready();
  assert.match(await f.exec('xdpyinfo'), /dimensions:\s+1920x1080/);
  await assert.rejects(() => f.exec('env', 'XAUTHORITY=/tmp/absent-test-authority', 'xdpyinfo'), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Authorization required|unable to open display|Invalid MIT-MAGIC-COOKIE/i);
    return true;
  });
  assert.match(await f.exec('xdpyinfo'), /dimensions:\s+1920x1080/);
  const authority = JSON.parse(await f.evaluate(`import fs from 'node:fs';
    const path=process.env.XAUTHORITY;
    const s=fs.statSync(path);
    console.log(JSON.stringify({path,mode:s.mode&511,uid:s.uid,nonempty:s.size>0}));`));
  assert.deepEqual(authority, { path: '/run/openclaw-desktop/Xauthority', mode: 0o600, uid: 1000, nonempty: true });
});
