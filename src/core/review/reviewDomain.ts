import type { RoomMetadata } from '@/core/validation/persistence';

import {
  REVIEWABLE_ROOM_STATES,
  type ReviewAnalyticsSnapshot,
  type ReviewUnlockInput,
  type ReviewUnlockStatus,
  type SelfCheckPrompt,
  type SelfCheckPromptInput,
} from './types';

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function toNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function isReviewableState(state: string): boolean {
  return REVIEWABLE_ROOM_STATES.includes(state as (typeof REVIEWABLE_ROOM_STATES)[number]);
}

export function isReviewableRoom(room: {
  state: string;
  validationState: { finalPass: boolean };
}): boolean {
  return room.validationState.finalPass && isReviewableState(room.state);
}

export function evaluateReviewUnlock(input: ReviewUnlockInput): ReviewUnlockStatus {
  const totalRooms = input.dungeon.rooms.length;
  const clearedRooms = input.dungeon.rooms.reduce((total, summary) => {
    const room = input.rooms[summary.roomId];
    if (!room) return total;
    return total + (isReviewableRoom(room) ? 1 : 0);
  }, 0);

  const requiredCompletionRatio = clampRatio(input.requiredCompletionRatio ?? 1);
  const completionRatio = totalRooms > 0 ? clearedRooms / totalRooms : 0;

  return {
    requiredCompletionRatio,
    completionRatio,
    totalRooms,
    clearedRooms,
    unlocked: totalRooms > 0 && completionRatio >= requiredCompletionRatio,
  };
}

function cleanHeading(value: string): string {
  return value
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/[*_`]/g, '')
    .trim();
}

export function extractMarkdownHeadings(markdown: string): string[] {
  const headings: string[] = [];
  const lines = markdown.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim().startsWith('#')) continue;
    const heading = cleanHeading(line);
    if (heading.length > 0 && !headings.includes(heading)) {
      headings.push(heading);
    }
  }

  return headings;
}

export function generateSelfCheckPrompts(input: SelfCheckPromptInput): SelfCheckPrompt[] {
  const maxPromptCount = Math.min(8, Math.max(1, toNonNegativeInteger(input.maxPromptCount || 4)));
  const prompts: SelfCheckPrompt[] = [];

  prompts.push({
    promptId: `${input.roomId}:prompt:1`,
    source: 'topic',
    text: `In one minute, explain how ${input.roomTopic} fits into ${input.subjectName}.`,
  });

  const primaryRelatedTopic = input.relatedTopics[0];
  if (primaryRelatedTopic) {
    prompts.push({
      promptId: `${input.roomId}:prompt:2`,
      source: 'relation',
      text: `How does ${input.roomTopic} connect to ${primaryRelatedTopic} during problem solving?`,
    });
  }

  const headings = input.noteHeadings.map(cleanHeading).filter((heading) => heading.length > 0);
  for (const heading of headings) {
    const nextIndex = prompts.length + 1;
    prompts.push({
      promptId: `${input.roomId}:prompt:${nextIndex}`,
      source: 'heading',
      text: `Without looking, summarize '${heading}' from your ${input.roomTopic} notes.`,
    });
  }

  if (prompts.length < maxPromptCount) {
    prompts.push({
      promptId: `${input.roomId}:prompt:${prompts.length + 1}`,
      source: 'topic',
      text: `State one exam-style question where ${input.roomTopic} is the core concept and outline your answer.`,
    });
  }

  return prompts.slice(0, maxPromptCount);
}

export function summarizeReviewAnalytics(input: {
  rooms: Record<string, RoomMetadata>;
  reviewableRoomIds: readonly string[];
  currentReviewStreak: number;
  longestReviewStreak: number;
}): ReviewAnalyticsSnapshot {
  const reviewableSet = new Set(input.reviewableRoomIds);
  let reviewSessionCount = 0;
  let reviewedRoomCount = 0;

  for (const [roomId, room] of Object.entries(input.rooms)) {
    if (!reviewableSet.has(roomId)) continue;
    const count = toNonNegativeInteger(room.reviewPassCount);
    reviewSessionCount += count;
    if (count > 0) reviewedRoomCount += 1;
  }

  const totalReviewableRooms = input.reviewableRoomIds.length;
  const fullReviewPasses =
    totalReviewableRooms > 0 ? Math.trunc(reviewSessionCount / totalReviewableRooms) : 0;

  return {
    reviewSessionCount,
    fullReviewPasses,
    currentReviewStreak: toNonNegativeInteger(input.currentReviewStreak),
    longestReviewStreak: toNonNegativeInteger(input.longestReviewStreak),
    reviewedRoomCount,
    totalReviewableRooms,
  };
}
