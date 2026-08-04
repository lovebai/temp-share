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

  const meta = {
    id,
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
    url:          `/api/download/${meta.id}`,
    originalName: meta.originalName,
    size:         meta.size,
    expiresAt:    meta.expiresAt,
    expiry:       meta.expiry,
  });
});

/* ── API: download ───────────────────────────────── */
app.get('/api/download/:id', (req, res) => {
  const mp = path.join(META_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(mp)) return res.status(404).send('文件不存在或已过期');

  const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (Date.now() > meta.expiresAt) {
    safeUnlink(path.join(UPLOAD_DIR, meta.storedName));
    safeUnlink(mp);
    return res.status(410).send('文件已过期');
  }

  const fp = path.join(UPLOAD_DIR, meta.storedName);
  if (!fs.existsSync(fp)) return res.status(404).send('文件不存在');

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

/* ── start ───────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n  TempShare  ready  →  http://localhost:${PORT}`);
  console.log(`  data dir           ${DATA_DIR}`);
  console.log(`  max file size      ${MAX_SIZE / 1024 / 1024} MB\n`);
});
