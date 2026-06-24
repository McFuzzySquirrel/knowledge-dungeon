import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Dirent } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

if (process.platform === 'linux' && isDev) {
  // Local dev environments often cannot set root ownership/mode on chrome-sandbox.
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-setuid-sandbox');
}

function isSafeExternalUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function dungeonDataRoot(): string {
  return path.join(app.getPath('userData'), 'dungeon-data');
}

function sanitizeSubjectId(id: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error('Invalid subject id');
  }
  return id;
}

function sanitizeRoomId(id: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error('Invalid room id');
  }
  return id;
}

function sanitizeAttachmentId(id: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error('Invalid attachment id');
  }
  return id;
}

function makeAttachmentId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `att-${time}-${random}`;
}

function isSafeExternalImageUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function addRoomLocalAttachment(subjectId: string, roomId: string): Promise<unknown> {
  const result = await dialog.showOpenDialog({
    title: 'Attach image to room',
    filters: [
      {
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
      },
    ],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const sourcePath = result.filePaths[0];
  const extension = path.extname(sourcePath).toLowerCase();
  const mimeType = IMAGE_MIME_BY_EXT[extension];
  if (!mimeType) {
    throw new Error('Unsupported image format');
  }

  const sourceStat = await fs.stat(sourcePath);
  if (!sourceStat.isFile()) {
    throw new Error('Attachment source is not a file');
  }
  if (sourceStat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('Image too large (max 10MB)');
  }

  const safeRoomId = sanitizeRoomId(roomId);
  const subjectRoot = await ensureSubjectRoot(subjectId);
  const attachmentsDir = path.join(subjectRoot, 'rooms', safeRoomId, 'attachments');
  await fs.mkdir(attachmentsDir, { recursive: true });

  const attachmentId = makeAttachmentId();
  const outputFileName = `${attachmentId}${extension}`;
  const outputPath = path.join(attachmentsDir, outputFileName);
  await fs.copyFile(sourcePath, outputPath);

  const originalName = path.basename(sourcePath);
  const altText = path.basename(originalName, extension).replace(/[_-]+/g, ' ').trim();

  return {
    attachmentId,
    sourceType: 'local',
    fileName: originalName,
    mimeType,
    relativePath: `rooms/${safeRoomId}/attachments/${outputFileName}`,
    ...(altText.length > 0 ? { altText } : {}),
    addedAt: new Date().toISOString(),
  };
}

async function resolveExternalImageMimeType(url: string): Promise<string> {
  async function requestContentType(method: 'HEAD' | 'GET'): Promise<string | null> {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      ...(method === 'GET' ? { headers: { Range: 'bytes=0-0' } } : {}),
    });
    if (!response.ok) return null;
    return response.headers.get('content-type')?.toLowerCase() ?? null;
  }

  try {
    let contentType = await requestContentType('HEAD');
    if (!contentType) {
      contentType = await requestContentType('GET');
    }
    if (contentType && contentType.startsWith('image/')) {
      return contentType;
    }
    throw new Error('URL must point directly to an image resource.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to validate image URL.';
    throw new Error(message);
  }
}

async function buildExternalAttachment(url: string): Promise<unknown> {
  const normalized = url.trim();
  if (!isSafeExternalImageUrl(normalized)) {
    throw new Error('Only https image URLs are allowed');
  }

  const mimeType = await resolveExternalImageMimeType(normalized);

  const parsed = new URL(normalized);
  const pathBase = path.basename(parsed.pathname);
  const fileName = pathBase.length > 0 ? pathBase : parsed.hostname;
  const altText = fileName.replace(/[_-]+/g, ' ').replace(/\.[a-z0-9]+$/i, '').trim();

  return {
    attachmentId: makeAttachmentId(),
    sourceType: 'external',
    fileName,
    mimeType,
    externalUrl: normalized,
    ...(altText.length > 0 ? { altText } : {}),
    addedAt: new Date().toISOString(),
  };
}

async function deleteRoomAttachment(
  subjectId: string,
  roomId: string,
  attachmentId: string,
): Promise<boolean> {
  const safeRoomId = sanitizeRoomId(roomId);
  const safeAttachmentId = sanitizeAttachmentId(attachmentId);
  const subjectRoot = await ensureSubjectRoot(subjectId);
  const attachmentsDir = path.join(subjectRoot, 'rooms', safeRoomId, 'attachments');

  const entries = await fs.readdir(attachmentsDir).catch(() => [] as string[]);
  const match = entries.find((entry) => entry.startsWith(safeAttachmentId));
  if (!match) return false;

  await fs.rm(path.join(attachmentsDir, match), { force: true });
  return true;
}

async function resolveRoomAttachmentUrl(
  subjectId: string,
  roomId: string,
  attachmentId: string,
): Promise<string | null> {
  const safeRoomId = sanitizeRoomId(roomId);
  const safeAttachmentId = sanitizeAttachmentId(attachmentId);
  const subjectRoot = await ensureSubjectRoot(subjectId);
  const attachmentsDir = path.join(subjectRoot, 'rooms', safeRoomId, 'attachments');

  const entries = await fs.readdir(attachmentsDir).catch(() => [] as string[]);
  const match = entries.find((entry) => entry.startsWith(safeAttachmentId));
  if (!match) return null;

  return pathToFileURL(path.join(attachmentsDir, match)).toString();
}

async function ensureSubjectRoot(subjectId: string): Promise<string> {
  const safe = sanitizeSubjectId(subjectId);
  const dir = path.join(dungeonDataRoot(), safe);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function makeEmptyValidationState() {
  return {
    wordCount: 0,
    requiredSectionsPresent: false,
    manualConfirmed: false,
    criterionScores: {
      sectionCompleteness: 0,
      conceptTermCoverage: 0,
      linkReferences: 0,
      recallQuestionQuality: 0,
      clarityReadability: 0,
    },
    failedChecks: [],
    qualityBonus: 0,
    finalPass: false,
  };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

async function buildSubjectSnapshotFromFolder(folderPath: string): Promise<unknown> {
  const dungeonFilePath = path.join(folderPath, 'dungeon.json');
  const rawDungeon = await fs.readFile(dungeonFilePath, 'utf8');
  const parsed = JSON.parse(rawDungeon) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.dungeon) || !Array.isArray(parsed.dungeon.rooms)) {
    throw new Error('Invalid subject folder format');
  }

  const dungeon = parsed.dungeon;
  const rooms = dungeon.rooms as Array<Record<string, unknown>>;
  const importedRooms: Record<string, unknown> = {};

  async function resolveRoomDir(roomId: string): Promise<string> {
    const directDir = path.join(folderPath, 'rooms', roomId);
    const directStat = await fs.stat(directDir).catch(() => null);
    if (directStat?.isDirectory()) {
      return directDir;
    }

    const prefixedDir = path.join(folderPath, 'rooms', `room-${roomId}`);
    const prefixedStat = await fs.stat(prefixedDir).catch(() => null);
    if (prefixedStat?.isDirectory()) {
      return prefixedDir;
    }

    return directDir;
  }

  for (const room of rooms) {
    const roomId = typeof room.roomId === 'string' ? room.roomId : null;
    const topic = typeof room.topic === 'string' ? room.topic : roomId;
    if (!roomId || !topic) continue;
    const roomDir = await resolveRoomDir(roomId);
    const noteText = (await readTextIfExists(path.join(roomDir, 'notes.txt'))) ?? '';
    const explicitArtifactMarkdown = await readTextIfExists(path.join(roomDir, 'artifact.md'));
    const artifactMarkdown = explicitArtifactMarkdown ?? (noteText.trim().length > 0 ? noteText : null);
    const nowIso = new Date().toISOString();
    const hasImportedArtifact = noteText.trim().length > 0 || artifactMarkdown !== null;
    const validationState = makeEmptyValidationState();
    if (hasImportedArtifact) {
      validationState.wordCount = countWords(noteText);
      validationState.requiredSectionsPresent = true;
      validationState.manualConfirmed = true;
      validationState.finalPass = true;
    }
    const roomFolderName = path.basename(roomDir);
    importedRooms[roomId] = {
      roomId,
      topic,
      createdAt: typeof room.createdAt === 'string' ? room.createdAt : nowIso,
      updatedAt: typeof room.updatedAt === 'string' ? room.updatedAt : nowIso,
      state: hasImportedArtifact ? 'ArtifactCollected' : typeof room.status === 'string' ? room.status : 'Created',
      notePath: `rooms/${roomFolderName}/notes.txt`,
      artifactPath: `rooms/${roomFolderName}/artifact.md`,
      noteText,
      artifactMarkdown,
      validationState,
      reviewPassCount: 0,
      attachments: [],
    };
  }

  return {
    dungeon: {
      ...dungeon,
    },
    rooms: importedRooms,
  };
}

async function writeSubjectSnapshot(subjectId: string, snapshot: unknown): Promise<void> {
  const dir = await ensureSubjectRoot(subjectId);
  const filePath = path.join(dir, 'dungeon.json');
  const backupDir = path.join(dir, '.backups');
  await fs.mkdir(backupDir, { recursive: true });
  try {
    const previous = await fs.readFile(filePath, 'utf8');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(backupDir, `dungeon-${stamp}.json`), previous, 'utf8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') throw err;
  }
  await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
}

function registerKnowledgeBridgeHandlers(): void {
  ipcMain.handle('knowledge:read-subject', async (_event, subjectId: string) => {
    try {
      const dir = await ensureSubjectRoot(subjectId);
      const filePath = path.join(dir, 'dungeon.json');
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw) as unknown;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  });

  ipcMain.handle(
    'knowledge:write-subject',
    async (_event, subjectId: string, snapshot: unknown) => {
      await writeSubjectSnapshot(subjectId, snapshot);
    },
  );

  ipcMain.handle('knowledge:import-subject-folder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select subject folder to import',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const folderPath = result.filePaths[0];
    const snapshot = await buildSubjectSnapshotFromFolder(folderPath);
    if (!isRecord(snapshot) || !isRecord(snapshot.dungeon)) {
      throw new Error('Invalid subject snapshot');
    }
    const subjectId = typeof snapshot.dungeon.dungeonId === 'string' ? snapshot.dungeon.dungeonId : '';
    if (!subjectId) {
      throw new Error('Imported subject is missing a dungeonId');
    }

    await writeSubjectSnapshot(subjectId, snapshot);
    return snapshot;
  });

  ipcMain.handle('knowledge:list-subjects', async () => {
    try {
      const root = dungeonDataRoot();
      const entries = await fs.readdir(root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  });

  ipcMain.handle('knowledge:delete-subject', async (_event, subjectId: string) => {
    const dir = await ensureSubjectRoot(subjectId);
    await fs.rm(dir, { recursive: true, force: true });
  });

  ipcMain.handle('knowledge:open-subjects-folder', async () => {
    const root = dungeonDataRoot();
    await fs.mkdir(root, { recursive: true });
    const openError = await shell.openPath(root);
    return openError.length === 0;
  });

  ipcMain.handle('knowledge:export-subjects-root', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select export destination',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const sourceRoot = dungeonDataRoot();
    await fs.mkdir(sourceRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(result.filePaths[0], `knowledge-dungeon-subjects-${stamp}`);
    await fs.cp(sourceRoot, destination, { recursive: true, force: true });
    return destination;
  });

  ipcMain.handle('knowledge:export-subject-folder', async (_event, subjectId: string) => {
    const safeSubjectId = sanitizeSubjectId(subjectId);
    const source = path.join(dungeonDataRoot(), safeSubjectId);
    const stat = await fs.stat(source).catch(() => null);
    if (!stat?.isDirectory()) return null;

    const result = await dialog.showOpenDialog({
      title: `Export ${safeSubjectId}`,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(result.filePaths[0], `${safeSubjectId}-${stamp}`);
    await fs.cp(source, destination, { recursive: true, force: true });
    return destination;
  });

  ipcMain.handle('knowledge:add-room-local-attachment', async (_event, subjectId: string, roomId: string) => {
    return addRoomLocalAttachment(subjectId, roomId);
  });

  ipcMain.handle(
    'knowledge:add-room-external-attachment',
    async (_event, _subjectId: string, _roomId: string, url: string) => {
      return buildExternalAttachment(url);
    },
  );

  ipcMain.handle(
    'knowledge:delete-room-attachment',
    async (_event, subjectId: string, roomId: string, attachmentId: string) => {
      return deleteRoomAttachment(subjectId, roomId, attachmentId);
    },
  );

  ipcMain.handle(
    'knowledge:resolve-room-attachment-url',
    async (_event, subjectId: string, roomId: string, attachmentId: string) => {
      return resolveRoomAttachmentUrl(subjectId, roomId, attachmentId);
    },
  );

  // ---- Custom sprite handlers ----

  const customSpritesRoot = () => path.join(app.getPath('userData'), 'custom-sprites');

  ipcMain.handle(
    'knowledge:save-custom-sprite',
    async (_event, spritePath: string, svgContent: string) => {
      const safePath = path.normalize(spritePath).replace(/^(\.\.[\/\\])+/, '');
      const userDataFile = path.join(customSpritesRoot(), safePath);
      await fs.mkdir(path.dirname(userDataFile), { recursive: true });
      await fs.writeFile(userDataFile, svgContent, 'utf8');

      // Also try to copy to public/assets/ for Vite dev server to serve
      const publicAssetsRoot = isDev
        ? path.resolve(__dirname, '..', '..', 'public', 'assets')
        : path.resolve(__dirname, '..', 'dist', 'assets');
      const publicFile = path.join(publicAssetsRoot, safePath);
      try {
        await fs.mkdir(path.dirname(publicFile), { recursive: true });
        await fs.writeFile(publicFile, svgContent, 'utf8');
      } catch {
        // Non-fatal - public/dist may be read-only in production builds.
        // The userData copy is the authoritative one.
      }
    },
  );

  ipcMain.handle(
    'knowledge:reset-custom-sprite',
    async (_event, spritePath: string) => {
      const safePath = path.normalize(spritePath).replace(/^(\.\.[\/\\])+/, '');
      const userDataFile = path.join(customSpritesRoot(), safePath);
      await fs.rm(userDataFile, { force: true });

      // Also try to remove from public/assets/
      const publicAssetsRoot = isDev
        ? path.resolve(__dirname, '..', '..', 'public', 'assets')
        : path.resolve(__dirname, '..', 'dist', 'assets');
      const publicFile = path.join(publicAssetsRoot, safePath);
      await fs.rm(publicFile, { force: true });
    },
  );

  ipcMain.handle('knowledge:get-sprite-manifest', async () => {
    const assetsRoot = isDev
      ? path.resolve(__dirname, '..', '..', 'public', 'assets')
      : path.resolve(__dirname, '..', 'dist', 'assets');

    const sprites: { path: string; name: string; category: string; width: number; height: number }[] = [];
    const queue = [''];

    while (queue.length > 0) {
      const subdir = queue.pop()!;
      const fullDir = path.join(assetsRoot, subdir);
      let entries: Dirent[];
      try {
        entries = await fs.readdir(fullDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const relPath = subdir ? `${subdir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          queue.push(relPath);
        } else if (entry.name.endsWith('.svg')) {
          const content = await fs.readFile(path.join(fullDir, entry.name), 'utf-8');
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
          const category = subdir
            ? subdir.charAt(0).toUpperCase() + subdir.slice(1)
            : 'Sprites';
          sprites.push({ path: relPath.replace(/\\/g, '/'), name, category, width, height });
        }
      }
    }

    sprites.sort((a, b) => a.path.localeCompare(b.path));
    return {
      generatedAt: new Date().toISOString(),
      totalSprites: sprites.length,
      sprites,
    };
  });

  ipcMain.handle(
    'knowledge:export-sprite-pack',
    async (_event, packJson: string) => {
      const result = await dialog.showSaveDialog({
        title: 'Export Sprite Pack',
        defaultPath: 'my-sprite-pack.kdpack',
        filters: [{ name: 'Knowledge Dungeon Pack', extensions: ['kdpack'] }],
      });
      if (result.canceled || !result.filePath) return null;
      await fs.writeFile(result.filePath, packJson, 'utf8');
      return result.filePath;
    },
  );

  ipcMain.handle('knowledge:import-sprite-pack', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import Sprite Pack',
      filters: [{ name: 'Knowledge Dungeon Pack', extensions: ['kdpack'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const raw = await fs.readFile(result.filePaths[0], 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('Invalid sprite pack file - not valid JSON');
    }
  });
}

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      devTools: isDev,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isSafeExternalUrl(url)) {
      return { action: 'deny' };
    }
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!isSafeExternalUrl(url)) {
      event.preventDefault();
    }
  });

  if (isDev && devServerUrl) {
    await window.loadURL(devServerUrl);
  } else {
    await window.loadFile(path.resolve(__dirname, '..', 'dist', 'index.html'));
  }
}

void app.whenReady().then(async () => {
  registerKnowledgeBridgeHandlers();
  await createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
