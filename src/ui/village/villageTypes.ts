/**
 * Types and constants the village shell shares between its panels.
 *
 * ## What is deliberately *not* here
 *
 * - No renderer type, and no PixiJS or Phaser type. A panel that needs the world
 *   takes a renderer-neutral capability read (see `useVillageNpcSurface.ts`).
 * - No store. The panels read what the screen hands them; the screen owns the
 *   `useSessionStore` / `useSubjectStore` selectors so there is one subscription
 *   per fact rather than one per panel.
 * - No component, and no React import at all - not even a type-only one - so a
 *   source-level gate can read this file as plainly as it can read a contract.
 */

/**
 * One subject as the village shell presents it.
 *
 * A projection, not a snapshot: the village needs a name, a room count and a
 * cleared count, and it reads those from IndexedDB once per mount. Naming the
 * projection keeps a panel from being handed a whole `SubjectSnapshot` and
 * having to guess which three fields it was allowed to look at.
 */
export interface VillageSubjectSummary {
  readonly id: string;
  readonly subjectName: string;
  readonly roomCount: number;
  readonly clearedRoomCount: number;
}

/**
 * Which of the two Cozy panel shapes a surface takes.
 *
 * - `side` - a Cozy side panel docked beside the world, for a pointer-and-
 *   keyboard viewport with room for one.
 * - `sheet` - a Cozy bottom sheet, for touch and for any viewport too narrow to
 *   hold a side panel without starving the world.
 *
 * The union is two members and not a boolean so a call site reads as a shape
 * (`role="dialog"` on a sheet, a labelled `region` on a side panel) rather than as
 * a negation, and so a third shape is a deliberate addition to this file.
 */
export type VillageSurfaceMode = 'side' | 'sheet';

/**
 * The 44 by 44 CSS-pixel floor, as one object a control can spread into `style`.
 *
 * ## Why the number is *inline* and not only in the stylesheet
 *
 * `COZY_TOUCH_TARGET_MIN` is the token and `villagePanels.css` applies it, but a
 * stylesheet rule cannot be asserted by a component test - jsdom does not compute
 * it, and a test that measured computed style would be measuring the environment
 * rather than the component. So the floor is written onto the element, which makes
 * it a property of the *control* and not of the cascade. `tests/phase12/`
 * reads it off the element.
 *
 * The value is written out rather than interpolated from the token, because this
 * file takes no import; the token is the reason 44 is the number, and the two
 * spellings are checked against each other in the tests below.
 */
export const VILLAGE_TOUCH_TARGET_STYLE: {
  readonly minWidth: string;
  readonly minHeight: string;
} = Object.freeze({ minWidth: '44px', minHeight: '44px' });

/** Aggregate collection counts the village HUD and panels read. */
export interface VillageCollectionTotals {
  readonly badges: number;
  readonly artifacts: number;
  readonly notes: number;
  readonly dungeons: number;
}

/** The one-shot study-time summary the fountain panel shows. */
export interface VillageStudyTotals {
  readonly totalSessions: number;
  readonly totalMinutesStudied: number;
  readonly totalNotesSubmitted: number;
  readonly totalReviewsCompleted: number;
  readonly recentStreak: number;
  readonly rank: string;
  readonly xpTotal: number;
}
