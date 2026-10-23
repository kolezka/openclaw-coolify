import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { pathToFileURL } from 'node:url';

function reader(socket) {
  let buffered = Buffer.alloc(0);
  let failure;
  let pending;
  function flush() {
    if (!pending) return;
    if (buffered.length >= pending.size) {
      const result = buffered.subarray(0, pending.size);
      buffered = buffered.subarray(pending.size);
      const { resolve, timer } = pending;
      pending = undefined;
      clearTimeout(timer);
      resolve(result);
    } else if (failure) {
      const { reject, timer } = pending;
      pending = undefined;
      clearTimeout(timer);
      reject(failure);
    }
  }
  socket.on('data', chunk => { buffered = Buffer.concat([buffered, chunk]); flush(); });
  socket.on('error', error => { failure = error; flush(); });
  socket.on('close', () => { failure ??= new Error('VNC connection closed'); flush(); });
  return size => new Promise((resolve, reject) => {
    assert.equal(pending, undefined, 'VNC reads must be sequential');
    const timer = setTimeout(() => {
      pending = undefined;
      reject(new Error('VNC response timed out'));
    }, 10000);
    pending = { size, resolve, reject, timer };
    flush();
  });
}

export async function connectVnc({ host = '127.0.0.1', port = 5900, password }) {
  const socket = createConnection({ host, port });
  const read = reader(socket);
  try {
    await once(socket, 'connect');
    const greeting = (await read(12)).toString('ascii');
    assert.equal(greeting, 'RFB 003.008\n');
    socket.write(greeting);
    const count = (await read(1))[0];
    assert.ok(count > 0, 'VNC server refused security negotiation');
    const securityTypes = [...await read(count)];
    assert.ok(!securityTypes.includes(1), 'Unauthenticated VNC must not be offered');
    assert.ok(securityTypes.includes(2), 'VncAuth must be offered');
    socket.write(Buffer.from([2]));
    const challenge = await read(16);
    const key = Buffer.alloc(8);
    Buffer.from(password, 'ascii').copy(key, 0, 0, 8);
    for (let i = 0; i < key.length; i++) {
      let reversed = 0;
      for (let bit = 0; bit < 8; bit++) reversed = (reversed << 1) | ((key[i] >> bit) & 1);
      key[i] = reversed;
    }
    // EDE with the same key is DES; this avoids enabling OpenSSL's legacy provider.
    const cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null);
    cipher.setAutoPadding(false);
    socket.write(Buffer.concat([cipher.update(challenge), cipher.final()]));
    const authentication = (await read(4)).readUInt32BE();
    if (authentication !== 0) {
      const length = (await read(4)).readUInt32BE();
      assert.ok(length <= 4096);
      const reason = (await read(length)).toString('utf8');
      socket.destroy();
      return { authenticated: false, reason, close: () => {} };
    }
    socket.write(Buffer.from([1]));
    const init = await read(24);
    const width = init.readUInt16BE(0);
    const height = init.readUInt16BE(2);
    const nameLength = init.readUInt32BE(20);
    assert.ok(width > 0 && height > 0 && nameLength <= 4096);
    const name = (await read(nameLength)).toString('utf8');
    return {
      authenticated: true, width, height, name,
      type(text) {
        for (const character of text) {
          const key = character.codePointAt(0);
          assert.ok(key < 128, 'the test helper sends ASCII keysyms only');
          for (const down of [1, 0]) {
            const event = Buffer.alloc(8);
            event[0] = 4;
            event[1] = down;
            event.writeUInt32BE(key, 4);
            socket.write(event);
          }
        }
      },
      close: () => socket.end(),
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.OPENCLAW_TEST_FIXTURE, '1', 'run only in a disposable test fixture');
  const connection = await connectVnc({ password: process.env.VNC_TEST_PASSWORD ?? 'testpass' });
  console.log(JSON.stringify({
    authenticated: connection.authenticated,
    width: connection.width, height: connection.height, reason: connection.reason,
  }));
  connection.close();
}
