#!/usr/bin/env node
// Offline tests for the Artemis HTTP transport.
//
//   node tests/test_artemis_http.cjs
//
// A local HTTP server implements the four upstream endpoints with the real body
// cap, plus the small Lua templates the transport generates. That exercises the
// request/response code, chunking, hashing, resume and refusal paths without a
// console. The real console is covered by docs/ARTEMIS-HTTP.md.
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {ArtemisHttp, ArtemisHttpError, PROTECTED} = require(path.join(__dirname, '..',
  'tools/transports/artemis-http.cjs'));

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
let passes = 0, failures = 0;
const test = async (name, fn) => {
  try { await fn(); passes++; console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + '\n      ' + (error && error.stack || error)); }
};

const BODY_CAP = 0x7000;

function startServer() {
  const files = new Map();
  const state = {failReadAt: null, failStatusOnce: 0, delayMs: 0, requests: 0};
  const server = http.createServer((req, res) => {
    state.requests++;
    let body = Buffer.alloc(0);
    req.on('data', chunk => {
      body = Buffer.concat([body, chunk]);
      if (body.length > BODY_CAP) {
        res.writeHead(413, {'Content-Type': 'text/plain'});
        res.end('too large\n');
        req.destroy();
      }
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const name = (url.searchParams.get('path') || '').replace(/^save:\//, '');
      const finish = (status, text) => {
        res.writeHead(status, {'Content-Type': 'text/plain'});
        res.end(text);
      };
      const later = () => {
        if (state.delayMs) setTimeout(run, state.delayMs);
        else run();
      };
      const run = () => {
        if (url.pathname === '/status') {
          if (state.failStatusOnce > 0) { state.failStatusOnce--; return finish(500, 'nope'); }
          return finish(200, 'nora2hax/seedsow HTTP server\nPOST /eval body=<lua>\n');
        }
        if (url.pathname === '/eval') {
          const code = body.toString('utf8');
          const statusError = /error\("boom"\)/.test(code) && !/ns2http:/.test(code);
          if (statusError) return finish(200, 'status: error\nresult: boom\n');
          const read = /-- ns2http:read (\{.*\})/.exec(code);
          if (read) {
            const spec = JSON.parse(read[1]);
            if (state.failReadAt !== null && spec.offset >= state.failReadAt) {
              state.failReadAt = null;
              return finish(500, 'simulated read failure');
            }
            const data = files.get(spec.path) || Buffer.alloc(0);
            const slice = data.subarray(spec.offset, spec.offset + spec.length);
            return finish(200, 'status: ok\noutput:\n' + slice.length + '\n' + slice.toString('hex'));
          }
          const stat = /-- ns2http:stat (\{.*\})/.exec(code);
          if (stat) {
            const spec = JSON.parse(stat[1]);
            if (!files.has(spec.path)) return finish(200, 'status: ok\noutput:\nmissing');
            return finish(200, 'status: ok\noutput:\nsize ' + files.get(spec.path).length);
          }
          const append = /-- ns2http:append (\{.*\})/.exec(code);
          if (append) {
            const spec = JSON.parse(append[1]);
            const hex = /local h="([0-9a-f]*)"/.exec(code)[1];
            const bytes = Buffer.from(hex, 'hex');
            assert.strictEqual(bytes.length, spec.length);
            files.set(spec.path, Buffer.concat([files.get(spec.path) || Buffer.alloc(0), bytes]));
            return finish(200, 'status: ok\noutput:\nappended');
          }
          const rename = /-- ns2http:rename (\{.*\})/.exec(code);
          if (rename) {
            const spec = JSON.parse(rename[1]);
            if (!files.has(spec.from)) return finish(200, 'status: ok\noutput:\nfalse\nmissing');
            files.set(spec.to, files.get(spec.from));
            files.delete(spec.from);
            return finish(200, 'status: ok\noutput:\ntrue');
          }
          if (/_VERSION/.test(code)) {
            return finish(200, 'status: ok\noutput:\nLua 5.1\nOunce\nuserdata');
          }
          return finish(200, 'status: ok\noutput:\nhello world');
        }
        if (url.pathname === '/save' && req.method === 'PUT') {
          if (!name) return finish(400, 'save failed: empty path\n');
          if (PROTECTED.has(name)) return finish(400, 'save failed: protected file\n');
          files.set(name, body);
          return finish(200, 'wrote ' + body.length + ' bytes to save:/' + name);
        }
        if (url.pathname === '/delete' && req.method === 'DELETE') {
          if (PROTECTED.has(name)) return finish(400, 'invalid path: protected file\n');
          if (!files.has(name)) return finish(400, 'delete failed: missing\n');
          files.delete(name);
          return finish(200, 'deleted save:/' + name);
        }
        return finish(404, 'no such endpoint\n');
      };
      later();
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({server, port: server.address().port, files, state});
    });
  });
}

async function run() {
  const fake = await startServer();
  const host = '127.0.0.1';
  const client = new ArtemisHttp({host, port: fake.port, timeout: 3000, retries: 1});
  const cleanup = () => new Promise(resolve => fake.server.close(resolve));

  try {
    await test('status and health expose Lua 5.1 and the platform', async () => {
      const status = await client.status();
      assert.strictEqual(status.status, 200);
      assert.match(status.banner, /nora2hax/);
      const health = await client.health();
      assert.strictEqual(health.lua, 'Lua 5.1');
      assert.strictEqual(health.platform, 'Ounce');
    });

    await test('eval returns output and treats status:error as a failure', async () => {
      const parsed = await client.eval('print("hello world")');
      assert.deepStrictEqual(parsed.output, ['hello world']);
      await assert.rejects(client.eval('error("boom")'), error =>
        error instanceof ArtemisHttpError && error.code === 'ELUA');
    });

    await test('eval rejects source above the server body cap', async () => {
      await assert.rejects(client.eval('x'.repeat(BODY_CAP + 1)), error => error.code === 'ESIZE');
    });

    await test('stat distinguishes missing from present', async () => {
      fake.files.set('probe.bin', Buffer.from('abc'));
      assert.deepStrictEqual(await client.stat('probe.bin'), {exists: true, size: 3});
      assert.deepStrictEqual(await client.stat('nope.bin'), {exists: false, size: 0});
    });

    await test('binary download is exact, chunked and SHA-256 verified', async () => {
      const bytes = Buffer.alloc(16384);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) & 0xff;
      bytes[0] = 0; bytes[1] = 0xff; bytes[2] = 0x80;
      fake.files.set('bin.dat', bytes);
      const out = path.join(tmp('artemis-http-'), 'bin.dat');
      const got = await client.download('bin.dat', {out, chunkSize: 4096,
        expectedSha256: sha(bytes)});
      assert.strictEqual(got.size, bytes.length);
      assert.strictEqual(got.sha256, sha(bytes));
      assert.deepStrictEqual(await fsp.readFile(out), bytes);
      assert.ok(!fs.existsSync(out + '.part'));
    });

    await test('a failed chunk keeps the partial file and resumes', async () => {
      const bytes = Buffer.alloc(20000, 0x5a);
      fake.files.set('resume.bin', bytes);
      fake.state.failReadAt = 8192;
      const out = path.join(tmp('artemis-resume-'), 'resume.bin');
      await assert.rejects(client.download('resume.bin', {out, chunkSize: 4096,
        expectedSha256: sha(bytes)}), error => error.code === 'EHTTP');
      assert.ok(fs.existsSync(out + '.part'));
      assert.ok(!fs.existsSync(out));
      const got = await client.download('resume.bin', {out, chunkSize: 4096,
        expectedSha256: sha(bytes)});
      assert.strictEqual(got.sha256, sha(bytes));
      assert.deepStrictEqual(await fsp.readFile(out), bytes);
    });

    await test('a hash mismatch is refused and the partial is not promoted', async () => {
      const bytes = Buffer.from('integrity matters');
      fake.files.set('hash.bin', bytes);
      const out = path.join(tmp('artemis-hash-'), 'hash.bin');
      await assert.rejects(client.download('hash.bin', {out, expectedSha256: 'f'.repeat(64)}),
        error => error.code === 'EHASH');
      assert.ok(!fs.existsSync(out));
      assert.ok(fs.existsSync(out + '.part'));
    });

    await test('a size mismatch is refused before any read', async () => {
      fake.files.set('size.bin', Buffer.alloc(10));
      const out = path.join(tmp('artemis-size-'), 'size.bin');
      await assert.rejects(client.download('size.bin', {out, expectedSize: 11}),
        error => error.code === 'ESIZE');
    });

    await test('direct upload works for 4 KiB and 16 KiB', async () => {
      for (const size of [4096, 16384]) {
        const bytes = Buffer.alloc(size, size & 0xff);
        const got = await client.upload('up-' + size + '.bin', bytes);
        assert.strictEqual(got.size, size);
        assert.deepStrictEqual(fake.files.get('up-' + size + '.bin'), bytes);
      }
    });

    await test('64 KiB upload is chunked through /eval append and verified', async () => {
      const bytes = Buffer.alloc(65536);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131) & 0xff;
      const got = await client.upload('up-64k.bin', bytes);
      assert.strictEqual(got.size, bytes.length);
      assert.deepStrictEqual(fake.files.get('up-64k.bin'), bytes);
      const out = path.join(tmp('artemis-64k-'), 'up-64k.bin');
      const back = await client.download('up-64k.bin', {out, expectedSha256: sha(bytes)});
      assert.strictEqual(back.sha256, sha(bytes));
    });

    await test('overwriting needs explicit authorization', async () => {
      fake.files.set('keep.txt', Buffer.from('original'));
      await assert.rejects(client.upload('keep.txt', Buffer.from('new')), error =>
        error.code === 'EEXIST');
      assert.deepStrictEqual(fake.files.get('keep.txt'), Buffer.from('original'));
      const got = await client.upload('keep.txt', Buffer.from('new'), {overwrite: true});
      assert.strictEqual(got.size, 3);
      assert.deepStrictEqual(fake.files.get('keep.txt'), Buffer.from('new'));
    });

    await test('protected launcher files are refused for upload and delete', async () => {
      for (const name of ['core.lua', 'save9999.dat', 'system.dat']) {
        await assert.rejects(client.upload(name, Buffer.from('x'), {overwrite: true}),
          error => error.code === 'EPROTECTED');
        await assert.rejects(client.remove(name), error => error.code === 'EPROTECTED');
      }
    });

    await test('delete verifies absence by read-back', async () => {
      fake.files.set('gone.bin', Buffer.from('bye'));
      const result = await client.remove('gone.bin');
      assert.strictEqual(result.deleted, true);
      assert.ok(!fake.files.has('gone.bin'));
      await assert.rejects(client.remove('gone.bin'), error => error.code === 'ENOENT');
    });

    await test('backup is explicit-file and explicitly not complete', async () => {
      fake.files.set('core.lua', Buffer.from('core'));
      fake.files.set('system.dat', Buffer.from('sys'));
      const dir = tmp('artemis-backup-http-');
      const made = await client.backup(['core.lua', 'system.dat', 'missing.dat'], dir);
      assert.strictEqual(made.manifest.scope, 'explicit-files');
      assert.strictEqual(made.manifest.complete, false);
      assert.strictEqual(made.manifest.files, 2);
      assert.strictEqual(made.manifest.entries.length, 2);
      for (const entry of made.manifest.entries) {
        assert.strictEqual(sha(fs.readFileSync(path.join(dir, entry.path.slice(1)))), entry.sha256);
      }
    });

    await test('a transient 500 is retried for status', async () => {
      fake.state.failStatusOnce = 1;
      const status = await client.status();
      assert.strictEqual(status.status, 200);
    });

    await test('a timeout is reported as ETIMEDOUT', async () => {
      const slow = new ArtemisHttp({host, port: fake.port, timeout: 100, retries: 0});
      fake.state.delayMs = 500;
      try {
        await assert.rejects(slow.status(), error => error.code === 'ETIMEDOUT');
      } finally {
        fake.state.delayMs = 0;
      }
    });

    await test('an unreachable host is reported as ECONN', async () => {
      const dead = new ArtemisHttp({host: '127.0.0.1', port: 1, timeout: 200, retries: 0});
      await assert.rejects(dead.status(), error => error.code === 'ECONN');
    });

    await test('rename probe creates, renames and cleans its scratch files', async () => {
      const probe = await client.probeRename();
      assert.strictEqual(probe.ok, true);
      assert.ok(!fake.files.has('.ns2http-probe-a'));
      assert.ok(!fake.files.has('.ns2http-probe-b'));
    });

    await test('atomic upload uses the temporary name and rename', async () => {
      const bytes = Buffer.alloc(9000, 0x21);
      const got = await client.upload('atomic.bin', bytes, {atomic: true});
      assert.strictEqual(got.atomic, true);
      assert.deepStrictEqual(fake.files.get('atomic.bin'), bytes);
      assert.ok(!fake.files.has('.atomic.bin.http-part'));
    });

    // The CLI wraps the transport; a couple of exit-code checks.
    await test('CLI exits 3 for an unreachable host and 2 for bad usage', () => {
      const {spawnSync} = require('node:child_process');
      const tool = path.join(__dirname, '..', 'tools', 'artemis-http.cjs');
      assert.strictEqual(spawnSync(process.execPath, [tool, 'status', '--host', '127.0.0.1',
        '--port', '1', '--timeout', '200'], {encoding: 'utf8'}).status, 3);
      assert.strictEqual(spawnSync(process.execPath, [tool, 'get'], {encoding: 'utf8'}).status, 2);
    });
  } finally {
    await cleanup();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

run().catch(error => { console.error(error); process.exit(1); });
