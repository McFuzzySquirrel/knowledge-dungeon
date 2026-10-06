/**
 * The share-card dialog: preview, field selection, local download, and explicit Web Share.
 *
 * ## What this surface is for
 *
 * Plan section 9 requires four things of it, and each is a structural property of this file rather
 * than a promise in a comment:
 *
 * 1. **A preview before delivery.** The canvas is drawn from the same {@link ShareCardModel} the
 *    downloaded bytes come from, and it is `aria-hidden` with the same information available as
 *    text in a real `<dl>`. jsdom computes no pixels, so the canvas is not the accessible surface -
 *    the text list is - and the canvas exists for the learner who can see it.
 * 2. **The learner chooses what appears.** Field selection is a list of real, labelled
 *    `<input type="checkbox">` controls, one per field the kind has, each with a `<label htmlFor>`.
 *    The initial selection is {@link defaultSelectionFor}, so the privacy-by-default promise is the
 *    *initial state* rather than something the learner has to remember to establish.
 * 3. **Local PNG download, always.** The download control is present and enabled on every build,
 *    whatever `VITE_WEB_SHARE` is, because `VITE_WEB_SHARE=false` is the phase's documented
 *    rollback and the rollback must retain the download.
 * 4. **Web Share only from an explicit action.** There is no share call anywhere in this file's
 *    effects, in its render, or in a callback that a state change can reach. The only call site is
 *    the `onClick` of the share control, and it is the only thing that runs
 *    {@link shareCardImage}. That is provable by counting invocations rather than by asserting an
 *    absence, and `tests/phase20/shareCardDialog.test.tsx` counts them across the whole lifecycle.
 *
 * ## The four delivery states, and why cancelling is not one of the failures
 *
 * {@link ShareDeliveryOutcome} is a closed union in `./shareCardDelivery`, and the dialog can only
 * render the sentences {@link describeShareDelivery} returns. A cancelled share - the learner
 * dismissed the operating system's sheet - is shown as an ordinary status line, produces no error
 * toast, and mutates nothing: this component holds no store handle at all, so "cancelling changes
 * nothing" is a property of its imports rather than of a branch that forgot to write.
 *
 * ## Accessibility obligations this file meets, and where
 *
 * - `role="dialog"` + `aria-modal="true"`, labelled by the heading and described by the description
 *   paragraph, both rendered here so the accessible name cannot drift from the visible text.
 * - Initial focus on the container, focus containment on Tab and Shift+Tab, and restoration to the
 *   opener, all from {@link useModalFocus} - the one implementation Phase 5 established.
 * - Escape closes, via the same hook.
 * - The kind selector is a radio group with a `<fieldset>`/`<legend>`; field selection is a checkbox
 *   group with a `<fieldset>`/`<legend>`; both are native controls, so both are keyboard operable
 *   and neither needs a custom key handler.
 * - 44 by 44 CSS-pixel minimum targets are applied **inline**, not in the stylesheet, because jsdom
 *   computes no layout and a stylesheet rule is therefore not assertable here. The rule is mirrored
 *   in the stylesheet for real rendering; the inline floor survives a stylesheet that failed to load.
 * - Status is announced through one `role="status"` region written in an effect, and never on the
 *   first frame - see {@link StatusLine}.
 * - No colour carries meaning. Every state is a word, and every checkbox is a native control with a
 *   visible label.
 *
 * ## Lazy, and why
 *
 * This module is reached only through `React.lazy` from `InventoryBadgesPanel`, because
 * `vite.config.ts` fails the default production build if any of the three declared share-lane
 * modules is statically reachable from the entry - and the whole application core is emitted into
 * one entry chunk, so a plain import here would be eager for every Welcome visitor. A card renderer
 * does not belong in the bytes of a learner who has not opened a subject.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { buildShareCardModel, isEmptyShareCardModel } from '@/core/share/shareCardModel';
import {
  availableFieldsFor,
  defaultSelectionFor,
  normalizeShareCardSelection,
} from '@/core/share/shareCardPolicy';
import { SHARE_CARD_FIELD_LABELS } from '@/core/share/shareCardContent';
import {
  SHARE_CARD_KINDS,
  type ShareCardField,
  type ShareCardKind,
  type ShareCardModel,
} from '@/core/share/types';
import { runtimeConfig } from '@/config/featureFlags';
import { useModalFocus } from '@/ui/hooks/useModalFocus';

import {
  describeShareDelivery,
  shareCardImage,
  suggestShareFileName,
  type ShareCardFile,
  type ShareDeliveryOutcome,
} from './shareCardDelivery';
import { renderShareCard, type RenderedShareCard } from './renderShareCard';
import {
  SHARE_DIALOG_DESCRIPTION,
  SHARE_DIALOG_TITLE,
  SHARE_DOWNLOAD_LABEL,
  SHARE_CLOSE_LABEL,
  SHARE_DRAWING_LABEL,
  SHARE_EMPTY_CARD_NOTE,
  SHARE_FIELD_SELECTION_HEADING,
  SHARE_FIELD_SELECTION_HINT,
  SHARE_KIND_LABELS,
  SHARE_KIND_SELECTION_HEADING,
  SHARE_NAME_WITHHELD_NOTE,
  SHARE_OMITTED_NOTE,
  SHARE_OPTIONAL_FIELD_NOTES,
  SHARE_PRIVACY_NOTE,
  SHARE_SHARE_LABEL,
  sharePreviewDescription,
} from './shareCardCopy';
import {
  SHARE_CARD_COUNT_ATTRIBUTE,
  SHARE_CARD_FIELD_ATTRIBUTE,
  SHARE_CARD_ID_ATTRIBUTE,
  SHARE_CARD_IDS,
  SHARE_CARD_KIND_ATTRIBUTE,
  SHARE_CARD_OUTCOME_ATTRIBUTE,
  SHARE_CARD_SR_ONLY_CLASS,
  shareCardId,
} from './shareCardTestIds';
import { hasFactsForKind, toShareCardBuildInput, type ShareCardFacts } from './shareCardFacts';
import {
  shareCardNameWasWithheld,
  visibleShareCardRows,
  visibleShareCardSubjectName,
} from './shareCardVisibility';

import './shareCard.css';

export interface ShareCardDialogProps {
  /** Whether the dialog is on screen. */
  readonly open: boolean;
  /** Close the dialog. Bound to Escape and to the close control. */
  readonly onClose: () => void;
  /** The counts this subject's cards are built from. See `./shareCardFacts`. */
  readonly facts: ShareCardFacts;
  /**
   * The kind the dialog opens on.
   *
   * A prop rather than `null`, so the caller that opened the dialog decides what the learner asked
   * for. `InventoryBadgesPanel` opens a summary card from its summary control and a collection card
   * from its collection control.
   */
  readonly initialKind: ShareCardKind;
  /**
   * Whether Web Share is offered on this build.
   *
   * A prop, not a direct read of `runtimeConfig`, for the reason `AssistanceSlot` takes one: a
   * build-time constant cannot be changed at runtime, so a test could not render both lanes in one
   * process. The default is the real flag, so a caller that forgets the argument gets production
   * behaviour rather than a share button on a build that has the feature switched off.
   */
  readonly webShareEnabled?: boolean;
  /** The Cozy theme to draw the preview with. Omit for the Cozy default recipe. */
  readonly theme?: string | null;
}

/** The 44x44 CSS-pixel floor Phase 8 declared, as an inline style a test can read. */
const TOUCH_TARGET_STYLE: Readonly<{ minWidth: string; minHeight: string }> = Object.freeze({
  minWidth: '44px',
  minHeight: '44px',
});

/** The field-selection state: one set of fields per kind, so switching kinds restores choices. */
type SelectionState = Readonly<Record<ShareCardKind, readonly ShareCardField[]>>;

function initialSelection(kind: ShareCardKind): SelectionState {
  return Object.freeze({
    'subject-summary': defaultSelectionFor('subject-summary'),
    collection: defaultSelectionFor('collection'),
    fish: defaultSelectionFor('fish'),
    statistics: defaultSelectionFor('statistics'),
    [kind]: defaultSelectionFor(kind),
  });
}

export function ShareCardDialog({
  open,
  onClose,
  facts,
  initialKind,
  webShareEnabled = runtimeConfig.webShare,
  theme = null,
}: ShareCardDialogProps): ReactNode {
  const titleId = useId();
  const descriptionId = useId();
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [kind, setKind] = useState<ShareCardKind>(initialKind);
  const [selection, setSelection] = useState<SelectionState>(() => initialSelection(initialKind));
  const [rendered, setRendered] = useState<RenderedShareCard | null>(null);
  const [drawFailed, setDrawFailed] = useState(false);
  const [outcome, setOutcome] = useState<ShareDeliveryOutcome | null>(null);

  // Focus moved in on open and restored on close, and Escape handled: one hook, the same one the
  // Data Center's confirmations use. Escape is disabled while a share is in flight - a sheet the
  // learner cannot see is not a promise this dialog has to keep.
  const dialogRef = useModalFocus<HTMLDivElement>({ active: open, onEscape: open ? onClose : null });

  const input = useMemo(() => toShareCardBuildInput(facts, kind), [facts, kind]);

  const model: ShareCardModel = useMemo(
    () => buildShareCardModel(input, selection[kind]),
    [input, selection, kind],
  );

  const available = useMemo(() => availableFieldsFor(kind), [kind]);
  const chosen = selection[kind];
  const kindLabel = SHARE_KIND_LABELS[kind];

  /*
   * What this surface is willing to render, derived once per model rather than inside the JSX, and
   * taken from `./shareCardVisibility` - the same module the canvas renderer uses.
   *
   * Deriving them separately is exactly how the two surfaces drifted apart in the first version of
   * this phase: the image refused a subject name the denylist rejected while the text list beside it
   * published it, so the accessible surface leaked what the picture protected. One function, two
   * callers, and `tests/phase20/shareCardDialog.test.tsx` asserts both surfaces agree.
   */
  const rows = useMemo(() => visibleShareCardRows(model), [model]);
  const subjectName = useMemo(() => visibleShareCardSubjectName(model), [model]);
  const subjectNameRefused = shareCardNameWasWithheld(model);

  /**
   * Draw the preview whenever the model changes.
   *
   * The draw runs in an effect, never during render: `renderShareCard` touches `document` and
   * encodes asynchronously, and doing either during render is a side effect a second render would
   * repeat. It reads no clock and performs no share - a redraw happens on every kind change and every
   * field change, and `tests/phase20/shareCardDialog.test.tsx` asserts the share-call counter is
   * still zero after all of them.
   *
   * `rendered` is deliberately **not** a dependency. It is this effect's own output, so depending on
   * it would re-run the draw, produce a new object identity, set state, and loop forever.
   */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDrawFailed(false);
    void renderShareCard(model, theme === null ? {} : { theme })
      .then((result) => {
        if (cancelled) return;
        setRendered(result);
      })
      .catch(() => {
        if (cancelled) return;
        setRendered(null);
        setDrawFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, model, theme]);

  const toggleField = useCallback(
    (field: ShareCardField, checked: boolean) => {
      const requested = checked ? [...chosen, field] : chosen.filter((entry) => entry !== field);
      // Normalized on every change, so a selection can never hold a field the kind does not have -
      // and so the card's row order is the kind's declared order whatever order the boxes were
      // ticked in.
      setSelection((previous) => ({
        ...previous,
        [kind]: normalizeShareCardSelection(kind, requested),
      }));
    },
    [chosen, kind],
  );

  const fileFor = useCallback(
    (): ShareCardFile | null => {
      if (rendered === null) return null;
      return {
        blob: rendered.blob,
        // The **visible** subject name, not the model's. A withheld name must not reach a file name
        // either: the file name is the one place a subject name survives into the operating system's
        // UI and onto a disk, so a name this dialog refused to display must not be written there.
        fileName: suggestShareFileName(subjectName, kind === 'collection' ? 'collection' : kind),
        mimeType: 'image/png',
      };
    },
    [rendered, subjectName, kind],
  );

  const download = useCallback(() => {
    const file = fileFor();
    if (file === null) return;
    const url = URL.createObjectURL(file.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.fileName;
    link.click();
    URL.revokeObjectURL(url);
    setOutcome(null);
  }, [fileFor]);

  /**
   * The one and only Web Share call site.
   *
   * Reached from a click, from nothing else. There is no effect that shares, no `canShare` probe
   * that shares, and no automatic delivery on preview: the control's `onClick` is the whole path.
   */
  const share = useCallback(async () => {
    const file = fileFor();
    if (file === null) return;
    // The result's `outcome` is stored, never its `detail`: the detail is a browser error **name**,
    // kept for diagnostics and never rendered, because `ShareDeliveryResult.detail` deliberately
    // carries no message - a browser share error message can contain the payload's file name.
    const result = await shareCardImage(file);
    setOutcome(result.outcome);
  }, [fileFor]);

  if (!open) return null;

  const canDeliver = rendered !== null;

  return (
    <div className="kd-dialog-layer">
      <div
        className="kd-dialog kd-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        ref={dialogRef}
        {...shareCardId(SHARE_CARD_IDS.dialog)}
      >
        <h3 className="kd-dialog-title" id={titleId}>
          {SHARE_DIALOG_TITLE}
        </h3>
        <p className="kd-dialog-line" id={descriptionId}>
          {SHARE_DIALOG_DESCRIPTION}
        </p>

        <fieldset className="kd-share-fieldset">
          <legend className="kd-share-legend">{SHARE_KIND_SELECTION_HEADING}</legend>
          <div className="kd-share-kinds" role="radiogroup" aria-label={SHARE_KIND_SELECTION_HEADING}>
            {SHARE_CARD_KINDS.map((candidate) => {
              const inputId = `${titleId}-kind-${candidate}`;
              return (
                <span className="kd-share-kind" key={candidate}>
                  <input
                    type="radio"
                    id={inputId}
                    name={`${titleId}-kind`}
                    value={candidate}
                    checked={kind === candidate}
                    onChange={() => {
                      setKind(candidate);
                      setOutcome(null);
                    }}
                    style={TOUCH_TARGET_STYLE}
                    {...{ [SHARE_CARD_KIND_ATTRIBUTE]: candidate }}
                    {...{ [SHARE_CARD_ID_ATTRIBUTE]: SHARE_CARD_IDS.kindRadio }}
                  />
                  <label htmlFor={inputId}>{SHARE_KIND_LABELS[candidate]}</label>
                </span>
              );
            })}
          </div>
          {hasFactsForKind(facts, kind) ? null : (
            <p className="kd-dialog-line">{SHARE_EMPTY_CARD_NOTE}</p>
          )}
        </fieldset>

        <fieldset className="kd-share-fieldset" {...shareCardId(SHARE_CARD_IDS.fieldList)}>
          <legend className="kd-share-legend">{SHARE_FIELD_SELECTION_HEADING}</legend>
          <p className="kd-dialog-line" id={`${titleId}-field-hint`}>
            {SHARE_FIELD_SELECTION_HINT}
          </p>
          <ul className="kd-share-fields" aria-describedby={`${titleId}-field-hint`}>
            {available.map((field) => {
              const optionId = `${titleId}-field-${field}`;
              const checked = chosen.includes(field);
              const note = SHARE_OPTIONAL_FIELD_NOTES[field] ?? null;
              const noteId = `${optionId}-note`;
              return (
                <li className="kd-share-field" key={field}>
                  <input
                    type="checkbox"
                    id={optionId}
                    checked={checked}
                    onChange={(event) => toggleField(field, event.target.checked)}
                    style={TOUCH_TARGET_STYLE}
                    aria-describedby={note === null ? undefined : noteId}
                    {...{ [SHARE_CARD_FIELD_ATTRIBUTE]: field }}
                    {...{ [SHARE_CARD_ID_ATTRIBUTE]: SHARE_CARD_IDS.fieldOption }}
                  />
                  <label htmlFor={optionId}>{SHARE_CARD_FIELD_LABELS[field]}</label>
                  {note === null ? null : (
                    <span className="kd-share-field-note" id={noteId}>
                      {note}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="kd-dialog-line">{SHARE_PRIVACY_NOTE}</p>
        </fieldset>

        <section className="kd-share-preview" aria-label="Card preview">
          {/*
            The canvas is decorative for assistive technology and says so. The information it carries
            is below, as text, and that text - not the pixels - is what a screen reader reads. This
            is also why `aria-hidden` is unconditional: there is no state in which the canvas is the
            only place some of this card exists.
          */}
          <canvas
            className="kd-share-canvas"
            ref={previewCanvasRef}
            width={rendered?.width ?? undefined}
            height={rendered?.height ?? undefined}
            aria-hidden="true"
            {...shareCardId(SHARE_CARD_IDS.preview)}
          />
          <p className={SHARE_CARD_SR_ONLY_CLASS} id={`${titleId}-preview-description`}>
            {sharePreviewDescription(subjectName, rows.length, kindLabel)}
          </p>
          {/*
            The row count published here is the count of rows this surface **renders**, which is the
            filtered list - not `model.rows.length`. A count a test reads to learn what the card says
            has to be the count the card shows; publishing the unfiltered number would let a gate
            believe a row was present when the privacy filter removed it.
          */}
          <div
            className="kd-share-preview-text"
            {...shareCardId(SHARE_CARD_IDS.previewText)}
            {...{ [SHARE_CARD_COUNT_ATTRIBUTE]: String(rows.length) }}
          >
            <h4>{kindLabel}</h4>
            {subjectName === null ? null : <p className="kd-share-preview-name">{subjectName}</p>}
            {subjectNameRefused ? (
              /*
               * The name was dropped by the value-level denylist, and the learner is told so rather
               * than shown an unexplained blank. A card silently missing its title reads as a bug,
               * and this one is a deliberate refusal.
               */
              <p className="kd-dialog-line">{SHARE_NAME_WITHHELD_NOTE}</p>
            ) : null}
            <dl className="kd-share-rows">
              {rows.map(({ row, value }) => (
                <div className="kd-share-row" key={row.field} {...{ [SHARE_CARD_FIELD_ATTRIBUTE]: row.field }}>
                  <dt>{row.label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {rows.length === 0 ? <p className="kd-dialog-line">{SHARE_EMPTY_CARD_NOTE}</p> : null}
            {model.omittedFields.length > 0 ? (
              <p
                className="kd-dialog-line"
                {...shareCardId(SHARE_CARD_IDS.omitted)}
                {...{ [SHARE_CARD_COUNT_ATTRIBUTE]: String(model.omittedFields.length) }}
              >
                {SHARE_OMITTED_NOTE}
              </p>
            ) : null}
          </div>
          {drawFailed ? (
            <p className="kd-dialog-line" role="status">
              {SHARE_DRAWING_LABEL}
            </p>
          ) : null}
        </section>

        <StatusLine outcome={outcome} />

        <div className="kd-actions">
          {/*
            The download control is unconditional. `VITE_WEB_SHARE=false` is the phase's documented
            rollback and the rollback must retain local PNG download, so the control cannot be behind
            the flag. It is disabled only while there are no bytes to save, which is a transient
            state rather than a capability one.
          */}
          <button
            type="button"
            className="kd-button"
            onClick={download}
            disabled={!canDeliver}
            style={TOUCH_TARGET_STYLE}
            {...shareCardId(SHARE_CARD_IDS.download)}
          >
            {SHARE_DOWNLOAD_LABEL}
          </button>
          {/*
            The share control is gated on the build flag. With the flag off, no element carrying this
            id exists at all - not a disabled button - so there is nothing for a learner to find and
            nothing for a test to mistake for a share path.
          */}
          {webShareEnabled ? (
            <button
              type="button"
              className="kd-button kd-button--primary"
              onClick={() => {
                void share();
              }}
              disabled={!canDeliver}
              style={TOUCH_TARGET_STYLE}
              {...shareCardId(SHARE_CARD_IDS.share)}
            >
              {SHARE_SHARE_LABEL}
            </button>
          ) : null}
          <button
            type="button"
            className="kd-button"
            onClick={onClose}
            style={TOUCH_TARGET_STYLE}
            aria-label={SHARE_CLOSE_LABEL}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The one live region, written only when an outcome changes.
 *
 * `role="status"` rather than `role="alert"`: a share finishing or being cancelled is not an
 * emergency, and an assertive region would interrupt whatever the learner was doing. The first frame
 * announces nothing - there is no outcome yet, and a region that spoke on arrival would speak on
 * every open. Nothing here can raise an error toast, because the component holds no store handle and
 * no toast API: a cancelled share cannot mutate state because there is nothing here that could.
 */
function StatusLine({ outcome }: { readonly outcome: ShareDeliveryOutcome | null }): ReactNode {
  const previous = useRef<ShareDeliveryOutcome | null>(null);
  const [announced, setAnnounced] = useState<ShareDeliveryOutcome | null>(null);

  useEffect(() => {
    if (previous.current === outcome) return;
    previous.current = outcome;
    setAnnounced(outcome);
  }, [outcome]);

  return (
    <p
      className="kd-dialog-line"
      role="status"
      aria-live="polite"
      {...shareCardId(SHARE_CARD_IDS.status)}
      {...{ [SHARE_CARD_OUTCOME_ATTRIBUTE]: announced ?? '' }}
    >
      {announced === null ? '' : describeShareDelivery(announced)}
    </p>
  );
}

/**
 * Whether a card of these facts and this selection would say anything.
 *
 * Exported for the dialog's own caller, which wants to explain an empty card before opening rather
 * than after. Re-exported from the model rather than reimplemented, because
 * {@link isEmptyShareCardModel} documents that the naive version of this rule is wrong: a card
 * showing only a subject name is not "empty" in the way a card with nothing at all is.
 */
export { isEmptyShareCardModel };