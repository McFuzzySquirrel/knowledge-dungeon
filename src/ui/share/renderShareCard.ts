/**
 * The Cozy share-card renderer: a `ShareCardModel` in, PNG bytes out.
 *
 * ## The one rule this module exists to keep
 *
 * **It draws from the model and from nothing else.** `ShareCardModel` is a counts-only projection the
 * domain produced under a privacy policy (`src/core/share/shareCardPolicy.ts`), and this file never
 * reaches a store, a service, `localStorage`, or the network. That is what makes the card-lazy premise
 * in `vite.config.ts` safe: a card cannot leak a note because a card is a function of data that never
 * contained a note.
 *
 * ## What is filtered here, and what is not
 *
 * The value-level decision lives in `./shareCardVisibility`, shared with the DOM surface, because the
 * canvas and the accessible text list must agree - and because an earlier version of this phase
 * filtered in both places and the two drifted, leaving the *text* publishing a subject name the
 * *image* had refused. One function, two callers.
 *
 * So this module asks `shareCardVisibility` what may be shown and draws exactly that. It adds one
 * thing of its own: a **field-level** filter, {@link mayFieldAppearOnCard}, which is the policy's own
 * documented renderer entry point. It cannot fire for a model the domain built, and it is kept
 * because a renderer that does not ask the policy is not using the policy it claims to use.
 *
 * Note what is deliberately *not* filtered: row labels. `SHARE_CARD_FIELD_LABELS` includes
 * `roomsCleared: 'Rooms cleared'`, and the value-level denylist denies anything containing the word
 * `room` - that is how it catches `room-7f3a`. Filtering labels here silently deleted both room rows
 * from every subject-summary card, which a row-count test caught. See the visibility module's header.
 *
 * ## No clock, ever
 *
 * There is no `Date`, no `new Date()`, no `toLocaleString`, and no timestamp in this file. Phase 19
 * shipped a bug of exactly this class in `assistanceEngine` - one archive rendered differently on two
 * devices because it read an offset-less timestamp as local time - and the pre-Phase-20 exporter drew
 * `Generated: ${new Date().toLocaleString()}` on an image. A card is a pure function of learner
 * state; two devices holding the same state draw the same pixels.
 *
 * ## Tokens, and no second token system
 *
 * Every colour comes from `resolveCozyColors` (`src/theme/cozyTokens.ts`) and every family from
 * `canvasFontFamily` (`src/theme/typography.ts`). Sizes, weights, spacing, and border widths come from
 * the `COZY_*_PX` / `COZY_*_NUMBER` mirrors of the same tables. This file therefore introduces **no**
 * token declaration and **no** style literal: the pre-Phase-20 exporter wrote `'#141a2c'` and
 * `'Inter, sans-serif'` inline, and `Inter` is not bundled anywhere in this repository, so it named a
 * face the artifact did not contain.
 *
 * ## Reduced motion
 *
 * A card is a static image with no interaction, so there is nothing to animate and nothing to
 * disable: {@link renderShareCard} is one synchronous draw followed by one encode. The renderer takes
 * no `prefers-reduced-motion` input because it has no code path that could respond to one. The dialog
 * that shows the preview is where motion would live, and that surface is CSS.
 *
 * ## Determinism
 *
 * Same model plus same theme gives byte-identical output. There is no randomness, no ambient canvas
 * size, and no iteration over a caller-supplied object's keys: rows come out in the model's own
 * order, which `buildShareCardModel` already fixed to the kind's declared field order.
 */
import {
  buildShareCardModel,
  captionForKind,
  fieldsInModel,
  isEmptyShareCardModel,
  titleForKind,
} from '@/core/share/shareCardModel';
import type {
  ShareCardKind,
  ShareCardModel,
  ShareCardModelInput,
  ShareCardSelection,
} from '@/core/share/types';
import {
  COZY_BORDER_WIDTH_PX,
  COZY_FONT_SIZE_PX,
  COZY_FONT_WEIGHT_NUMBER,
  COZY_SPACE_PX,
  resolveCozyColors,
  type CozyContrastVariant,
  type CozyThemeColors,
  type CozyThemeInput,
} from '@/theme/cozyTokens';
import { canvasFontFamily } from '@/theme/typography';

import {
  visibleShareCardRows,
  visibleShareCardSubjectName,
  type VisibleShareCardRow,
} from './shareCardVisibility';

/**
 * The Cozy palette a card draws with, for one theme name.
 *
 * A distinct type from `CozyThemeColors` on purpose: the renderer must not invent a token. Naming the
 * eight roles it reads - `page`, `panel`, `rule`, `heading`, `label`, `value`, `quiet`, `emphasis` -
 * means a token the card does not declare cannot be reached through this record, and a future edit
 * that wants a new token has to extend this interface deliberately.
 */
interface ShareCardPalette {
  readonly page: string;
  readonly panel: string;
  readonly rule: string;
  readonly heading: string;
  readonly label: string;
  readonly value: string;
  readonly quiet: string;
  readonly emphasis: string;
}

/**
 * The token reads, in one place, so the map cannot grow a literal by accident.
 *
 * `page` is the surface the card sits on, `panel` the raised card surface, `rule` the hairline under
 * the header, `heading` the title and the subject name, `label` the row labels, `value` the row
 * values, `quiet` the caption and the footer, `emphasis` the accent rule and the badge list.
 */
function paletteFor(colors: CozyThemeColors): ShareCardPalette {
  return {
    page: colors.surfacePage,
    panel: colors.surfaceRaised,
    rule: colors.borderControl,
    heading: colors.textPrimary,
    label: colors.textMuted,
    value: colors.textPrimary,
    quiet: colors.textSecondary,
    emphasis: colors.accent,
  };
}

/**
 * The pixel geometry of a card.
 *
 * Numbers rather than tokens, because a card is a fixed-size image and its dimensions are a property
 * of the format rather than of the theme. Colours, type, spacing, and border weights all come from the
 * Cozy tables; these four constants are the picture's shape.
 */
const CARD_WIDTH = 1080;
const CARD_PADDING = 48;
const HEADER_HEIGHT = 176;
const ROW_HEIGHT = 56;
const ROW_LABEL_WIDTH = 420;
const SUBJECT_NAME_HEIGHT = 48;
const FOOTER_HEIGHT = 72;
const VALUE_COLUMN_X = CARD_PADDING + ROW_LABEL_WIDTH;

export interface ShareCardRenderOptions {
  /**
   * The Cozy theme to draw with.
   *
   * A parameter rather than a store read: the renderer holds no store handle at all, which is what
   * lets the dialog - the only component that knows the current theme - pass the value in and lets a
   * test draw the same model twice under two themes. `null` resolves the Cozy default recipe through
   * `resolveCozyColors`, so this is optional without being undefined-behaviour.
   */
  readonly theme?: CozyThemeInput;
  /**
   * The high-contrast overlay, or `'default'`.
   *
   * Passed the same way the theme is, and because a card a learner sends to somebody else should
   * honour the contrast mode they chose for themselves.
   */
  readonly contrast?: CozyContrastVariant;
}

/**
 * A drawn card: the canvas plus the PNG bytes, and nothing else.
 *
 * `blob` is produced through `toBlob`, which is asynchronous, so the two travel together rather than
 * the renderer returning one and a caller re-deriving the other.
 */
export interface RenderedShareCard {
  /** The finished PNG bytes. Nothing has been downloaded or shared. */
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  /**
   * Every string this renderer put on the canvas, in draw order.
   *
   * Returned rather than kept private so a test can assert **what was drawn** without reading pixels
   * - jsdom computes no colours and no layout, so a pixel assertion would be a vacuous gate. It is
   * also the honest description of the canvas.
   */
  readonly drawnText: readonly string[];
}

/** One line of text, in one of the eight declared tones. */
function drawText(
  ctx: CanvasRenderingContext2D,
  palette: ShareCardPalette,
  drawn: string[],
  text: string,
  x: number,
  y: number,
  size: keyof typeof COZY_FONT_SIZE_PX,
  weight: keyof typeof COZY_FONT_WEIGHT_NUMBER,
  tone: keyof ShareCardPalette,
  display = false,
): void {
  /*
   * The **tone** argument is the privacy-relevant part of this signature. A colour argument is a hex
   * string, and a hex string is the exact thing Phase 8 centralised and the pre-Phase-20 exporter got
   * wrong; with a tone, the only way to put a colour on this canvas is to name one of the eight roles
   * `paletteFor` maps to tokens, so a future edit cannot introduce a literal colour by passing one.
   *
   * Recording happens here, in the one function every line of text goes through, rather than at the
   * call sites: an earlier version returned the row values only and documented the field as every
   * string on the canvas, while the title and the subject name were on the canvas and absent from the
   * array. That is a documentation lie a test caught, and it is why the recording is structural.
   */
  ctx.font = `${COZY_FONT_WEIGHT_NUMBER[weight]} ${COZY_FONT_SIZE_PX[size]}px ${canvasFontFamily(
    display ? 'display' : 'body',
  )}`;
  ctx.fillStyle = palette[tone];
  ctx.fillText(text, x, y);
  drawn.push(text);
}

/** Draw one row, returning the y of the next row. */
function drawRow(
  ctx: CanvasRenderingContext2D,
  palette: ShareCardPalette,
  drawn: string[],
  entry: VisibleShareCardRow,
  y: number,
): number {
  const { row, value } = entry;
  drawText(ctx, palette, drawn, row.label, CARD_PADDING, y, 'md', 'regular', 'label');

  switch (row.field) {
    case 'badgeLabels':
      // The only row whose value is a list rather than a number, and the only one that uses the
      // emphasis token: a badge name is what a learner reads a card *for*.
      drawText(ctx, palette, drawn, value, VALUE_COLUMN_X, y, 'md', 'medium', 'emphasis');
      return y + ROW_HEIGHT;
    case 'fishRarityCounts':
    case 'recallAccuracy':
    case 'rank':
      drawText(ctx, palette, drawn, value, VALUE_COLUMN_X, y, 'lg', 'bold', 'value', true);
      return y + ROW_HEIGHT;
    default:
      drawText(ctx, palette, drawn, value, VALUE_COLUMN_X, y, 'lg', 'bold', 'value', true);
      return y + ROW_HEIGHT;
  }
}

/**
 * The pixel height a card needs.
 *
 * Computed from the rows rather than fixed, because a card with nine rows and a card with two rows
 * should not be the same image with one row hidden: an omitted row and a short card are different
 * claims, and the plan's "preview before delivery" requirement means the learner sees the shape they
 * will send.
 */
function heightFor(rowCount: number, hasSubjectName: boolean): number {
  return (
    HEADER_HEIGHT +
    FOOTER_HEIGHT +
    (hasSubjectName ? SUBJECT_NAME_HEIGHT : 0) +
    rowCount * ROW_HEIGHT
  );
}

/**
 * Draw a card and encode it.
 *
 * Every path is total: a model with no rows draws a truthful empty card, a model whose subject name
 * was withheld draws a card without a heading, and a row the kind does not allow is skipped rather
 * than drawn.
 */
export async function renderShareCard(
  model: ShareCardModel,
  options: ShareCardRenderOptions = {},
): Promise<RenderedShareCard> {
  const palette = paletteFor(resolveCozyColors(options.theme ?? null, options.contrast ?? 'default'));

  // The single source of what may be shown: the field-level policy check and the value-level
  // denylist both live in `visibleShareCardRows` / `visibleShareCardSubjectName`, and this module
  // asks rather than deciding. See the header for why there is deliberately no second filter here.
  const rows = visibleShareCardRows(model);
  const subjectName = visibleShareCardSubjectName(model);

  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = heightFor(rows.length, subjectName !== null);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('Unable to create the share-card canvas context.');

  const drawn: string[] = [];

  ctx.fillStyle = palette.page;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Header: the card's own title, then the caption.
  ctx.fillStyle = palette.panel;
  ctx.fillRect(0, 0, canvas.width, HEADER_HEIGHT);
  ctx.fillStyle = palette.emphasis;
  ctx.fillRect(
    0,
    HEADER_HEIGHT - COZY_BORDER_WIDTH_PX.state,
    canvas.width,
    COZY_BORDER_WIDTH_PX.state,
  );

  drawText(
    ctx,
    palette,
    drawn,
    titleForKind(model.kind),
    CARD_PADDING,
    COZY_SPACE_PX['8'] + 32,
    'xxl',
    'bold',
    'heading',
    true,
  );
  drawText(
    ctx,
    palette,
    drawn,
    captionForKind(model.kind),
    CARD_PADDING,
    COZY_SPACE_PX['8'] + 64,
    'md',
    'regular',
    'quiet',
  );

  let y = HEADER_HEIGHT;
  if (subjectName !== null) {
    y += SUBJECT_NAME_HEIGHT;
    drawText(ctx, palette, drawn, subjectName, CARD_PADDING, y - 16, 'xl', 'bold', 'heading', true);
  }

  for (const entry of rows) {
    y = drawRow(ctx, palette, drawn, entry, y);
  }

  /*
   * Footer: a fixed attribution line. No clock, no device name, no host identifier - see the module
   * header on why the pre-Phase-20 `Generated:` line had to go. `palette.rule` is the token this card
   * declares a use for and is the one role `drawText` never reaches; it is used here for a hairline
   * above the footer so the declaration matches the drawing.
   */
  ctx.fillStyle = palette.rule;
  ctx.fillRect(
    CARD_PADDING,
    canvas.height - FOOTER_HEIGHT + COZY_SPACE_PX['4'],
    canvas.width - CARD_PADDING * 2,
    COZY_BORDER_WIDTH_PX.hairline,
  );
  drawText(
    ctx,
    palette,
    drawn,
    'Knowledge Dungeon',
    CARD_PADDING,
    canvas.height - COZY_SPACE_PX['6'],
    'sm',
    'regular',
    'quiet',
  );

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value === null) {
        reject(new Error('Unable to encode the share-card image.'));
        return;
      }
      resolve(value);
    }, 'image/png');
  });

  return { blob, width: canvas.width, height: canvas.height, drawnText: drawn };
}

/** What the caller already has, so the convenience overload needs no extra types at the call site. */
export interface ShareCardRenderInput extends ShareCardModelInput {
  readonly kind: ShareCardKind;
}

/**
 * Build the model and draw it, in one call.
 *
 * The convenience form, and the one the dialog uses. It exists so a caller cannot accidentally build
 * a model from one selection and draw a model from another: the selection is passed once and both
 * halves use it.
 */
export async function renderShareCardFromInput(
  input: ShareCardRenderInput,
  selection?: ShareCardSelection | readonly string[] | null,
  options: ShareCardRenderOptions = {},
): Promise<RenderedShareCard> {
  const model = buildShareCardModel(input, selection as ShareCardSelection | null | undefined);
  return renderShareCard(model, options);
}

/**
 * Whether a model would draw an empty card, and which fields it actually drew.
 *
 * Re-exported from the domain rather than reimplemented, for the reason
 * `shareCardModel.ts` gives: a surface that implemented its own emptiness rule could disagree with the
 * model about what "empty" means, and that module's documentation records that the naive version of
 * the rule is wrong - a card showing only a subject name is not "empty" the way a card with nothing at
 * all is.
 */
export { isEmptyShareCardModel, fieldsInModel };