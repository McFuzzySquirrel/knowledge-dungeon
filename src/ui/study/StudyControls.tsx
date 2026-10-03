/**
 * The controls every study surface uses: a button that explains its own refusal, a
 * labelled field, and a choice list.
 *
 * ## Why the refusal is text next to the button, not `aria-describedby`
 *
 * Plan section 10.1 and the Phase 13 dungeon surface both record the same trap: a
 * `disabled` button is **not focusable**, so a reason carried only in
 * `aria-describedby` is reachable exactly when it does not matter and unreachable
 * exactly when it does. A learner who cannot act on a control and cannot Tab to it to
 * find out why is left with a dead button and no sentence.
 *
 * So {@link StudyActionButton} renders the reason as a sibling paragraph in the normal
 * flow. It repeats the reason into `aria-describedby` as well, because a screen-reader
 * user who is already on the control should hear it without hunting - but the sentence
 * is on the page first, and the button's own accessible name always carries the verb.
 */
import { useId, type CSSProperties, type ReactNode } from 'react';

/**
 * The minimum touch target, applied inline.
 *
 * Inline rather than in the stylesheet for the reason `tests/phase12/village-panels.test.tsx`
 * gives: jsdom has no layout, so a rule in a stylesheet cannot be asserted - only
 * computed. An inline `minWidth`/`minHeight` is part of the rendered style attribute, so
 * the 44-pixel floor is a property of the element a test can read, and it survives a
 * stylesheet that failed to load.
 */
export const STUDY_TOUCH_TARGET_STYLE: CSSProperties = Object.freeze({
  minWidth: '44px',
  minHeight: '44px',
});

/** The attribute every study control writes, so a test can enumerate them. */
export const STUDY_TOUCH_TARGET_ATTRIBUTE = 'data-study-touch-target';

export type StudyActionTone = 'default' | 'primary' | 'danger';

export interface StudyActionButtonProps {
  /** The verb, in the learner's words: "Add child topics", not "children-add". */
  readonly label: string;
  readonly onClick: () => void;
  /**
   * Why this control cannot act right now, in one sentence.
   *
   * Supplying it disables the control **and** renders the sentence. There is no way to
   * pass a reason without disabling, or to disable without a reason: the reason is the
   * parameter that does both, which is what stops a future edit from producing one
   * without the other.
   */
  readonly refusal?: string | null;
  /**
   * A sentence that explains the control without disabling it.
   *
   * Separate from {@link refusal} on purpose: "this moves the box on screen only" is a
   * description, while "select a topic first" is a bar. Conflating them would either
   * disable a control that can act or hide a description a learner needs.
   */
  readonly description?: string | null;
  /** `true` while this control's command is in flight. */
  readonly pending?: boolean;
  readonly pendingLabel?: string;
  readonly tone?: StudyActionTone;
  /** Which control this is, for the touch-target attribute. Static vocabulary. */
  readonly touchTarget: string;
  readonly className?: string;
  /** Set for a control inside a `<form>` that submits it. */
  readonly type?: 'button' | 'submit';
  /**
   * A stable DOM id, for a workspace whose "next action" moves focus here.
   *
   * A pass-through and nothing more: `focusStudyControl` looks the control up by id, and
   * the ids are static vocabulary in `controlIds.ts`. Omit it where nothing needs to find
   * the control, and a generated id is not created - an unused id is still an id that ends
   * up in a test selector.
   */
  readonly id?: string;
}

export function StudyActionButton({
  label,
  onClick,
  refusal = null,
  description = null,
  pending = false,
  pendingLabel,
  tone = 'default',
  touchTarget,
  className,
  type = 'button',
  id,
}: StudyActionButtonProps): ReactNode {
  const reasonId = useId();
  const blocked = refusal !== null || pending;
  const visibleLabel = pending && pendingLabel !== undefined ? pendingLabel : label;
  const note = refusal ?? description;

  return (
    <span className="study-action">
      <button
        type={type}
        id={id}
        className={`study-action__button study-action__button--${tone}${className == null ? '' : ` ${className}`}`}
        disabled={blocked}
        aria-describedby={note === null ? undefined : reasonId}
        {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: touchTarget }}
        style={STUDY_TOUCH_TARGET_STYLE}
        onClick={onClick}
      >
        {visibleLabel}
      </button>
      {/*
        The note. Present in the flow, not hidden behind a class, and not announced twice:
        the live status region in the shell carries a refusal again after the command
        resolves, which is the moment a second announcement is useful.
      */}
      {note === null ? null : (
        <span className={`study-action__note${refusal === null ? '' : ' study-action__note--refusal'}`} id={reasonId}>
          {note}
        </span>
      )}
    </span>
  );
}

export interface StudyFieldProps {
  readonly label: string;
  /** A hint under the label, or nothing. */
  readonly hint?: string;
  /**
   * A stable id for the control.
   *
   * Supplied when something else has to find this control later - a "Next: add child
   * topics" action that moves focus to the box it recommends, for instance. Omit it and
   * one is generated.
   */
  readonly id?: string;
  readonly children: (ids: { inputId: string; describedBy: string | undefined }) => ReactNode;
  readonly className?: string;
}

/**
 * A labelled control group.
 *
 * The label is a real `<label htmlFor>`-style association implemented by the caller
 * passing the ids in, because a field may be a textarea, an input, or a select and the
 * three do not share a props shape.
 */
export function StudyField({ label, hint, id, children, className }: StudyFieldProps): ReactNode {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = useId();
  return (
    <div className={`study-field${className == null ? '' : ` ${className}`}`}>
      <label className="study-field__label" htmlFor={inputId}>
        {label}
      </label>
      {hint == null ? null : (
        <p className="study-field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {children({ inputId, describedBy: hint == null ? undefined : hintId })}
    </div>
  );
}

export interface StudyChoiceProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Every option, in the order the workspace decided. */
  readonly options: readonly { readonly value: string; readonly label: string }[];
  /** The empty option's text, when there is one. */
  readonly placeholder?: string;
  readonly hint?: string;
  readonly touchTarget: string;
  readonly disabled?: boolean;
  readonly id?: string;
}

/**
 * A `<select>` with an explicit placeholder option.
 *
 * A select rather than a datalist: the candidate list for a reparent or a cross-link is
 * filtered by the graph (no descendants, no self, no existing edge), and a learner
 * choosing from a filtered list has to be able to see the filter's result. A datalist
 * shows no such list on most browsers.
 */
export function StudyChoice({
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
  touchTarget,
  disabled = false,
  id,
}: StudyChoiceProps): ReactNode {
  return (
    <StudyField label={label} hint={hint} id={id}>
      {({ inputId, describedBy }) => (
        <select
          id={inputId}
          className="study-choice"
          value={value}
          disabled={disabled}
          aria-describedby={describedBy}
          {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: touchTarget }}
          style={STUDY_TOUCH_TARGET_STYLE}
          onChange={(event) => onChange(event.target.value)}
        >
          {placeholder == null ? null : <option value="">{placeholder}</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </StudyField>
  );
}

export interface StudyTextInputProps {
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  /** Submit on Enter, for a single-line field. */
  readonly onSubmit?: () => void;
  readonly touchTarget: string;
  readonly inputMode?: 'text';
  readonly describedBy?: string;
  readonly id?: string;
}

export function StudyTextInput({
  label,
  hint,
  value,
  onChange,
  placeholder,
  onSubmit,
  touchTarget,
  inputMode,
  describedBy,
  id,
}: StudyTextInputProps): ReactNode {
  return (
    <StudyField label={label} hint={hint} id={id}>
      {({ inputId, describedBy: hintId }) => (
        <input
          id={inputId}
          type="text"
          className="study-input"
          value={value}
          placeholder={placeholder}
          inputMode={inputMode}
          aria-describedby={[hintId, describedBy].filter(Boolean).join(' ') || undefined}
          {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: touchTarget }}
          style={STUDY_TOUCH_TARGET_STYLE}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || onSubmit === undefined) return;
            event.preventDefault();
            onSubmit();
          }}
        />
      )}
    </StudyField>
  );
}

export interface StudyTextareaProps {
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly touchTarget: string;
  readonly rows?: number;
  readonly describedBy?: string;
  readonly id?: string;
}

/**
 * The multi-line field, as its own component.
 *
 * `StudyTextInput` takes `rows` and branches on it, which is the kind of polymorphism that
 * makes a control's props unreadable at the call site; the two fields are separate
 * exports instead.
 */
export function StudyTextarea({
  label,
  hint,
  value,
  onChange,
  placeholder,
  touchTarget,
  rows = 4,
  describedBy,
  id,
}: StudyTextareaProps): ReactNode {
  return (
    <StudyField label={label} hint={hint} id={id}>
      {({ inputId, describedBy: hintId }) => (
        <textarea
          id={inputId}
          className="study-textarea"
          rows={rows}
          value={value}
          placeholder={placeholder}
          aria-describedby={[hintId, describedBy].filter(Boolean).join(' ') || undefined}
          {...{ [STUDY_TOUCH_TARGET_ATTRIBUTE]: touchTarget }}
          style={STUDY_TOUCH_TARGET_STYLE}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </StudyField>
  );
}
