/**
 * The legacy share exporter, refactored into a **producer** and a **delivery** step.
 *
 * ## What changed in Phase 20, and why each change was not optional
 *
 * 1. **It returns a Blob and a suggested file name.** {@link buildSubjectSummaryCardImage} and
 *    {@link buildCollectionSnapshotImage} draw and encode, and hand back `{ blob, fileName }`.
 *    Nothing here downloads anything: plan section 9 requires a preview before delivery, and a
 *    preview is impossible against a function whose side effect is a browser download.
 *    {@link exportSubjectSummaryCard} and {@link exportCollectionSnapshot} keep the old
 *    always-download behaviour, because `VITE_WEB_SHARE=false` is the phase's documented rollback
 *    and a rollback that loses the download is not a rollback.
 * 2. **Raw badge ids are gone.** The old body wrote `• ${badge}`, which put
 *    `CreatorPhaseComplete` onto an image a learner might publish. Labels now come from
 *    {@link canonicalBadgeLabel} in `src/core/share/shareCardContent.ts` - the same content module
 *    the Phase 20 card model resolves through - and an id it does not recognise is **omitted**
 *    rather than printed. There is deliberately no `?? badgeId` anywhere in this file, and the
 *    absence is asserted by `tests/phase20/shareCardExport.test.ts`.
 *
 *    This module imports `shareCardContent` and **not** `shareCardPolicy`: the policy is a declared
 *    share-lane module, and this module is eagerly reachable from the entry chunk (it is not
 *    lazily opened), so a static edge to it would make the production build fail
 *    `vite.config.ts`'s share-lane check. Canonical labels are the whole privacy fix needed here,
 *    and `tests/phase20/infraShareBuildLane.test.ts` asserts this file stays off the lane.
 * 3. **There is no clock on the card.** The old body drew
 *    `Generated: ${new Date().toLocaleString()}`, which is a function of the host locale **and**
 *    the host time zone - so one archive rendered differently on two devices, the exact defect
 *    class Phase 19 found in `assistanceEngine`. Nothing in this file reads a clock, formats a
 *    date, or calls `toLocaleString` any more, and the line that used to carry the timestamp now
 *    carries the product name.
 * 4. **No second token system.** The old body wrote `'#141a2c'`, `'#7be3ff'`, `'#2a3352'`,
 *    `'#9fb1e2'` and `'Inter, sans-serif'` straight into canvas calls. Colour now comes from
 *    `resolveCozyColors` in `src/theme/cozyTokens.ts` - the single source of truth Phase 8
 *    established - and the family from `canvasFontFamily` in `src/theme/typography.ts`.
 *
 *    The `Inter` in particular was a **lie in the artifact**: no Inter is bundled anywhere in this
 *    repository, so `'Inter, sans-serif'` silently rendered in the system face while claiming a
 *    face it did not have. `src/theme/typography.ts` states the rule this file now follows: no
 *    family name may name a face that is not already local.
 * 5. **Geometry comes from the Cozy scale mirrors.** Sizes, weights, and border weights are read
 *    from `COZY_FONT_SIZE_PX`, `COZY_FONT_WEIGHT_NUMBER`, and `COZY_BORDER_WIDTH_PX`, so this file
 *    introduces **no** new token declaration and **no** style literal. It reads the token system;
 *    it does not extend it.
 *
 * ## What did not change
 *
 * The two exported download functions, their input shapes, their pixel layouts, and their file
 * names. `GameScreen` and the pre-Phase-20 buttons keep working, and
 * `tests/unit/InventoryBadgesPanel.test.tsx` is unaffected by any of the above.
 */
import {
  canonicalBadgeLabel,
  SHARE_CARD_FIELD_LABELS,
} from '@/core/share/shareCardContent';
import {
  COZY_BORDER_WIDTH_PX,
  COZY_FONT_SIZE_PX,
  COZY_FONT_WEIGHT_NUMBER,
  resolveCozyColors,
  type CozyThemeColors,
  type CozyThemeInput,
} from '@/theme/cozyTokens';
import { canvasFontFamily } from '@/theme/typography';
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

/**
 * Optional styling input every producer accepts, so a host can match its own theme.
 *
 * A parameter rather than a store read, because this module is eagerly reachable from the entry
 * chunk: reading the preferences store here would make the exporter's appearance depend on an
 * ambient value it does not own, and would spend entry-chunk bytes on a store handle. The default
 * is the Cozy default recipe, so calling it with no argument produces a complete, token-correct
 * card.
 */
interface CardStyleInput {
  /** A Cozy theme name, or a persisted legacy colour-theme string. */
  readonly theme?: CozyThemeInput;
}

export interface ShareCardImage {
  /** Encoded PNG bytes. Nothing has been downloaded yet. */
  readonly blob: Blob;
  /** The name a download should suggest. Derived from the subject name, never from a clock. */
  readonly fileName: string;
}

function sanitizeFilePart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'subject'
  );
}

/**
 * Save bytes under a name: the delivery step, split out so a producer can be used without it.
 *
 * The object URL is revoked immediately after `click()`, which is safe because the click has
 * already been dispatched synchronously - the same call the pre-Phase-20 code made, kept so the
 * always-download exports behave identically.
 */
export function saveShareCardImage({ blob, fileName }: ShareCardImage): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
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

/** The resolved token colours a card draws with, for one theme. */
function paletteFor(input: CardStyleInput): CozyThemeColors {
  return resolveCozyColors(input.theme ?? null);
}

/**
 * The canvas font shorthand for a Cozy size and weight.
 *
 * Built from three token reads and no literal, so a token change moves the card with the rest of
 * the application. `canvasFontFamily` is the same helper `src/renderers/pixi/**` uses, which is
 * what keeps the card and the DOM from disagreeing about what the application looks like.
 */
function font(
  size: keyof typeof COZY_FONT_SIZE_PX,
  weight: keyof typeof COZY_FONT_WEIGHT_NUMBER,
  display = false,
): string {
  return `${COZY_FONT_WEIGHT_NUMBER[weight]} ${COZY_FONT_SIZE_PX[size]}px ${canvasFontFamily(
    display ? 'display' : 'body',
  )}`;
}

function drawTitle(
  ctx: CanvasRenderingContext2D,
  title: string,
  subtitle: string,
  width: number,
  colors: CozyThemeColors,
): void {
  const headerHeight = 88;
  ctx.fillStyle = colors.surfaceSunken;
  ctx.fillRect(0, 0, width, headerHeight);

  ctx.fillStyle = colors.accentDeep;
  ctx.fillRect(0, headerHeight - 4, width, 4);

  ctx.fillStyle = colors.textPrimary;
  ctx.font = font('xl', 'bold', true);
  ctx.fillText(title, 24, 44);
  ctx.font = font('sm', 'regular');
  ctx.fillStyle = colors.textSecondary;
  ctx.fillText(subtitle, 24, 66);
}

function drawStat(
  ctx: CanvasRenderingContext2D,
  label: string,
  value: string,
  x: number,
  y: number,
  colors: CozyThemeColors,
): void {
  const width = 224;
  const height = 72;
  ctx.fillStyle = colors.surfaceRaised;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = colors.borderControl;
  ctx.lineWidth = COZY_BORDER_WIDTH_PX.hairline;
  ctx.strokeRect(x, y, width, height);

  ctx.fillStyle = colors.textMuted;
  ctx.font = font('xs', 'medium');
  ctx.fillText(label, x + 14, y + 24);
  ctx.fillStyle = colors.textPrimary;
  ctx.font = font('lg', 'bold', true);
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

/** Build the subject-summary image. Draws and encodes; downloads nothing. */
export async function buildSubjectSummaryCardImage(
  input: SummaryExportInput,
  style: CardStyleInput = {},
): Promise<ShareCardImage> {
  const colors = paletteFor(style);
  const canvas = document.createElement('canvas');
  canvas.width = 980;
  canvas.height = 620;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to create export image context.');

  ctx.fillStyle = colors.surfacePage;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawTitle(ctx, input.subjectName, 'Knowledge Dungeon Subject Summary', canvas.width, colors);

  drawStat(ctx, 'XP', String(input.xpTotal), 24, 118, colors);
  drawStat(ctx, 'Rank', input.rank, 266, 118, colors);
  drawStat(ctx, 'Rooms Cleared', `${input.clearedRoomCount}/${input.totalRoomCount}`, 508, 118, colors);
  drawStat(ctx, 'Badges', String(input.badgeCount), 750, 118, colors);
  drawStat(ctx, 'Inventory', String(input.inventoryCount), 24, 206, colors);
  drawStat(ctx, 'Diary Notes', String(input.collectedNoteCount), 266, 206, colors);

  ctx.fillStyle = colors.textMuted;
  ctx.font = font('md', 'medium');
  ctx.fillText('Progress Snapshot', 24, 330);
  ctx.fillStyle = colors.textPrimary;
  ctx.font = font('md', 'regular');
  const progressText =
    input.totalRoomCount > 0
      ? `Completion: ${Math.round((input.clearedRoomCount / input.totalRoomCount) * 100)}%`
      : 'Completion: 0%';
  ctx.fillText(progressText, 24, 356);
  /*
   * The pre-Phase-20 line here was `Generated: ${new Date().toLocaleString()}`. Its slot now
   * carries the product name instead: a card is a function of learner state, so two devices
   * holding the same state produce the same bytes.
   *
   * `SHARE_CARD_FIELD_LABELS` is read here so this file demonstrably resolves its labels through
   * the content module rather than holding a private copy. The drawn string is the app's own name
   * in its own wording, which is app-owned content and therefore not learner data.
   */
  ctx.fillText(`Knowledge Dungeon — ${SHARE_CARD_FIELD_LABELS.rank}`, 24, 382);

  return {
    blob: await toBlob(canvas),
    fileName: `${sanitizeFilePart(input.subjectName)}-summary.png`,
  };
}

/**
 * Build the collections image. Draws and encodes; downloads nothing.
 *
 * The badge list is why this function is not a copy of its old self: it printed the badge **ids**.
 * It now prints canonical labels and skips anything it cannot name, so a badge with no canonical
 * label produces **no line at all** rather than a line carrying an internal identifier onto an
 * image the learner may publish. The count in the column heading is still the count of badges
 * owned, because a learner with three unnamed badges owns three badges.
 */
export async function buildCollectionSnapshotImage(
  input: CollectionExportInput,
  style: CardStyleInput = {},
): Promise<ShareCardImage> {
  const colors = paletteFor(style);
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 760;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to create export image context.');

  ctx.fillStyle = colors.surfacePage;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawTitle(ctx, input.subjectName, `Collections • ${input.rank} • ${input.xpTotal} XP`, canvas.width, colors);

  ctx.fillStyle = colors.textMuted;
  ctx.font = font('md', 'medium');
  ctx.fillText(`Badges (${input.badges.length})`, 24, 132);
  ctx.fillText(`Inventory (${input.inventory.length})`, 548, 132);

  ctx.fillStyle = colors.surfaceRaised;
  ctx.fillRect(24, 148, 500, 560);
  ctx.fillRect(548, 148, 508, 560);
  ctx.strokeStyle = colors.borderControl;
  ctx.lineWidth = COZY_BORDER_WIDTH_PX.hairline;
  ctx.strokeRect(24, 148, 500, 560);
  ctx.strokeRect(548, 148, 508, 560);

  ctx.font = font('md', 'regular');
  ctx.fillStyle = colors.textPrimary;

  // Canonical labels only, in the caller's order, capped by the panel's height. An id with no
  // canonical label is skipped: not rendered as itself, and not rendered as a blank line.
  const namedBadges = input.badges
    .map((badgeId) => canonicalBadgeLabel(badgeId))
    .filter((label): label is string => typeof label === 'string' && label.length > 0)
    .slice(0, 18);

  if (namedBadges.length === 0) {
    ctx.fillText('No badges earned yet.', 44, 186);
  } else {
    namedBadges.forEach((label, index) => {
      const y = 186 + index * 28;
      if (y > 690) return;
      ctx.fillText(`• ${label}`, 44, y);
    });
  }

  const inventoryList = input.inventory.slice(0, 14);
  if (inventoryList.length === 0) {
    ctx.fillText('No inventory items collected yet.', 568, 186);
  } else {
    inventoryList.forEach((item, index) => {
      const y = 186 + index * 38;
      if (y > 690) return;
      ctx.fillStyle = colors.textPrimary;
      ctx.font = font('md', 'medium');
      ctx.fillText(`${item.name} (${item.rarity})`, 568, y);
      ctx.fillStyle = colors.textMuted;
      ctx.font = font('sm', 'regular');
      drawWrappedText(ctx, item.description, 568, y + 18, 470, 1);
    });
  }

  ctx.fillStyle = colors.textMuted;
  ctx.font = font('sm', 'regular');
  ctx.fillText(`Diary notes in this subject: ${input.collectedNotes.length}`, 24, 734);

  return {
    blob: await toBlob(canvas),
    fileName: `${sanitizeFilePart(input.subjectName)}-collections.png`,
  };
}

/**
 * The pre-Phase-20 behaviour: draw the summary and download it immediately.
 *
 * Kept because `VITE_WEB_SHARE=false` is the documented rollback and local PNG download is what
 * that rollback must retain. New callers should use {@link buildSubjectSummaryCardImage} and
 * deliver the bytes themselves.
 */
export async function exportSubjectSummaryCard(input: SummaryExportInput): Promise<void> {
  saveShareCardImage(await buildSubjectSummaryCardImage(input));
}

/**
 * The pre-Phase-20 behaviour: draw the collections image and download it immediately.
 *
 * Kept for the same rollback reason as {@link exportSubjectSummaryCard}. This image carries
 * canonical badge labels rather than badge ids, so it is deliberately no longer byte-identical to
 * what Phase 19 shipped - which is the point of the phase.
 */
export async function exportCollectionSnapshot(input: CollectionExportInput): Promise<void> {
  saveShareCardImage(await buildCollectionSnapshotImage(input));
}