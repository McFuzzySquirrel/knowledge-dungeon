import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged;
const devServerUrl = process.env.VITE_DEV_SERVER_URL;

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
