/**
 * Self-hosted production server for Knowledge Dungeon.
 * Serves the built web app, handles image uploads, and persists subjects
 * to disk so data survives container restarts.
 *
 * Usage:
 *   npm run build   # build the web app
 *   npm start       # starts server on PORT (default 3000)
 *
 * Environment variables:
 *   PORT          – server port (default 3000)
 *   DATA_DIR      – where subjects + uploads are stored (default ./data)
 */

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const SUBJECTS_DIR = path.join(DATA_DIR, 'subjects');

for (const dir of [DATA_DIR, UPLOADS_DIR, SUBJECTS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}`));
  },
});

const app = express();
app.use(express.json({ limit: '5mb' }));

app.use(express.static(path.join(ROOT, 'dist')));
app.use('/uploads', express.static(UPLOADS_DIR));

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.filename });
});

app.post('/api/subjects/:subjectId', (req, res) => {
  const { subjectId } = req.params;
  const safeId = subjectId.replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(SUBJECTS_DIR, `${safeId}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/subjects/:subjectId', (req, res) => {
  const { subjectId } = req.params;
  const safeId = subjectId.replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(SUBJECTS_DIR, `${safeId}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    res.json(JSON.parse(data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/subjects', (_req, res) => {
  try {
    const files = fs.readdirSync(SUBJECTS_DIR).filter((f) => f.endsWith('.json'));
    res.json(files.map((f) => f.replace(/\.json$/, '')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/subjects/:subjectId', (req, res) => {
  const { subjectId } = req.params;
  const safeId = subjectId.replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(SUBJECTS_DIR, `${safeId}.json`);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Knowledge Dungeon server running on http://0.0.0.0:${PORT}`);
  console.log(`  Data directory: ${DATA_DIR}`);
});
