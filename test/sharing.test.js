const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('sharing lifecycle, quotas, concurrency, cancellation and rate limits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempshare-test-'));
  fs.mkdirSync(path.join(dir, 'uploads'));
  fs.writeFileSync(path.join(dir, 'uploads', 'orphan.txt'), 'orphan');
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, TS_PORT: String(port), TS_MAX_SIZE: '2', TS_MAX_TOTAL_MB: '1', TS_DATA_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  server.stderr.on('data', data => process.stderr.write(data));
  const post = (url, body) => fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const upload = async (code, sizes = [10], maxDownloads = '0') => {
    const fd = new FormData();
    sizes.forEach((size, i) => fd.append(sizes.length > 1 ? 'files' : 'file', new Blob([Buffer.alloc(size)]), `file-${i}.txt`));
    fd.append('code', code);
    fd.append('expiry', '5m');
    fd.append('maxDownloads', maxDownloads);
    return fetch(base + (sizes.length > 1 ? '/api/upload-batch' : '/api/upload'), { method: 'POST', body: fd });
  };
  const remove = file => fetch(base + `/api/files/${file.id}`, { method: 'DELETE', headers: { 'X-Delete-Token': file.deleteToken } });
  try {
    await Promise.race([
      once(server.stdout, 'data'),
      once(server, 'exit').then(() => { throw new Error('Test server exited before startup'); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Startup timeout')), 5000); timer.unref(); }),
    ]);
    assert.equal(fs.existsSync(path.join(dir, 'uploads', 'orphan.txt')), false);
    assert.equal((await (await fetch(base + '/api/config')).json()).maxTotal, 1048576);
    const { code } = await (await post('/api/code', {})).json();

    assert.equal((await upload('000000')).status, 400);
    assert.equal(fs.readdirSync(path.join(dir, 'uploads')).length, 0);
    const batch = await (await upload(code, [20, 30])).json();
    assert.equal(batch.files.length, 2);
    assert.notEqual(batch.files[0].extractCode, batch.files[1].extractCode);
    const file = batch.files[0];
    const retrieved = await (await post('/api/retrieve', { code: file.extractCode })).json();
    assert.equal(retrieved.id, file.id);
    assert.equal(retrieved.deleteToken, undefined);
    assert.equal(retrieved.deleteTokenHash, undefined);
    assert.equal((await fetch(base + `/api/files/${file.id}`, { method: 'DELETE', headers: { 'X-Delete-Token': 'wrong' } })).status, 403);
    assert.equal((await remove(file)).status, 200);
    assert.equal((await fetch(base + file.url)).status, 404);
    assert.equal((await remove(batch.files[1])).status, 200);

    const limited = await (await upload(code, [100], '1')).json();
    assert.equal((await fetch(base + limited.url, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(base + limited.url, { headers: { Range: 'bytes=0-10' } })).status, 400);
    const downloads = await Promise.all([fetch(base + limited.url), fetch(base + limited.url)]);
    assert.deepEqual(downloads.map(r => r.status).sort(), [200, 410]);
    await Promise.all(downloads.map(r => r.arrayBuffer()));
    assert.equal((await post('/api/retrieve', { code: limited.extractCode })).status, 410);
    assert.equal((await remove(limited)).status, 200);

    const quotaFile = await (await upload(code, [700000])).json();
    assert.equal((await upload(code, [700000])).status, 507);
    assert.equal(fs.readdirSync(path.join(dir, 'uploads')).length, 1, JSON.stringify(fs.readdirSync(path.join(dir, 'uploads')).map(f => ({ file: f, size: fs.statSync(path.join(dir, 'uploads', f)).size }))));
    assert.equal((await remove(quotaFile)).status, 200);
    const expiryFile = await (await upload(code)).json();
    const mp = path.join(dir, 'metadata', `${expiryFile.id}.json`);
    const meta = JSON.parse(fs.readFileSync(mp));
    meta.expiresAt = Date.now() - 1;
    fs.writeFileSync(mp, JSON.stringify(meta));
    const expired = await fetch(base + expiryFile.url);
    assert.equal(expired.status, 410);
    assert.match(await expired.text(), /"code":"410"/);

    await new Promise(resolve => {
      const req = http.request(base + '/api/upload', {
        method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=cancel', 'Content-Length': '1000000' },
      });
      req.on('error', () => {});
      req.write('--cancel\r\nContent-Disposition: form-data; name="file"; filename="cancel.txt"\r\nContent-Type: text/plain\r\n\r\n' + 'x'.repeat(10000));
      setTimeout(() => { req.destroy(); resolve(); }, 100);
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.readdirSync(path.join(dir, 'uploads')).length, 0);

    for (let i = 0; i < 30; i++) await post('/api/retrieve', { code: '000000' });
    const blocked = await post('/api/retrieve', { code: '000000' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  } finally {
    server.kill();
    await once(server, 'exit');
    if (path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith('tempshare-test-')) fs.rmSync(dir, { recursive: true, force: true });
  }
});
