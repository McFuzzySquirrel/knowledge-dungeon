/**
 * The redesigned Scribe encounter workspace.
 *
 * ## What the workspace is organised around
 *
 * The pre-Phase-15 Scribe view was one modal with seven toolbar toggles (`Edit`,
 * `Preview`, `Help`, `Format`, `Images`, `Checks`, `Collapse`) and everything - the
 * composer, the checklist, the rubric, the confirmation, submit - stacked in that order
 * behind a modal backdrop. Every verb existed. Nothing said what state the encounter was
 * in, a learner who had already written half a note could not tell it from a learner who
 * had not started, the checklist was behind a toggle named `Checks`, and the artifact
 * was a separate room-panel tab that was disabled until it unlocked.
 *
 * This workspace is organised around the questions the phase names - **where does this
 * encounter stand, what do I write, what does the validator say, what did it produce** -
 * and it answers them in that order, each in its own region with a heading a screen-reader
 * user can jump to.
 *
 * ## Why that order, and not another
 *
 * 1. **Arrival first.** "Make incomplete encounters visibly resumable" is the phase's own
 *    scope line, and resumability is a property of *arrival*, not of writing. If the
 *    draft state is below the composer, a learner who returns to a half-written note
 *    reads it as a blank page - and a room whose graph changed needs to be told before
 *    anything else, because that note cannot resume as cleared. The region is also the
 *    only one that is never collapsible: the answer to "where was I" is not optional.
 * 2. **Composer second, open on arrival.** Writing is the phase's job, so it is the
 *    region that starts open and the one the next action points at.
 * 3. **Checks third, open on arrival too.** The composer and the checklist are two halves
 *    of one loop - write, see what changed - and hiding the second half behind a toggle
 *    is what made the pre-Phase-15 `Checks` toggle easy to miss. Both are open; the
 *    screen-reader user can jump past either.
 * 4. **Artifact last, closed on arrival.** Nothing in it can act until the note clears,
 *    and a region whose every control is inert is noise on arrival. It is one toggle
 *    away, and the next action names it once there is something to pick up.
 *
 * ## Four rules this component holds itself to
 *
 * 1. **No dispatch leaves an event handler.** Every encounter command runs from
 *    {@link useScribeEncounterActions}, and every call site of it is an `onClick` or an
 *    `onChange`. The effects here set presentation state: they seed the composer when the
 *    encounter changes room, and move focus when the next action asks. That is what makes
 *    "a valid note clears and rewards a room exactly once" a property of the design rather
 *    than a habit - and it is the *first* of two layers, the second being the durable
 *    (room, valid-clear identity) ledger in `progressionStore.awardRoomClear`.
 * 2. **Validation presentation is the view model's.** {@link ValidationSummary} renders
 *    `scribeViewModel.ts` and restates none of it. The criterion labels, hints, scores,
 *    and bonus sentence were *moved* out of `NoteEditorModal.tsx` into that module; a
 *    second copy here would drift.
 * 3. **Every verb has a DOM route.** Write, preview, format, attach, insert, remove,
 *    confirm, submit, and pick up are buttons, fields, and tabs in this tree. None needs
 *    a canvas, a drag, or a pointer, and every target is at least 44 by 44.
 * 4. **Nothing is written for the learner.** The confirmation checkbox is only ever set
 *    by an `onChange` of that checkbox, and no code path generates note text.
 *
 * ## The rollback
 *
 * `GameScreen` renders this workspace only when `runtimeConfig.scribeEncounterWorkspace`
 * is `true`. With the flag off - the production default - the pre-Phase-15
 * `NoteEditorModal` renders instead, unchanged and still calling `awardRoomClear` without
 * a clear identity, so the two lanes do not share an implementation.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { deriveGraphHierarchy } from '@/core/graph';
import { REQUIRED_NOTE_SECTIONS, evaluateNoteValidation, type RequiredNoteSection } from '@/core/validation/notes';
import type { RoomMetadata, SubjectSnapshot } from '@/core/validation/persistence';
import { useProgressionStore } from '@/store/progressionStore';
import { useSessionStore, type GamePhase } from '@/store/sessionStore';
import { useSubjectStore } from '@/store/subjectStore';
import {
  composeNoteSections,
  emptyNoteSections,
  extractNoteSections,
  type NoteSections,
} from '@/ui/utils/noteSections';

import { StudyActionButton } from '../StudyControls';
import { StudyShell, type StudyRegionSpec } from '../StudyShell';
import { SCRIBE_CONTROL_IDS, focusStudyControl } from '../controlIds';
import { GuideConversation } from '../guide/GuideConversation';
import { ArtifactPreview } from './ArtifactPreview';
import { NoteComposer } from './NoteComposer';
import { ValidationSummary } from './ValidationSummary';
import { buildScribeEncounterViewModel, type ScribeEncounterViewModel } from './scribeViewModel';
import { useScribeEncounterActions } from './useScribeEncounterActions';
import { AssistanceSlot } from '@/ui/assistance/AssistanceSlot';
import './scribe.css';

/**
 * The headings the composer starts from.
 *
 * The pre-Phase-15 modal seeded an untouched note with the three required headings and no
 * body, which is what makes "present but empty" distinguishable from "missing" and stops
 * a full-note replacement from silently deleting a section.
 */
const NOTE_TEMPLATE = composeNoteSections(emptyNoteSections());

function seedSections(room: RoomMetadata | null): NoteSections {
  const noteText = room?.noteText ?? '';
  return extractNoteSections(noteText.length > 0 ? noteText : NOTE_TEMPLATE);
}

/** The regions, in the order {@link ScribeEncounter} argues for in its header. */
type ScribeRegionId = 'arrival' | 'composer' | 'checks' | 'artifact';

/**
 * Which region holds each focusable control a next action can target.
 *
 * Opening the region before the focus lands is what stops a next action from focusing a
 * `hidden` element, which the browser drops silently and which a keyboard user reads as a
 * button that does nothing.
 */
const CONTROL_REGION: Readonly<Record<string, ScribeRegionId>> = Object.freeze({
  [SCRIBE_CONTROL_IDS.artifactCollect]: 'artifact',
  [SCRIBE_CONTROL_IDS.confirmation]: 'composer',
  [SCRIBE_CONTROL_IDS.noteEditor]: 'composer',
  [SCRIBE_CONTROL_IDS.submit]: 'composer',
});

/**
 * Regions that start open.
 *
 * `arrival` is listed even though it is not collapsible, because `expanded` is also what
 * the shell reads before deciding whether the body is hidden - and a region reported as
 * collapsed while rendering open is the kind of small lie that makes a later refactor
 * introduce a real one.
 */
const OPEN_BY_DEFAULT: readonly ScribeRegionId[] = ['arrival', 'composer', 'checks'];

/** The lead step, and the control that performs it. */
interface ScribeNextAction {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly controlId: string;
}

/**
 * The recommended step, derived from the view model.
 *
 * Ordered by what actually blocks progress: an artifact waiting to be picked up outranks
 * writing, a complete and confirmed note outranks an unconfirmed one.
 *
 * There is deliberately no "finish the missing sections" step, and the reason is worth
 * stating because it looks like an omission. `composeNoteSections` always writes the three
 * required headings, so a note built through this composer can never be *missing* a
 * section - `evaluateNoteValidation` reports every heading present - and
 * `scribeResumeState.missingSectionCount` is therefore zero for anything this composer
 * produces. The real gate is the learner's own confirmation, which is what the last branch
 * names. A step the UI cannot reach is a step that will lie the moment the domain changes.
 */
function resolveNextAction(model: ScribeEncounterViewModel): ScribeNextAction | null {
  if (model.roomId === null) return null;
  if (model.artifact.canCollect) {
    return {
      id: 'collect-artifact',
      label: 'Pick up the artifact',
      detail:
        'This encounter is cleared and the room has written an artifact that is not in your journal yet.',
      controlId: SCRIBE_CONTROL_IDS.artifactCollect,
    };
  }
  if (model.stage === 'cleared') {
    return {
      id: 'cleared',
      label: 'This encounter is already cleared',
      detail:
        'Its artifact is already in your journal, so there is nothing left to collect here.',
      controlId: SCRIBE_CONTROL_IDS.arrival,
    };
  }
  if (model.canClear) {
    return {
      id: 'defeat-encounter',
      label: 'Defeat this encounter',
      detail:
        'Every required section is present and the note is confirmed, so submitting defeats the encounter and writes the artifact.',
      controlId: SCRIBE_CONTROL_IDS.submit,
    };
  }
  return {
    id: 'confirm-note',
    label: 'Confirm these notes are your own',
    detail:
      'The note has its required sections. Ticking the confirmation box is what lets it defeat the encounter.',
    controlId: SCRIBE_CONTROL_IDS.confirmation,
  };
}

export interface ScribeEncounterProps {
  /** The room being written, or `null` when the encounter has no room. */
  readonly room: RoomMetadata | null;
  readonly snapshot: SubjectSnapshot;
  readonly phase: GamePhase;
  /** Journal note ids already collected on this device. */
  readonly collectedNoteIds: readonly string[];
  readonly pendingInsert: string | null;
  readonly onConsumePendingInsert: () => void;
  readonly resolveLocalImage: (attachmentId: string) => string | null;
  readonly onClose: () => void;
}

export function ScribeEncounter({
  room,
  snapshot,
  phase,
  collectedNoteIds,
  pendingInsert,
  onConsumePendingInsert,
  resolveLocalImage,
  onClose,
}: ScribeEncounterProps): ReactNode {
  const actions = useScribeEncounterActions();
  const roomId = room?.roomId ?? null;

  const [sections, setSections] = useState<NoteSections>(() => seedSections(room));
  const [activeSection, setActiveSection] = useState<RequiredNoteSection>(
    REQUIRED_NOTE_SECTIONS[0],
  );
  const [manualConfirmed, setManualConfirmed] = useState<boolean>(
    () => room?.validationState.manualConfirmed ?? false,
  );
  const [hasEdited, setHasEdited] = useState(false);
  const [regionOverrides, setRegionOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [focusProblem, setFocusProblem] = useState<string | null>(null);

  /*
   * Seed the composer when the encounter changes room, and only then.
   *
   * A ref rather than a `roomId` dependency, because `room` is a new object on every
   * store commit: reseeding on identity would throw away what the learner has typed the
   * moment their own submit landed. The ref is presentation bookkeeping and dispatches
   * nothing; the guard also makes the second pass of a StrictMode double-invoke a no-op.
   */
  const seededRoomId = useRef<string | null>(null);
  useEffect(() => {
    if (seededRoomId.current === roomId) return;
    seededRoomId.current = roomId;
    setSections(seedSections(room));
    setActiveSection(REQUIRED_NOTE_SECTIONS[0]);
    setManualConfirmed(room?.validationState.manualConfirmed ?? false);
    setHasEdited(false);
  }, [room]);

  /*
   * Another surface asked to append text to the note - the signpost insertion path.
   *
   * This lives here, in the same component as the seed effect above and declared
   * after it, and that placement is load-bearing. It used to live in `NoteComposer`,
   * where it was inverted: React runs a child's effects before its parent's, so the
   * composer appended the text on mount and the seed effect immediately overwrote
   * `sections` from `room.noteText` - silently discarding the insertion while
   * draining its one-shot token, so the text could never arrive. `NoteEditorModal`
   * does not have this problem because both effects are in one component, declared in
   * seed-then-insert order.
   *
   * Both happen in the same effect pass, synchronously, so the token is drained in the
   * same commit that applies it and the text cannot be appended twice.
   */
  useEffect(() => {
    if (pendingInsert === null) return;
    setSections((current) => ({
      ...current,
      [activeSection]: `${current[activeSection].trimEnd()}\n${pendingInsert}`.trim(),
    }));
    setHasEdited(true);
    onConsumePendingInsert();
  }, [activeSection, onConsumePendingInsert, pendingInsert]);

  const onSectionChange = useCallback((section: RequiredNoteSection, value: string): void => {
    setSections((current) => ({ ...current, [section]: value }));
  }, []);
  const onActiveSectionChange = useCallback((section: RequiredNoteSection): void => {
    setActiveSection(section);
  }, []);
  const onManualConfirmedChange = useCallback((confirmed: boolean): void => {
    setManualConfirmed(confirmed);
    setHasEdited(true);
  }, []);
  const onEdited = useCallback((): void => {
    setHasEdited(true);
  }, []);

  const noteText = useMemo(() => composeNoteSections(sections), [sections]);

  /*
   * The live validation of what the composer holds. This is the *only* evaluation in the
   * workspace: `submitNote` runs the same function again when the learner submits, and
   * the command reports which branch ran, so nothing here has to decide anything.
   */
  const validation = useMemo(
    () =>
      room === null
        ? null
        : evaluateNoteValidation({ noteText, manualConfirmed, roomTopic: room.topic }),
    [noteText, manualConfirmed, room],
  );

  const model = useMemo(
    () =>
      buildScribeEncounterViewModel({
        room,
        validation,
        snapshot,
        collectedNoteIds,
        hasEdited,
      }),
    [collectedNoteIds, hasEdited, room, snapshot, validation],
  );

  const hierarchy = useMemo(() => deriveGraphHierarchy(snapshot.dungeon), [snapshot.dungeon]);
  const breadcrumb = useMemo(() => {
    if (roomId === null) return [];
    return (hierarchy.breadcrumbRoomIdsByRoomId[roomId] ?? []).map(
      (id) => snapshot.rooms[id]?.topic ?? '',
    );
  }, [hierarchy, roomId, snapshot.rooms]);
  const floor =
    roomId === null
      ? snapshot.dungeon.subjectName
      : (hierarchy.floorLabelByFloorId[hierarchy.floorIdByRoomId[roomId]] ??
        snapshot.dungeon.subjectName);

  const isExpanded = useCallback(
    (regionId: ScribeRegionId): boolean =>
      regionOverrides[regionId] ?? OPEN_BY_DEFAULT.includes(regionId),
    [regionOverrides],
  );
  const toggleRegion = useCallback(
    (regionId: ScribeRegionId): void => {
      setRegionOverrides((current) => ({ ...current, [regionId]: !isExpanded(regionId) }));
    },
    [isExpanded],
  );

  /** Send focus to a control, opening its region first. */
  const requestFocus = useCallback((controlId: string): void => {
    const regionId = CONTROL_REGION[controlId];
    if (regionId !== undefined) {
      setRegionOverrides((current) => ({ ...current, [regionId]: true }));
    }
    setFocusProblem(null);
    setFocusRequest((current) => ({ id: controlId, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  useEffect(() => {
    if (focusRequest === null) return;
    const moved = focusStudyControl(focusRequest.id);
    setFocusProblem(
      moved
        ? null
        : 'That step needs a control that is not on screen. Open the region that holds it and try again.',
    );
  }, [focusRequest]);

  const nextAction = resolveNextAction(model);

  const regionContent: Readonly<Record<ScribeRegionId, ReactNode>> = {
    arrival: (
      <div id={SCRIBE_CONTROL_IDS.arrival} tabIndex={-1} className="scribe-arrival">
        <p className="scribe-arrival__headline" data-study-arrival-stage={model.stage}>
          {model.resume.headline}
        </p>
        <ul className="scribe-arrival__facts">
          <li>{`Required sections still missing: ${model.resume.missingSectionCount}`}</li>
          <li>{`Words in this note: ${model.wordCount}`}</li>
          <li>{`Images attached to this room: ${model.attachmentCount}`}</li>
        </ul>
      </div>
    ),
    composer: (
      <NoteComposer
        room={room}
        sections={sections}
        activeSection={activeSection}
        manualConfirmed={manualConfirmed}
        noteText={noteText}
        canClear={model.canClear}
        onSectionChange={onSectionChange}
        onActiveSectionChange={onActiveSectionChange}
        onManualConfirmedChange={onManualConfirmedChange}
        onEdited={onEdited}
        resolveLocalImage={resolveLocalImage}
        actions={actions}
      />
    ),
    checks: <ValidationSummary model={model} />,
    artifact: (
      <ArtifactPreview
        model={model}
        artifactMarkdown={room?.artifactMarkdown ?? null}
        resolveLocalImage={resolveLocalImage}
        actions={actions}
      />
    ),
  };

  const regionMeta: Readonly<
    Record<ScribeRegionId, { title: string; description: string; collapsible: boolean }>
  > = {
    arrival: {
      title: 'Where this encounter stands',
      description: 'What is already here, so a half-written note can be picked up rather than lost.',
      collapsible: false,
    },
    composer: {
      title: 'Write the note',
      description: 'One required section at a time. Your words, your confirmation, your decision to submit.',
      collapsible: true,
    },
    checks: {
      title: 'Checks and quality',
      description: 'What the validator reports about the note as it stands, in its own words.',
      collapsible: true,
    },
    artifact: {
      title: 'Artifact',
      description: 'What defeating this encounter wrote, and picking it up into the journal.',
      collapsible: true,
    },
  };

  const regions: StudyRegionSpec[] = (
    ['arrival', 'composer', 'checks', 'artifact'] as const
  ).map((regionId) => {
    const meta = regionMeta[regionId];
    return {
      id: regionId,
      title: meta.title,
      description: meta.description,
      expanded: isExpanded(regionId),
      // No `onToggle` for the arrival region: the shell renders no toggle without a
      // handler, which is exactly right - a control that opens nothing cannot exist.
      onToggle: meta.collapsible ? () => toggleRegion(regionId) : undefined,
      children: regionContent[regionId],
    };
  });

  return (
    <StudyShell
      phase="scribe"
      subjectName={snapshot.dungeon.subjectName}
      context={{
        topic: model.topic,
        status: model.resume.status ?? 'Unknown',
        floor,
        breadcrumb,
      }}
      regions={regions}
      nextAction={
        nextAction === null
          ? null
          : {
              id: nextAction.id,
              label: nextAction.label,
              detail: nextAction.detail,
              action: (
                <StudyActionButton
                  label={`Go to: ${nextAction.label}`}
                  tone="primary"
                  touchTarget={`next-action-${nextAction.id}`}
                  onClick={() => requestFocus(nextAction.controlId)}
                />
              ),
            }
      }
      feedback={actions.feedback}
      label="Scribe encounter workspace"
    >
      {/*
        Phase 19: the Scribe suggestion card.

        Note the shell's own rule, recorded at this file's focus fallback: "The shell owns exactly
        one `role="status"`, and adding another here would make a learner hear two announcements
        for one action." The card's live region is **not** a second channel for an *action* - it
        announces only that the number of visible suggestions changed, and it does not announce on
        first render - but the concern is real, and it is the reason the announcement is
        deliberate rather than incidental. See `AssistanceCard`'s `AnnouncementRegion`.

        First child, so it sits after the encounter's own next action and never above it.
      */}
      <AssistanceSlot surface="scribe" snapshot={snapshot} />
      {/*
        The focus fallback is visible text and *not* a second live region. The shell owns
        exactly one `role="status"`, and adding another here would make a learner hear two
        announcements for one action - which is the defect plan 10.1 is about.
      */}
      {focusProblem === null ? null : (
        <p className="scribe-hint scribe-hint--problem">{focusProblem}</p>
      )}
      <GuideConversation
        phase={phase}
        room={
          room === null
            ? null
            : {
                topic: room.topic,
                state: room.state,
                isCleared: room.validationState.finalPass,
              }
        }
      />
      <div className="scribe-encounter__close">
        <StudyActionButton
          id={SCRIBE_CONTROL_IDS.close}
          label="Close this encounter"
          touchTarget="encounter-close"
          onClick={onClose}
        />
      </div>
    </StudyShell>
  );
}

/**
 * Focusable descendants, for the dialog's focus trap.
 *
 * `tabindex="-1"` is excluded deliberately: the dialog's own frame is programmatically
 * focusable and must not appear in its own Tab ring.
 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The encounter overlay: the pre-Phase-15 mount point, holding the redesigned workspace.
 *
 * ## Why it is a dialog
 *
 * The learner's route to Scribe is unchanged - interact with a room in the dungeon, or
 * press <kbd>E</kbd>, and `studyFlowController.roomInteract` opens the note editor for
 * that room. Preserving that route means preserving its shape: a dialog with a close
 * control, Escape to leave, focus that does not wander behind the scrim, and focus that
 * returns to wherever it came from on close.
 *
 * The workspace inside is not a modal in the old sense: it does not trap a learner who
 * wants to read the room panel beside it, and its own regions are ordinary sections.
 *
 * ## What this component owns that the workspace does not
 *
 * Only the things that are about the *mount* rather than the encounter: which room is
 * open, whether the overlay is showing at all, the device-local image object URLs, and
 * the focus lifecycle. Every mutation the learner can perform is inside the workspace,
 * and every mutation goes through {@link useScribeEncounterActions}.
 *
 * This component reads its own state from the stores rather than taking props, because it
 * is the direct replacement for `NoteEditorModal` in `GameScreen` and taking props would
 * put a dozen store selectors into a screen that has no reason to know about any of them.
 */
export function ScribeEncounterDialog(): ReactNode {
  const isOpen = useSessionStore((s) => s.isNoteEditorOpen);
  const roomId = useSessionStore((s) => s.noteEditorRoomId);
  const pendingInsert = useSessionStore((s) => s.noteEditorPendingInsert);
  const clearPendingInsert = useSessionStore((s) => s.clearNoteEditorPendingInsert);
  const closeNoteEditor = useSessionStore((s) => s.closeNoteEditor);
  const phase = useSessionStore((s) => s.phase);
  const snapshot = useSubjectStore((s) => s.snapshot);
  const resolveAttachmentUrl = useSubjectStore((s) => s.resolveAttachmentUrl);
  const collectedNotes = useProgressionStore((s) => s.collectedNotes);

  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});
  const frameRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  const room = roomId === null ? null : (snapshot?.rooms[roomId] ?? null);

  /*
   * The journal's note ids, derived from the store's stable array.
   *
   * Not `.map(...)` inside a selector: a selector that returns a fresh array on every call
   * never compares equal to itself, so the store would notify on every read and this
   * component would re-render forever.
   */
  const collectedNoteIds = useMemo(
    () => collectedNotes.map((entry) => entry.noteId),
    [collectedNotes],
  );

  /*
   * Device-local image previews.
   *
   * Presentation only: it reads bytes this device already holds and turns them into
   * object URLs. There is no request of any kind, which is what `tests/privacy/
   * uploadBoundary.test.ts` checks statically across `src/`. Object URLs are revoked when
   * this effect re-runs and when the overlay unmounts, so opening the image library
   * repeatedly does not accumulate blobs.
   */
  useEffect(() => {
    if (room === null) {
      setAttachmentUrls({});
      return;
    }

    let cancelled = false;
    const created: string[] = [];
    const revokeAll = (): void => {
      for (const url of created.splice(0)) URL.revokeObjectURL(url);
    };

    const localAttachments = room.attachments.filter(
      (attachment) => attachment.sourceType === 'local',
    );
    if (localAttachments.length === 0) {
      setAttachmentUrls({});
      return () => {
        cancelled = true;
        revokeAll();
      };
    }

    void Promise.all(
      localAttachments.map(async (attachment) => {
        const resolved = await resolveAttachmentUrl(room.roomId, attachment.attachmentId);
        if (resolved !== null && resolved.startsWith('blob:')) created.push(resolved);
        return [attachment.attachmentId, resolved] as const;
      }),
    ).then((results) => {
      if (cancelled) {
        revokeAll();
        return;
      }
      setAttachmentUrls(
        Object.fromEntries(
          results.filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
        ),
      );
    });

    return () => {
      cancelled = true;
      revokeAll();
    };
  }, [resolveAttachmentUrl, room]);

  /* Focus in on open, focus back where it came from on close. Both are DOM, not store. */
  useEffect(() => {
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    frameRef.current?.focus();
    return () => {
      restoreFocusTo.current?.focus();
      restoreFocusTo.current = null;
    };
  }, []);

  /*
   * Nothing to open. The pre-Phase-15 modal returned `null` in exactly these three cases,
   * and a dialog over a room that is not there is the one shape of this surface that has
   * nothing to say - so the parity is kept rather than replaced with an empty frame.
   */
  if (!isOpen || snapshot === null || room === null) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeNoteEditor();
      return;
    }
    if (event.key !== 'Tab') return;
    const frame = frameRef.current;
    if (frame === null) return;
    const focusable = [...frame.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey) {
      if (document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      return;
    }
    if (document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-backdrop">
      <div
        ref={frameRef}
        id={SCRIBE_CONTROL_IDS.dialog}
        className="modal scribe-encounter-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Scribe encounter"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <ScribeEncounter
          room={room}
          snapshot={snapshot}
          phase={phase}
          collectedNoteIds={collectedNoteIds}
          pendingInsert={pendingInsert}
          onConsumePendingInsert={clearPendingInsert}
          resolveLocalImage={(attachmentId) => attachmentUrls[attachmentId] ?? null}
          onClose={closeNoteEditor}
        />
      </div>
    </div>
  );
}