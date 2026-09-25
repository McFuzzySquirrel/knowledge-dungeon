/**
 * Explicit fishing context.
 *
 * Plan section 5.3 records that "fishing eligibility, recall selection, and
 * persistence may use different subject contexts". The fix is a single subject
 * context value that is created when the learner enters a pond and carried,
 * unchanged, through catch resolution, recall, keep/release, XP, badges, and
 * persistence.
 *
 * This module is pure and renderer-neutral. It never reads the clock, the
 * progression store, or any renderer state: every timestamp and identifier is
 * supplied by the caller.
 */

import type { FishRarity } from './fishingTypes';

export type { CanonicalFishEntry, FishCatalogIdSource } from './fishingTypes';

/**
 * The one subject context a fishing session runs under.
 *
 * `subjectId` and `subjectName` are resolved once, at pond entry, and must not
 * be re-derived downstream. `roomId` is the room the recall question belongs
 * to when the pond was opened from a dungeon room, and `null` otherwise.
 */
export interface FishingSubjectContext {
  subjectId: string;
  subjectName: string;
  roomId: string | null;
}

/**
 * A fishing session context: the explicit subject context plus the identity of
 * the fish currently being resolved.
 *
 * `catalogId` and `rarity` are `null` while no fish has been caught; they are
 * set from the catch event and are the only fish identity a caller may carry.
 * A display name is deliberately absent: catalog identity is what persists.
 */
export interface FishingContext extends FishingSubjectContext {
  /** Opaque identifier for this fishing session. Never a learner value. */
  contextId: string;
  /** Opaque pond identifier the session started at. */
  pondId: string;
  /** ISO-8601 timestamp supplied by the caller; no real clock is read here. */
  enteredAt: string;
  catalogId: string | null;
  rarity: FishRarity | null;
}

export interface CreateFishingContextInput {
  contextId: string;
  pondId: string;
  enteredAt: string;
  subjectId: string;
  subjectName: string;
  roomId?: string | null;
}

/** Why a fishing context was rejected. Values are codes, never data. */
export type FishingContextProblemCode =
  | 'missing-subject-id'
  | 'missing-subject-name'
  | 'subject-id-mismatch'
  | 'missing-context-id'
  | 'missing-pond-id';

export interface FishingContextValidation {
  ok: boolean;
  problem: FishingContextProblemCode | null;
}

function normalizeRoomId(roomId: string | null | undefined): string | null {
  if (typeof roomId !== 'string') return null;
  const trimmed = roomId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Create a fishing context from an explicit subject context.
 *
 * Whitespace-only subject identifiers are rejected so a context can never be
 * created with an empty subject, which is what let persistence and eligibility
 * disagree in the current build.
 */
export function createFishingContext(input: CreateFishingContextInput): FishingContext {
  const subjectId = input.subjectId.trim();
  const subjectName = input.subjectName.trim();
  if (subjectId.length === 0) {
    throw new Error('createFishingContext requires a non-empty subjectId.');
  }
  if (subjectName.length === 0) {
    throw new Error('createFishingContext requires a non-empty subjectName.');
  }
  if (input.contextId.trim().length === 0) {
    throw new Error('createFishingContext requires a non-empty contextId.');
  }
  if (input.pondId.trim().length === 0) {
    throw new Error('createFishingContext requires a non-empty pondId.');
  }
  return {
    contextId: input.contextId,
    pondId: input.pondId,
    enteredAt: input.enteredAt,
    subjectId,
    subjectName,
    roomId: normalizeRoomId(input.roomId),
    catalogId: null,
    rarity: null,
  };
}

/** Project the subject half of a context, for stores keyed by subject. */
export function toFishingSubjectContext(context: FishingContext): FishingSubjectContext {
  return {
    subjectId: context.subjectId,
    subjectName: context.subjectName,
    roomId: context.roomId,
  };
}

/** Validate that a context is usable for catch, recall, and persistence. */
export function validateFishingContext(context: FishingContext): FishingContextValidation {
  if (context.contextId.trim().length === 0) {
    return { ok: false, problem: 'missing-context-id' };
  }
  if (context.pondId.trim().length === 0) {
    return { ok: false, problem: 'missing-pond-id' };
  }
  if (context.subjectId.trim().length === 0) {
    return { ok: false, problem: 'missing-subject-id' };
  }
  if (context.subjectName.trim().length === 0) {
    return { ok: false, problem: 'missing-subject-name' };
  }
  return { ok: true, problem: null };
}

/**
 * True when `candidate` describes the same subject as `context`.
 *
 * Used before a catch is committed: a resolution step that re-derived a
 * different subject context is a defect, and the caller must refuse rather
 * than persist the fish against the wrong subject.
 */
export function isSameFishingSubject(
  context: FishingContext,
  candidate: Partial<FishingSubjectContext>,
): boolean {
  if (typeof candidate.subjectId === 'string' && candidate.subjectId.trim() !== context.subjectId) {
    return false;
  }
  if (
    typeof candidate.subjectName === 'string' &&
    candidate.subjectName.trim() !== context.subjectName
  ) {
    return false;
  }
  if (candidate.roomId !== undefined) {
    return normalizeRoomId(candidate.roomId) === context.roomId;
  }
  return true;
}

/** Attach a caught fish's identity to the context, without touching the subject. */
export function withCaughtFish(
  context: FishingContext,
  input: { catalogId: string; rarity: FishRarity },
): FishingContext {
  return { ...context, catalogId: input.catalogId, rarity: input.rarity };
}
