const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const crypto = require('crypto');
const { Transform, pipeline } = require('stream');

const app = express();

/* ── env config ──────────────────────────────────── */
const PORT      = process.env.TS_PORT      || 3000;
const DATA_DIR  = process.env.TS_DATA_DIR  || __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const META_DIR   = path.join(DATA_DIR, 'metadata');
const MAX_SIZE   = (parseInt(process.env.TS_MAX_SIZE) || 50) * 1024 * 1024;
const MAX_TOTAL = (parseInt(process.env.TS_MAX_TOTAL_MB) || 1024) * 1024 * 1024;
const MAX_FILES = 20;
if (process.env.TS_TRUST_PROXY) app.set('trust proxy', process.env.TS_TRUST_PROXY);
const activeUploads = new Set();
const storedSizes = new Map();
let usedBytes = 0;

[UPLOAD_DIR, META_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});
for (const entry of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const fp = path.join(UPLOAD_DIR, entry.name);
  const size = fs.statSync(fp).size;
  storedSizes.set(fp, size);
  usedBytes += size;
}

/* ── verification codes (in-memory) ──────────────── */
const codes = new Map();

function makeCode() {
  let code;
  do { code = crypto.randomInt(100000, 1000000).toString(); } while (codes.has(code));
  return code;
}

function purgeCodes() {
  const t = Date.now();
  for (const [k, v] of codes) { if (t > v.exp) codes.delete(k); }
}

/* ── extraction codes (persisted in metadata) ───── */
function extractCodeExists(code) {
  if (!fs.existsSync(META_DIR)) return false;
  for (const f of fs.readdirSync(META_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(META_DIR, f), 'utf8'));
      if (meta.extractCode === code) return true;
    } catch (_) { /* skip */ }
  }
  return false;
}

function makeExtractCode() {
  let code;
  do {
    code = crypto.randomInt(100000, 1000000).toString();
  } while (extractCodeExists(code));
  return code;
}

function findMetaByExtractCode(code) {
  if (!fs.existsSync(META_DIR)) return null;
  for (const f of fs.readdirSync(META_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(META_DIR, f), 'utf8'));
      if (meta.extractCode === code) return path.join(META_DIR, f);
    } catch (_) { /* skip */ }
  }
  return null;
}

/* ── safe delete (bypass sandbox trash shim) ──────── */
function safeUnlink(fp) {
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    if (storedSizes.has(fp)) {
      usedBytes -= storedSizes.get(fp);
      storedSizes.delete(fp);
    }
  } catch (_) { /* retry during cleanup */ }
}
const EXPIRY = {
  '5m':  5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h':  60 * 60_000,
  '6h':  6 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
};

function purgeFiles() {
  if (!fs.existsSync(META_DIR)) return;
  const files = fs.readdirSync(META_DIR);
  const t = Date.now();
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(META_DIR, f), 'utf8'));
      if (t > meta.expiresAt) {
        safeUnlink(path.join(UPLOAD_DIR, meta.storedName));
        safeUnlink(path.join(META_DIR, f));
      }
    } catch (_) { /* skip */ }
  }
}

function purgeOrphans() {
  const referenced = new Set();
  let corrupt = false;
  for (const f of fs.readdirSync(META_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { referenced.add(JSON.parse(fs.readFileSync(path.join(META_DIR, f), 'utf8')).storedName); }
    catch (_) { corrupt = true; }
  }
  if (corrupt) return;
  for (const f of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
    const fp = path.join(UPLOAD_DIR, f.name);
    if (f.isFile() && !referenced.has(f.name) && !activeUploads.has(fp)) safeUnlink(fp);
  }
}
purgeFiles();
purgeOrphans();

setInterval(() => { purgeCodes(); purgeFiles(); purgeOrphans(); }, 30_000);

/* ── multer ──────────────────────────────────────── */
const storage = {
  _handleFile(req, file, cb) {
    const filename = uuidv4() + path.extname(file.originalname);
    const fp = path.join(UPLOAD_DIR, filename);
    activeUploads.add(fp);
    storedSizes.set(fp, 0);
    const quota = new Transform({ transform(chunk, encoding, next) {
      if (usedBytes + chunk.length > MAX_TOTAL) {
        const err = new Error('存储容量已满，请稍后重试');
        err.code = 'STORAGE_FULL';
        return next(err);
      }
      usedBytes += chunk.length;
      storedSizes.set(fp, storedSizes.get(fp) + chunk.length);
      next(null, chunk);
    }});
    const output = fs.createWriteStream(fp);
    const abort = () => quota.destroy(Object.assign(new Error('上传已取消'), { code: 'UPLOAD_ABORTED' }));
    req.once('aborted', abort);
    pipeline(file.stream, quota, output, err => {
      req.removeListener('aborted', abort);
      if (err) {
        activeUploads.delete(fp);
        safeUnlink(fp);
        return cb(err);
      }
      cb(null, { destination: UPLOAD_DIR, filename, path: fp, size: storedSizes.get(fp) });
    });
  },
  _removeFile(_req, file, cb) {
    activeUploads.delete(file.path);
    safeUnlink(file.path);
    cb(null);
  }
};
const upload = multer({ storage, limits: { fileSize: MAX_SIZE, files: MAX_FILES, fields: 4 } });

/* ── middleware ───────────────────────────────────── */
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const rateBuckets = new Map();
function rateLimit(name, limit) {
  return (req, res, next) => {
    const now = Date.now();
    const key = name + ':' + req.ip;
    const entry = rateBuckets.get(key);
    const bucket = !entry || now >= entry.reset ? { count: 0, reset: now + 60_000 } : entry;
    rateBuckets.set(key, bucket);
    if (++bucket.count > limit) {
      res.set('Retry-After', String(Math.ceil((bucket.reset - now) / 1000)));
      return res.status(429).json({ error: 'rate_limited', message: '操作过于频繁，请稍后重试' });
    }
    next();
  };
}
setInterval(() => { for (const [key, v] of rateBuckets) if (v.reset <= Date.now()) rateBuckets.delete(key); }, 60_000);
app.post('/api/code', rateLimit('code', 20));
app.post('/api/validate', rateLimit('validate', 30));
app.post('/api/retrieve', rateLimit('retrieve', 30));
app.post(['/api/upload', '/api/upload-batch'], rateLimit('upload', 10));
app.get('/api/qr', rateLimit('qr', 60));
app.get('/api/config', (_req, res) => res.json({ maxSize: MAX_SIZE, maxTotal: MAX_TOTAL, maxFiles: MAX_FILES }));

/* ── API: generate code ──────────────────────────── */
app.post('/api/code', (_req, res) => {
  purgeCodes();
  const code = makeCode();
  const now = Date.now();
  codes.set(code, { at: now, exp: now + 5 * 60_000 });

  res.json({ code, expiresIn: 300 });
});

/* ── API: validate code ──────────────────────────── */
app.post('/api/validate', (req, res) => {
  purgeCodes();
  const { code } = req.body;
  if (!code || !codes.has(code)) {
    return res.status(400).json({ error: 'code_invalid', message: '验证码无效或已过期' });
  }
  res.json({ valid: true });
});

/* ── API: upload ─────────────────────────────────── */
function saveUploads(req, res) {
  purgeCodes();
  const { code, expiry, maxDownloads = '0' } = req.body;
  const files = req.files || (req.file ? [req.file] : []);
  const discard = () => files.forEach(f => { activeUploads.delete(f.path); safeUnlink(f.path); });

  if (!code || !codes.has(code)) {
    discard();
    return res.status(400).json({ error: 'code_invalid', message: '验证码无效或已过期' });
  }

  if (!files.length) {
    return res.status(400).json({ error: 'no_file', message: '未选择文件' });
  }
  if (!/^\d+$/.test(String(maxDownloads)) || Number(maxDownloads) > 10000) {
    discard();
    return res.status(400).json({ error: 'invalid_limit', message: '下载次数应为 0 至 10000 的整数' });
  }

  const dur = EXPIRY[expiry] || EXPIRY['30m'];
  const now = Date.now();
  const saved = [];
  try {
  for (const file of files) {
  const id = uuidv4();
  const extractCode = makeExtractCode();
  const deleteToken = crypto.randomBytes(32).toString('hex');
  const meta = {
    id,
    extractCode,
    originalName: file.originalname,
    storedName:   file.filename,
    size:         file.size,
    mimetype:     file.mimetype,
    createdAt:    now,
    expiresAt:    now + dur,
    expiry,
    maxDownloads: Number(maxDownloads),
    downloads: 0,
    deleteTokenHash: crypto.createHash('sha256').update(deleteToken).digest('hex'),
  };

  fs.writeFileSync(path.join(META_DIR, `${id}.json`), JSON.stringify(meta, null, 2));
  saved.push({ ...publicMeta(meta), deleteToken });
  activeUploads.delete(file.path);
  }
  } catch (err) {
    discard();
    saved.forEach(meta => safeUnlink(path.join(META_DIR, `${meta.id}.json`)));
    throw err;
  }
  res.json(req.files ? { files: saved } : saved[0]);
}
app.post('/api/upload', upload.single('file'), saveUploads);
app.post('/api/upload-batch', upload.array('files', MAX_FILES), saveUploads);

function publicMeta(meta) {
  return {
    id: meta.id, extractCode: meta.extractCode, url: `/api/download/${meta.id}`,
    originalName: meta.originalName, size: meta.size, expiresAt: meta.expiresAt,
    remaining: Math.max(0, meta.expiresAt - Date.now()), expiry: meta.expiry,
    maxDownloads: meta.maxDownloads || 0, downloads: meta.downloads || 0,
    remainingDownloads: meta.maxDownloads ? Math.max(0, meta.maxDownloads - (meta.downloads || 0)) : null
  };
}
const validId = id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
function unavailable(meta) { return Date.now() >= meta.expiresAt || (meta.maxDownloads && (meta.downloads || 0) >= meta.maxDownloads); }
app.delete('/api/files/:id', rateLimit('delete', 20), (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ message: '文件不存在' });
  const mp = path.join(META_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(mp)) return res.status(404).json({ message: '文件不存在或已失效' });
  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const token = req.get('X-Delete-Token') || '';
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  if (!meta.deleteTokenHash || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(meta.deleteTokenHash)))
    return res.status(403).json({ message: '删除凭证无效' });
  safeUnlink(path.join(UPLOAD_DIR, meta.storedName));
  safeUnlink(mp);
  res.json({ deleted: true });
});

/* ── error page ─────────────────────────────────── */
function sendErrorPage(res, status, file, exhausted = false) {
  const q = new URLSearchParams({
    code: String(status),
    title: status === 410 ? '文件已过期' : '文件不存在或已过期',
    desc: status === 410
      ? '该文件已超过可分享时限，已被自动删除。请联系分享者重新上传。'
      : '该链接已被删除、已过期或从未存在过。请向分享者确认，或返回首页生成新的链接。',
  });
  if (exhausted) {
    q.set('title', '下载次数已用完');
    q.set('desc', '该文件已达到下载次数限制。请联系分享者重新上传。');
  }
  if (file) q.set('file', file);
  const template = fs.readFileSync(path.join(__dirname, 'public', 'error.html'), 'utf8');
  res.status(status).type('html').send(template.replace('<!-- ERROR_CONTEXT -->',
    `<script id="error-context" type="application/json">${JSON.stringify(Object.fromEntries(q)).replace(/</g, '\\u003c')}</script>`));
}

/* ── API: download ───────────────────────────────── */
app.get('/api/download/:id', (req, res) => {
  if (!validId(req.params.id)) return sendErrorPage(res, 404);
  const mp = path.join(META_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(mp)) return sendErrorPage(res, 404);

  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (unavailable(meta)) {
    if (Date.now() >= meta.expiresAt) {
      safeUnlink(path.join(UPLOAD_DIR, meta.storedName));
      safeUnlink(mp);
    }
    return sendErrorPage(res, 410, meta.originalName, !!(meta.maxDownloads && meta.downloads >= meta.maxDownloads));
  }

  const fp = path.join(UPLOAD_DIR, meta.storedName);
  if (!fs.existsSync(fp)) return sendErrorPage(res, 404, meta.originalName);

  if (req.method === 'HEAD') return res.download(fp, meta.originalName);
  // Limited downloads must be complete requests; a range must not consume the last slot.
  if (meta.maxDownloads && req.get('Range')) return res.status(400).json({ message: '次数受限文件请完整下载，不支持分段下载' });
  meta.downloads = (meta.downloads || 0) + 1;
  fs.writeFileSync(mp, JSON.stringify(meta, null, 2));
  res.set('Cache-Control', 'no-store');
  res.download(fp, meta.originalName, { acceptRanges: !meta.maxDownloads }, err => {
    if (err && fs.existsSync(mp)) {
      try {
        const current = JSON.parse(fs.readFileSync(mp, 'utf8'));
        current.downloads = Math.max(0, (current.downloads || 0) - 1);
        fs.writeFileSync(mp, JSON.stringify(current, null, 2));
      } catch (_) { /* cleanup handles missing metadata */ }
    }
    if (err && !res.headersSent) res.status(500).json({ message: '下载失败，请重试' });
  });
});

/* ── API: generate QR code (local) ──────────────── */
app.get('/api/qr', async (req, res) => {
  const text = req.query.text;
  if (!text) return res.status(400).send('missing text');

  try {
    const dataUrl = await QRCode.toDataURL(text, { width: 300, margin: 1 });
    const img = Buffer.from(dataUrl.split(',')[1], 'base64');
    res.set('Content-Type', 'image/png');
    res.send(img);
  } catch (_) {
    res.status(400).send('invalid text');
  }
});

/* ── API: file info ──────────────────────────────── */
app.get('/api/info/:id', (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ message: '文件不存在' });
  const mp = path.join(META_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(mp)) return res.status(404).json({ error: '文件不存在或已过期' });

  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (unavailable(meta)) {
    return res.status(410).json({ message: '文件已过期或下载次数已用完' });
  }

  if (!fs.existsSync(path.join(UPLOAD_DIR, meta.storedName))) return res.status(404).json({ message: '文件不存在' });
  res.json(publicMeta(meta));
});

/* ── API: retrieve by extraction code ───────────── */
app.post('/api/retrieve', (req, res) => {
  const { code } = req.body;
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'invalid_code', message: '提取码格式不正确，应为 6 位数字' });
  }

  const mp = findMetaByExtractCode(code);
  if (!mp) {
    return res.status(404).json({ error: 'not_found', message: '提取码无效或文件不存在' });
  }

  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (unavailable(meta)) {
    if (Date.now() >= meta.expiresAt) {
      safeUnlink(path.join(UPLOAD_DIR, meta.storedName));
      safeUnlink(mp);
    }
    return res.status(410).json({ error: 'expired', message: '文件已过期或下载次数已用完' });
  }

  if (!fs.existsSync(path.join(UPLOAD_DIR, meta.storedName))) return res.status(404).json({ message: '文件不存在' });
  res.json(publicMeta(meta));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (req.file) safeUnlink(req.file.path);
  for (const file of req.files || []) { activeUploads.delete(file.path); safeUnlink(file.path); }
  if (req.file) activeUploads.delete(req.file.path);
  if (err.code === 'STORAGE_FULL') return res.status(507).json({ error: err.code, message: '服务器分享容量已满，请稍后重试' });
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `文件过大，单文件最大 ${MAX_SIZE / 1024 / 1024} MB`
      : `上传格式不正确，最多选择 ${MAX_FILES} 个文件`;
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code, message });
  }
  const message = ['ENOSPC', 'EDQUOT'].includes(err.code)
    ? '服务器存储空间不足，请稍后重试'
    : '请求处理失败，请稍后重试';
  res.status(500).json({ error: 'server_error', message });
});

/* ── 404 catch-all ─────────────────────────────── */
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not_found', message: '接口不存在' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

/* ── start ───────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n  TempShare  ready  →  http://localhost:${PORT}`);
  console.log(`  data dir           ${DATA_DIR}`);
  console.log(`  max file size      ${MAX_SIZE / 1024 / 1024} MB\n`);
});
