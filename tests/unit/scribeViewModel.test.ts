/**
 * Phase 15 - the renderer-neutral Scribe view model.
 *
 * `src/ui/study/scribe/scribeViewModel.ts` is the contract the UI engineer
 * consumes, so this file pins the parts a surface binds to and the parts that
 * must stay total:
 *
 * - the three required sections' present/missing state;
 * - criterion rows carrying the *moved* labels and improvement hints, and the
 *   rubric's score presentation and quality-bonus line;
 * - resumability, including what a learner who already has a draft sees on
 *   arrival, and what they see after a graph change invalidated the note;
 * - artifact existence and journal collection.
 *
 * The three degenerate room shapes are covered explicitly: no room at all, a room
 * with a note but no artifact, and a room whose artifact exists but has never
 * been collected.
 *
 * The "no duplication" claim is pinned too: `NoteEditorModal` no longer declares
 * the criterion wording, so there is exactly one home for it.
 *
 * Privacy: every string here is synthetic.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { evaluateNoteValidation } from '@/core/validation/notes';
import {
  REQUIRED_NOTE_SECTIONS,
  type NoteValidationOutput,
} from '@/core/validation/notes';
import {
  makeEmptyRoomMetadata,
  makeEmptyValidationState,
  type RoomAttachment,
  type RoomMetadata,
  type SubjectSnapshot,
} from '@/core/validation/persistence';
import {
  buildScribeEncounterViewModel,
  scribeCheckRows,
  scribeCriterionHint,
  scribeCriterionLabel,
  scribeQualityBonusLine,
  scribeScoreDisplay,
  type ScribeEncounterInput,
} from '@/ui/study/scribe/scribeViewModel';

const SUBJECT_ID = 'subject-scribe';
const ROOM_ID = 'room-vector-space';
const FIXED_NOW = '2026-04-04T04:04:04.000Z';

const DRAFT_NOTE = 'Summary\nhalf a thought';
const COMPLETE_NOTE = [
  'Summary',
  'A synthetic summary about vector spaces and their bases.',
  '',
  'Key Points',
  '- Vectors are added componentwise.',
  '',
  'Recall Question',
  'What is a synthetic basis?',
  '',
  'See also [[room-matrices]].',
].join('\n');

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeRoom(overrides: Partial<RoomMetadata> = {}): RoomMetadata {
  return {
    ...makeEmptyRoomMetadata({ roomId: ROOM_ID, topic: 'Vector Space', nowIso: FIXED_NOW }),
    ...overrides,
  };
}

function makeSnapshot(room: RoomMetadata | null, status: RoomMetadata['state'] = 'Visited'): SubjectSnapshot | null {
  if (room === null) return null;
  return {
    dungeon: {
      schemaVersion: '1.1.0',
      dungeonId: SUBJECT_ID,
      subjectName: 'Synthetic Scribe Subject',
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      phaseState: 'ScribeActive',
      rootRoomId: ROOM_ID,
      rooms: [{ roomId: ROOM_ID, topic: room.topic, status }],
      edges: [],
      progression: { xpTotal: 0, rank: 'Novice', badges: [], fishCollection: [] },
    },
    rooms: { [ROOM_ID]: room },
  };
}

function validate(noteText: string, manualConfirmed: boolean): NoteValidationOutput {
  return evaluateNoteValidation({ noteText, manualConfirmed, roomTopic: 'Vector Space' });
}

function input(overrides: Partial<ScribeEncounterInput> = {}): ScribeEncounterInput {
  return {
    room: null,
    validation: null,
    snapshot: null,
    collectedNoteIds: [],
    ...overrides,
  };
}

function attachment(attachmentId: string): RoomAttachment {
  return {
    attachmentId,
    sourceType: 'local',
    fileName: 'synthetic-image.png',
    mimeType: 'image/png',
    altText: 'synthetic image',
    addedAt: FIXED_NOW,
  };
}

// ── Sections ────────────────────────────────────────────────────────────────

describe('scribeViewModel - sections', () => {
  it('reports every required section as missing for an untouched room', () => {
    const model = buildScribeEncounterViewModel(input({ room: makeRoom() }));

    expect(model.sections.map((section) => section.section)).toEqual([...REQUIRED_NOTE_SECTIONS]);
    expect(model.sections.every((section) => section.missing)).toBe(true);
    expect(model.sections.every((section) => !section.present)).toBe(true);
    expect(model.sections[0]?.missingCount).toBe(REQUIRED_NOTE_SECTIONS.length);
  });

  it('reports the sections the validator found', () => {
    const model = buildScribeEncounterViewModel(
      input({ room: makeRoom(), validation: validate(DRAFT_NOTE, false) }),
    );

    const summary = model.sections.find((section) => section.section === 'Summary');
    expect(summary?.present).toBe(true);
    expect(summary?.missing).toBe(false);
    const recall = model.sections.find((section) => section.section === 'Recall Question');
    expect(recall?.missing).toBe(true);
    expect(model.sections.every((section) => section.missingCount === 2)).toBe(true);
  });

  it('reports no missing sections for a complete note', () => {
    const model = buildScribeEncounterViewModel(
      input({ room: makeRoom(), validation: validate(COMPLETE_NOTE, true) }),
    );

    expect(model.sections.every((section) => section.present && !section.missing)).toBe(true);
    expect(model.canClear).toBe(true);
  });
});

// ── Criterion rows and the moved wording ────────────────────────────────────

describe('scribeViewModel - rubric', () => {
  it('labels every criterion and gives an improvement hint below a full score', () => {
    const model = buildScribeEncounterViewModel(
      input({ room: makeRoom(), validation: validate(DRAFT_NOTE, false) }),
    );

    expect(model.rubric.rows.map((row) => row.criterion)).toEqual([
      'sectionCompleteness',
      'conceptTermCoverage',
      'linkReferences',
      'recallQuestionQuality',
      'clarityReadability',
    ]);
    for (const row of model.rubric.rows) {
      expect(row.label).toBe(scribeCriterionLabel(row.criterion));
      expect(row.maxScore).toBe(2);
      expect(row.displayScore).toBe(`${row.score}/2`);
      expect(row.tone).toBe(row.score >= 2 ? 'full' : row.score >= 1 ? 'partial' : 'none');
      // Every rubric row carries the validator's own rationale, verbatim.
      expect(row.rationale.length).toBeGreaterThan(0);
      expect(row.hint === null).toBe(row.score >= 2);
    }
  });

  it('keeps the hint wording it moved from the note editor', () => {
    expect(scribeCriterionHint('sectionCompleteness', 1)).toBe(
      'Include Summary, Key Points, and Recall Question headings.',
    );
    expect(scribeCriterionHint('conceptTermCoverage', 0)).toBe(
      'Use key terms from the room topic throughout your note.',
    );
    expect(scribeCriterionHint('linkReferences', 0)).toBe('Add 2+ links or "see also" references.');
    expect(scribeCriterionHint('linkReferences', 1)).toBe('Add one more link or reference.');
    expect(scribeCriterionHint('recallQuestionQuality', 1)).toBe(
      'Write 2+ questions in the Recall Question section.',
    );
    expect(scribeCriterionHint('clarityReadability', 1)).toBe(
      'Aim for 8-24 words per sentence and at least 2 paragraphs.',
    );
    expect(scribeCriterionHint('linkReferences', 2)).toBe('');
  });

  it('keeps the label and score wording it moved from the note editor', () => {
    expect(scribeCriterionLabel('sectionCompleteness')).toBe('Required sections');
    expect(scribeCriterionLabel('conceptTermCoverage')).toBe('Topic terms covered');
    expect(scribeCriterionLabel('linkReferences')).toBe('Links & references');
    expect(scribeCriterionLabel('recallQuestionQuality')).toBe('Recall questions');
    expect(scribeCriterionLabel('clarityReadability')).toBe('Readability');
    expect(scribeScoreDisplay(0)).toBe('0/2');
    expect(scribeScoreDisplay(1)).toBe('1/2');
    expect(scribeScoreDisplay(2)).toBe('2/2');
    expect(scribeQualityBonusLine(7)).toBe('Quality bonus: 7/10 · Each criterion scored 0–2');
  });

  it('presents the quality bonus line with the validator score', () => {
    const validation = validate(COMPLETE_NOTE, true);
    const model = buildScribeEncounterViewModel(input({ room: makeRoom(), validation }));

    expect(model.rubric.qualityBonus).toBe(validation.qualityBonus);
    expect(model.rubric.maxQualityBonus).toBe(10);
    expect(model.rubric.qualityBonusLine).toBe(
      `Quality bonus: ${validation.qualityBonus}/10 · Each criterion scored 0–2`,
    );
  });

  it('is defined with no validation at all', () => {
    const model = buildScribeEncounterViewModel(input({ room: makeRoom() }));

    expect(model.rubric).toEqual({
      rows: [],
      qualityBonus: 0,
      maxQualityBonus: 10,
      qualityBonusLine: scribeQualityBonusLine(0),
    });
    expect(model.wordCount).toBe(0);
    expect(model.canClear).toBe(false);
  });

  it('declares the criterion wording in exactly one module', () => {
    const modalSource = readFileSync(
      resolve(process.cwd(), 'src/ui/components/NoteEditorModal.tsx'),
      'utf8',
    );

    // The modal used to declare `CRITERION_LABELS` and `getCriterionHint`. It
    // calls the view model's helpers now, so the wording has one home.
    expect(modalSource).not.toContain('CRITERION_LABELS');
    expect(modalSource).not.toContain('getCriterionHint');
    expect(modalSource).toContain('scribeCriterionHint');
    expect(modalSource).toContain('scribeCriterionLabel');
  });
});

// ── Checks ──────────────────────────────────────────────────────────────────

describe('scribeViewModel - checks', () => {
  it('marks the word-count check as non-blocking and the rest as blocking', () => {
    const rows = scribeCheckRows({ validation: validate(DRAFT_NOTE, false), neutral: false });

    const wordCount = rows.find((row) => row.code === 'VAL_WORD_COUNT_BONUS_TARGET');
    expect(wordCount?.blocking).toBe(false);
    expect(wordCount?.display).toBe('○');
    expect(rows.filter((row) => row.blocking)).toHaveLength(2);
  });

  it('shows requirements rather than failures for an untouched draft', () => {
    const rows = scribeCheckRows({ validation: validate(DRAFT_NOTE, false), neutral: true });

    expect(rows.every((row) => row.passed)).toBe(true);
    expect(rows.every((row) => row.display === '•')).toBe(true);
    expect(rows.find((row) => row.code === 'VAL_REQUIRED_SECTION_MISSING')?.message).toBe(
      'Keep headings: Summary, Key Points, Recall Question.',
    );
    expect(rows.find((row) => row.code === 'VAL_MANUAL_CONFIRM_REQUIRED')?.message).toBe(
      'Tick confirmation when your draft is ready to submit.',
    );
  });

  it('is empty with no validation', () => {
    expect(scribeCheckRows({ validation: null, neutral: false })).toEqual([]);
  });
});

// ── Resumability ────────────────────────────────────────────────────────────

describe('scribeViewModel - resumability', () => {
  it('reports an untouched room as not started and not resumable', () => {
    const room = makeRoom();
    const model = buildScribeEncounterViewModel(
      input({ room, snapshot: makeSnapshot(room), validation: validate('', false) }),
    );

    expect(model.stage).toBe('not-started');
    expect(model.resume.canResume).toBe(false);
    expect(model.resume.resumable).toBe(false);
    expect(model.resume.missingSectionCount).toBe(0);
  });

  it('tells a learner who already has a draft that they can pick up where they left off', () => {
    const room = makeRoom({ noteText: DRAFT_NOTE, state: 'NotesDrafted' });
    const model = buildScribeEncounterViewModel(
      input({ room, snapshot: makeSnapshot(room, 'NotesDrafted'), validation: validate(DRAFT_NOTE, false) }),
    );

    expect(model.stage).toBe('draft');
    expect(model.resume.canResume).toBe(true);
    expect(model.resume.resumable).toBe(true);
    expect(model.resume.headline).toBe('You have a draft here. Pick up where you left off.');
    expect(model.resume.missingSectionCount).toBe(2);
    expect(model.resume.wordCount).toBeGreaterThan(0);
    expect(model.resume.status).toBe('NotesDrafted');
  });

  it('reports a room whose note a graph change invalidated as needing a rewrite', () => {
    // The room's own record still says it cleared; the dungeon's summary says the
    // graph invalidated it, and the summary is the authority.
    const room = makeRoom({
      noteText: COMPLETE_NOTE,
      state: 'ArtifactCollected',
      artifactMarkdown: '# Artifact',
      validationState: { ...makeEmptyValidationState(), finalPass: true },
    });
    const model = buildScribeEncounterViewModel(
      input({
        room,
        snapshot: makeSnapshot(room, 'NeedsRevalidation'),
        validation: validate(COMPLETE_NOTE, true),
      }),
    );

    expect(model.stage).toBe('needs-revalidation');
    expect(model.resume.canResume).toBe(true);
    expect(model.resume.resumable).toBe(true);
    expect(model.resume.status).toBe('NeedsRevalidation');
    expect(model.resume.headline).toContain('needs to be rewritten');
  });

  it('reports a cleared room as already cleared and not resumable', () => {
    const room = makeRoom({
      noteText: COMPLETE_NOTE,
      state: 'ArtifactCollected',
      artifactMarkdown: '# Artifact',
      validationState: { ...makeEmptyValidationState(), finalPass: true },
    });
    const model = buildScribeEncounterViewModel(
      input({
        room,
        snapshot: makeSnapshot(room, 'ArtifactCollected'),
        validation: validate(COMPLETE_NOTE, true),
      }),
    );

    expect(model.stage).toBe('cleared');
    expect(model.resume.resumable).toBe(false);
    expect(model.resume.canResume).toBe(true);
  });

  it('falls back to the room record when no snapshot is available', () => {
    const room = makeRoom({ state: 'NotesDrafted', noteText: DRAFT_NOTE });
    const model = buildScribeEncounterViewModel(input({ room }));

    expect(model.resume.status).toBe('NotesDrafted');
    expect(model.stage).toBe('draft');
  });
});

// ── Artifact ────────────────────────────────────────────────────────────────

describe('scribeViewModel - artifact state', () => {
  it('reports no artifact for a room that has not cleared', () => {
    const room = makeRoom();
    const model = buildScribeEncounterViewModel(
      input({ room, snapshot: makeSnapshot(room), validation: validate(DRAFT_NOTE, false) }),
    );

    expect(model.artifact).toEqual({
      state: 'none',
      exists: false,
      collected: false,
      canCollect: false,
      noteId: null,
    });
  });

  it('reports an uncollected artifact as awaiting pickup, with the pickup offered', () => {
    const room = makeRoom({
      noteText: COMPLETE_NOTE,
      state: 'ArtifactCollected',
      artifactMarkdown: '# Artifact',
      validationState: { ...makeEmptyValidationState(), finalPass: true },
    });
    const model = buildScribeEncounterViewModel(
      input({ room, snapshot: makeSnapshot(room, 'ArtifactCollected'), validation: validate(COMPLETE_NOTE, true) }),
    );

    expect(model.artifact.state).toBe('awaiting-pickup');
    expect(model.artifact.exists).toBe(true);
    expect(model.artifact.collected).toBe(false);
    expect(model.artifact.canCollect).toBe(true);
    // Generation and pickup are separate actions, so the offer is exactly the
    // uncollected-with-artifact case.
    expect(model.artifact.noteId).toBeNull();
  });

  it('reports a collected artifact with the journal note id it was collected under', () => {
    const room = makeRoom({
      noteText: COMPLETE_NOTE,
      state: 'ArtifactCollected',
      artifactMarkdown: '# Artifact',
      validationState: { ...makeEmptyValidationState(), finalPass: true },
    });
    const model = buildScribeEncounterViewModel(
      input({
        room,
        snapshot: makeSnapshot(room, 'ArtifactCollected'),
        collectedNoteIds: [`${SUBJECT_ID}:${ROOM_ID}`],
      }),
    );

    expect(model.artifact.state).toBe('collected');
    expect(model.artifact.collected).toBe(true);
    expect(model.artifact.canCollect).toBe(false);
    expect(model.artifact.noteId).toBe(`${SUBJECT_ID}:${ROOM_ID}`);
  });

  it('does not treat another room\'s collected note as this room\'s', () => {
    const room = makeRoom({ artifactMarkdown: '# Artifact' });
    const model = buildScribeEncounterViewModel(
      input({
        room,
        snapshot: makeSnapshot(room),
        collectedNoteIds: [`${SUBJECT_ID}:room-other`],
      }),
    );

    expect(model.artifact.collected).toBe(false);
    expect(model.artifact.state).toBe('awaiting-pickup');
  });

  it('does not report an empty artifact string as an artifact', () => {
    const room = makeRoom({ artifactMarkdown: '' });
    const model = buildScribeEncounterViewModel(input({ room, snapshot: makeSnapshot(room) }));

    expect(model.artifact.exists).toBe(false);
  });
});

// ── The three degenerate room shapes ────────────────────────────────────────

describe('scribeViewModel - degenerate rooms', () => {
  it('is total for a room that is not there', () => {
    const model = buildScribeEncounterViewModel(input());

    expect(model.roomId).toBeNull();
    expect(model.topic).toBe('');
    expect(model.stage).toBe('unavailable');
    expect(model.resume.status).toBeNull();
    expect(model.sections).toHaveLength(REQUIRED_NOTE_SECTIONS.length);
    expect(model.checks).toEqual([]);
    expect(model.rubric.rows).toEqual([]);
    expect(model.artifact.state).toBe('none');
    expect(model.artifact.canCollect).toBe(false);
    expect(model.wordCount).toBe(0);
    expect(model.canClear).toBe(false);
    expect(model.attachmentCount).toBe(0);
  });

  it('is total for a room with a note but no artifact', () => {
    const room = makeRoom({ noteText: DRAFT_NOTE, state: 'NotesDrafted' });
    const model = buildScribeEncounterViewModel(
      input({ room, snapshot: makeSnapshot(room, 'NotesDrafted'), validation: validate(DRAFT_NOTE, false) }),
    );

    expect(model.stage).toBe('draft');
    expect(model.artifact.state).toBe('none');
    expect(model.artifact.exists).toBe(false);
    expect(model.canClear).toBe(false);
    expect(model.wordCount).toBeGreaterThan(0);
  });

  it('is total for a room whose artifact exists but has never been collected', () => {
    const room = makeRoom({
      noteText: COMPLETE_NOTE,
      state: 'ArtifactCollected',
      artifactMarkdown: '# Artifact',
      validationState: { ...makeEmptyValidationState(), finalPass: true },
    });
    const model = buildScribeEncounterViewModel(
      input({ room, snapshot: makeSnapshot(room, 'ArtifactCollected') }),
    );

    expect(model.stage).toBe('cleared');
    expect(model.artifact.state).toBe('awaiting-pickup');
    expect(model.artifact.canCollect).toBe(true);
    expect(model.attachmentCount).toBe(0);
  });

  it('counts the room images for a surface that shows them', () => {
    const room = makeRoom({ attachments: [attachment('attachment-0001'), attachment('attachment-0002')] });
    const model = buildScribeEncounterViewModel(input({ room }));

    expect(model.attachmentCount).toBe(2);
  });

  it('reports an edited-but-unsaved encounter as resumable with no text yet', () => {
    const room = makeRoom();
    const model = buildScribeEncounterViewModel(
      input({ room, snapshot: makeSnapshot(room), hasEdited: true }),
    );

    expect(model.stage).toBe('draft');
    expect(model.resume.canResume).toBe(false);
    expect(model.resume.resumable).toBe(true);
    expect(model.resume.headline).toBe('Start writing this note to begin the encounter.');
  });
});