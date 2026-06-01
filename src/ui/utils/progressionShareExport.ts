import type { CollectedNoteEntry, LootItem } from '@/store/progressionStore';

interface SummaryExportInput {
  subjectName: string;
  xpTotal: number;
  rank: string;
  badgeCount: number;
  inventoryCount: number;
  collectedNoteCount: number;
  clearedRoomCount: number;
  totalRoomCount: number;
}

interface CollectionExportInput {
  subjectName: string;
  xpTotal: number;
  rank: string;
  badges: readonly string[];
  inventory: readonly LootItem[];
  collectedNotes: readonly CollectedNoteEntry[];
}

function sanitizeFilePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'subject';
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Unable to create export image blob.'));
      }
    }, 'image/png');
  });
}

function drawTitle(ctx: CanvasRenderingContext2D, title: string, subtitle: string, width: number): void {
  ctx.fillStyle = '#141a2c';
  ctx.fillRect(0, 0, width, 88);

  const gradient = ctx.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, '#7be3ff');
  gradient.addColorStop(1, '#ffcf5f');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 84, width, 4);

  ctx.fillStyle = '#eef3ff';
  ctx.font = '700 26px Inter, sans-serif';
  ctx.fillText(title, 24, 44);
  ctx.font = '500 14px Inter, sans-serif';
  ctx.fillStyle = '#b8c5ea';
  ctx.fillText(subtitle, 24, 66);
}

function drawStat(ctx: CanvasRenderingContext2D, label: string, value: string, x: number, y: number): void {
  ctx.fillStyle = '#2a3352';
  ctx.fillRect(x, y, 224, 72);
  ctx.strokeStyle = '#4c5a8f';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, 224, 72);

  ctx.fillStyle = '#9fb1e2';
  ctx.font = '600 12px Inter, sans-serif';
  ctx.fillText(label, x + 14, y + 24);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 20px Inter, sans-serif';
  ctx.fillText(value, x + 14, y + 50);
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  maxLines: number,
): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return y;

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length >= maxLines - 1) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);

  lines.forEach((line, index) => {
    ctx.fillText(line, x, y + index * 18);
  });
  return y + lines.length * 18;
}

export async function exportSubjectSummaryCard(input: SummaryExportInput): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = 980;
  canvas.height = 620;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to create export image context.');

  ctx.fillStyle = '#0f1426';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawTitle(ctx, input.subjectName, 'Knowledge Dungeon Subject Summary', canvas.width);

  drawStat(ctx, 'XP', String(input.xpTotal), 24, 118);
  drawStat(ctx, 'Rank', input.rank, 266, 118);
  drawStat(ctx, 'Rooms Cleared', `${input.clearedRoomCount}/${input.totalRoomCount}`, 508, 118);
  drawStat(ctx, 'Badges', String(input.badgeCount), 750, 118);
  drawStat(ctx, 'Inventory', String(input.inventoryCount), 24, 206);
  drawStat(ctx, 'Diary Notes', String(input.collectedNoteCount), 266, 206);

  ctx.fillStyle = '#9fb1e2';
  ctx.font = '600 14px Inter, sans-serif';
  ctx.fillText('Progress Snapshot', 24, 330);
  ctx.fillStyle = '#e7eeff';
  ctx.font = '500 15px Inter, sans-serif';
  const progressText =
    input.totalRoomCount > 0
      ? `Completion: ${Math.round((input.clearedRoomCount / input.totalRoomCount) * 100)}%`
      : 'Completion: 0%';
  ctx.fillText(progressText, 24, 356);
  ctx.fillText(`Generated: ${new Date().toLocaleString()}`, 24, 382);

  const blob = await toBlob(canvas);
  saveBlob(blob, `${sanitizeFilePart(input.subjectName)}-summary.png`);
}

export async function exportCollectionSnapshot(input: CollectionExportInput): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 760;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to create export image context.');

  ctx.fillStyle = '#10172c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawTitle(ctx, input.subjectName, `Collections • ${input.rank} • ${input.xpTotal} XP`, canvas.width);

  ctx.fillStyle = '#9fb1e2';
  ctx.font = '600 16px Inter, sans-serif';
  ctx.fillText(`Badges (${input.badges.length})`, 24, 132);
  ctx.fillText(`Inventory (${input.inventory.length})`, 548, 132);

  ctx.fillStyle = '#202c49';
  ctx.fillRect(24, 148, 500, 560);
  ctx.fillRect(548, 148, 508, 560);
  ctx.strokeStyle = '#44568e';
  ctx.strokeRect(24, 148, 500, 560);
  ctx.strokeRect(548, 148, 508, 560);

  ctx.font = '500 14px Inter, sans-serif';
  ctx.fillStyle = '#eaf0ff';

  const badgeList = input.badges.slice(0, 18);
  if (badgeList.length === 0) {
    ctx.fillText('No badges earned yet.', 44, 186);
  } else {
    badgeList.forEach((badge, index) => {
      const y = 186 + index * 28;
      if (y > 690) return;
      ctx.fillText(`• ${badge}`, 44, y);
    });
  }

  const inventoryList = input.inventory.slice(0, 14);
  if (inventoryList.length === 0) {
    ctx.fillText('No inventory items collected yet.', 568, 186);
  } else {
    inventoryList.forEach((item, index) => {
      const y = 186 + index * 38;
      if (y > 690) return;
      ctx.fillStyle = '#eaf0ff';
      ctx.font = '600 14px Inter, sans-serif';
      ctx.fillText(`${item.name} (${item.rarity})`, 568, y);
      ctx.fillStyle = '#b9c8ed';
      ctx.font = '500 13px Inter, sans-serif';
      drawWrappedText(ctx, item.description, 568, y + 18, 470, 1);
    });
  }

  ctx.fillStyle = '#9fb1e2';
  ctx.font = '500 13px Inter, sans-serif';
  ctx.fillText(`Diary notes in this subject: ${input.collectedNotes.length}`, 24, 734);

  const blob = await toBlob(canvas);
  saveBlob(blob, `${sanitizeFilePart(input.subjectName)}-collections.png`);
}
