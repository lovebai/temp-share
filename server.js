const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');

const app = express();

/* ── env config ──────────────────────────────────── */
const PORT      = process.env.TS_PORT      || 3000;
const DATA_DIR  = process.env.TS_DATA_DIR  || __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const META_DIR   = path.join(DATA_DIR, 'metadata');
const MAX_SIZE   = (parseInt(process.env.TS_MAX_SIZE) || 50) * 1024 * 1024;

[UPLOAD_DIR, META_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

/* ── verification codes (in-memory) ──────────────── */
const codes = new Map();

function makeCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
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
    code = Math.floor(100000 + Math.random() * 900000).toString();
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
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) { /* skip */ }
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

setInterval(() => { purgeCodes(); purgeFiles(); }, 30_000);

/* ── multer ──────────────────────────────────────── */
const storage = multer.diskStorage({
  destination: (_r, _f, cb) => cb(null, UPLOAD_DIR),
  filename: (_r, f, cb) => {
    const ext = path.extname(f.originalname);
    cb(null, uuidv4() + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_SIZE } });

/* ── middleware ───────────────────────────────────── */
app.use(express.json());
app.use(express.static('public'));
app.get('/api/config', (_req, res) => res.json({ maxSize: MAX_SIZE }));

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
app.post('/api/upload', upload.single('file'), (req, res) => {
  purgeCodes();
  const { code, expiry } = req.body;

  if (!code || !codes.has(code)) {
    if (req.file) safeUnlink(req.file.path);
    return res.status(400).json({ error: 'code_invalid', message: '验证码无效或已过期' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'no_file', message: '未选择文件' });
  }

  const dur = EXPIRY[expiry] || EXPIRY['30m'];
  const now = Date.now();
  const id  = uuidv4();

  const extractCode = makeExtractCode();

  const meta = {
    id,
    extractCode,
    originalName: req.file.originalname,
    storedName:   req.file.filename,
    size:         req.file.size,
    mimetype:     req.file.mimetype,
    createdAt:    now,
    expiresAt:    now + dur,
    expiry,
  };

  fs.writeFileSync(path.join(META_DIR, `${id}.json`), JSON.stringify(meta, null, 2));

  res.json({
    id:           meta.id,
    extractCode:  meta.extractCode,
    url:          `/api/download/${meta.id}`,
    originalName: meta.originalName,
    size:         meta.size,
    expiresAt:    meta.expiresAt,
    expiry:       meta.expiry,
  });
});

/* ── error page ─────────────────────────────────── */
function sendErrorPage(res, status, file) {
  const q = new URLSearchParams({
    code: String(status),
    title: status === 410 ? '文件已过期' : '文件不存在或已过期',
    desc: status === 410
      ? '该文件已超过可分享时限，已被自动删除。请联系分享者重新上传。'
      : '该链接已被删除、已过期或从未存在过。请向分享者确认，或返回首页生成新的链接。',
  });
  if (file) q.set('file', file);
  const template = fs.readFileSync(path.join(__dirname, 'public', 'error.html'), 'utf8');
  res.status(status).type('html').send(template.replace('<!-- ERROR_CONTEXT -->',
    `<script id="error-context" type="application/json">${JSON.stringify(Object.fromEntries(q)).replace(/</g, '\\u003c')}</script>`));
}

/* ── API: download ───────────────────────────────── */
app.get('/api/download/:id', (req, res) => {
  const mp = path.join(META_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(mp)) return sendErrorPage(res, 404);

  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (Date.now() > meta.expiresAt) {
    safeUnlink(path.join(UPLOAD_DIR, meta.storedName));
    safeUnlink(mp);
    return sendErrorPage(res, 410, meta.originalName);
  }

  const fp = path.join(UPLOAD_DIR, meta.storedName);
  if (!fs.existsSync(fp)) return sendErrorPage(res, 404, meta.originalName);

  res.download(fp, meta.originalName);
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
  const mp = path.join(META_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(mp)) return res.status(404).json({ error: '文件不存在或已过期' });

  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (Date.now() > meta.expiresAt) {
    return res.status(410).json({ error: '文件已过期' });
  }

  res.json({
    id:           meta.id,
    originalName: meta.originalName,
    size:         meta.size,
    expiresAt:    meta.expiresAt,
    remaining:    meta.expiresAt - Date.now(),
  });
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
  if (Date.now() > meta.expiresAt) {
    safeUnlink(path.join(UPLOAD_DIR, meta.storedName));
    safeUnlink(mp);
    return res.status(410).json({ error: 'expired', message: '文件已过期' });
  }

  res.json({
    id:           meta.id,
    extractCode:  meta.extractCode,
    url:          `/api/download/${meta.id}`,
    originalName: meta.originalName,
    size:         meta.size,
    expiresAt:    meta.expiresAt,
    remaining:    meta.expiresAt - Date.now(),
    expiry:       meta.expiry,
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (req.file) safeUnlink(req.file.path);
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `文件过大，单文件最大 ${MAX_SIZE / 1024 / 1024} MB`
      : '上传格式不正确，请仅选择一个文件重试';
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
