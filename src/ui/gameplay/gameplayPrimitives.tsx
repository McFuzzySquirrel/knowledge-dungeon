/**
 * Shared presentation primitives for the world-first gameplay shell (variant B).
 *
 * This is a presentation layer only: buttons, sheets, chips, and the quest card.
 * It owns no state and dispatches only through caller-provided handlers.
 */
import type { ReactNode } from 'react';

import './gameplayShell.css';

export interface GameplayButtonProps {
  readonly label: string;
  readonly ariaLabel?: string;
  readonly glyph?: string;
  readonly onClick: () => void;
  readonly primary?: boolean;
  readonly iconOnly?: boolean;
  readonly disabled?: boolean;
}

export function GameplayButton({
  label,
  ariaLabel,
  glyph,
  onClick,
  primary = false,
  iconOnly = false,
  disabled = false,
}: GameplayButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={`gameplay-btn${primary ? ' gameplay-btn--primary' : ''}${iconOnly ? ' gameplay-btn--icon' : ''}`}
      aria-label={ariaLabel ?? label}
      title={ariaLabel ?? label}
      disabled={disabled}
      onPointerDown={(event) => event.currentTarget.focus()}
      onClick={(event) => {
        event.currentTarget.focus();
        onClick();
      }}
    >
      {glyph === undefined ? null : <span aria-hidden="true">{glyph}</span>}
      {iconOnly ? null : <span className="gameplay-btn__text">{label}</span>}
    </button>
  );
}

export function GameplayRailButton({
  label,
  ariaLabel,
  glyph,
  onClick,
}: {
  readonly label: string;
  readonly ariaLabel?: string;
  readonly glyph: string;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className="gameplay-rail-btn"
      aria-label={ariaLabel ?? label}
      title={ariaLabel ?? label}
      onPointerDown={(event) => event.currentTarget.focus()}
      onClick={(event) => {
        event.currentTarget.focus();
        onClick();
      }}
    >
      <span className="gameplay-rail-btn__glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="gameplay-rail-btn__label">{label}</span>
    </button>
  );
}

export function GameplayChip({
  children,
  accent = false,
  title,
}: {
  readonly children: ReactNode;
  readonly accent?: boolean;
  readonly title?: string;
}): ReactNode {
  return (
    <span className={`gameplay-chip${accent ? ' gameplay-chip--accent' : ''}`} title={title}>
      {children}
    </span>
  );
}

export function GameplaySubjectChips({
  subjectName,
  roomTopic,
  phase,
  xpLabel,
}: {
  readonly subjectName: string;
  readonly roomTopic: string;
  readonly phase: string;
  readonly xpLabel: string;
}): ReactNode {
  return (
    <div className="gameplay-chips">
      <GameplayChip title={subjectName}>{subjectName}</GameplayChip>
      <GameplayChip>{roomTopic}</GameplayChip>
      <GameplayChip accent>{phase}</GameplayChip>
      <GameplayChip>{xpLabel}</GameplayChip>
    </div>
  );
}

export function GameplayQuestCard({
  eyebrow,
  title,
  body,
  meta,
  action,
}: {
  readonly eyebrow: ReactNode;
  readonly title: string;
  readonly body: string;
  readonly meta?: string;
  readonly action?: ReactNode;
}): ReactNode {
  return (
    <section className="gameplay-quest" aria-label="Current objective">
      <div className="gameplay-quest__eyebrow">
        {eyebrow}
        <span>{title}</span>
      </div>
      <p className="gameplay-quest__objective">{body}</p>
      {meta === undefined ? null : <div className="gameplay-quest__meta">{meta}</div>}
      {action === undefined ? null : <div className="gameplay-quest__action">{action}</div>}
    </section>
  );
}

export function GameplaySheet({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <section className="gameplay-sheet" aria-label={title}>
      <header className="gameplay-sheet__header">
        <h2>{title}</h2>
        <button
          type="button"
          className="gameplay-sheet__close"
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <div className="gameplay-sheet__body">{children}</div>
    </section>
  );
}

export function GameplayRail({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <aside className="gameplay-rail" aria-label={label}>
      {children}
    </aside>
  );
}
