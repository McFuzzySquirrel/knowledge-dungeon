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
const ASSETS_ROOT = path.join(ROOT, 'public', 'assets');
const MANIFEST_PATH = path.join(ASSETS_ROOT, 'sprite-manifest.json');

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

// Serve sprite manifest from public/assets/ (generated on startup below)
app.get('/api/sprite-manifest', (_req, res) => {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return res.status(404).json({ error: 'Manifest not found' });
  }
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    res.json(JSON.parse(raw));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

app.use((err, _req, res, _next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message });
});

// Generate sprite manifest on startup if assets root exists.
// In production, the public/ dir may not exist separately; fall back to scanning dist/.
function generateManifestOnStartup() {
  const assetsDir = fs.existsSync(ASSETS_ROOT) ? ASSETS_ROOT : path.join(ROOT, 'dist', 'assets');
  if (!fs.existsSync(assetsDir)) {
    console.warn('Assets directory not found; skipping sprite manifest generation.');
    return;
  }

  const sprites = [];
  const queue = [''];
  while (queue.length > 0) {
    const subdir = queue.pop();
    const fullDir = path.join(assetsDir, subdir);
    let entries;
    try {
      entries = fs.readdirSync(fullDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relPath = subdir ? `${subdir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        queue.push(relPath);
      } else if (entry.name.endsWith('.svg')) {
        const content = fs.readFileSync(path.join(fullDir, entry.name), 'utf-8');
        let width = 64;
        let height = 64;
        const wm = content.match(/<svg[^>]*\swidth\s*=\s*"(\d+)"/i);
        const hm = content.match(/<svg[^>]*\sheight\s*=\s*"(\d+)"/i);
        if (wm && hm) {
          width = parseInt(wm[1], 10);
          height = parseInt(hm[1], 10);
        } else {
          const vm = content.match(/<svg[^>]*\sviewBox\s*=\s*"\d+\s+\d+\s+(\d+)\s+(\d+)"/i);
          if (vm) {
            width = parseInt(vm[1], 10);
            height = parseInt(vm[2], 10);
          }
        }
        const name = path.basename(entry.name, '.svg');
        const category = subdir ? subdir.charAt(0).toUpperCase() + subdir.slice(1) : 'Sprites';
        sprites.push({ path: relPath.replace(/\\/g, '/'), name, category, width, height });
      }
    }
  }

  sprites.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    generatedAt: new Date().toISOString(),
    totalSprites: sprites.length,
    sprites,
  };

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log(`Sprite manifest generated: ${MANIFEST_PATH} (${sprites.length} sprites)`);
}

generateManifestOnStartup();

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Knowledge Dungeon server running on http://0.0.0.0:${PORT}`);
  console.log(`  Data directory: ${DATA_DIR}`);
});
