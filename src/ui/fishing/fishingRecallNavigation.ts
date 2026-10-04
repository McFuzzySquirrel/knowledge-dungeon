/**
 * The recall question's route back to the room it came from.
 *
 * ## What Phase 17 asked for
 *
 * > "Add local recall-question navigation back to the relevant room."
 *
 * The recall modal has always known its `roomId` and has always thrown it away: it rendered
 * the prompt and two buttons, and the room the question was drawn from was unreachable. A
 * learner who cannot recall an answer is told "I need to review" and then has to remember
 * where the room was, find it on a map, and walk to it. The question knows. This module is
 * what it does with that.
 *
 * ## Why this route is *local*, and what that means precisely
 *
 * **Local** here means three separate things, and the plan's word covers all three:
 *
 * 1. **No network.** The route is four store writes and one local snapshot load. There is no
 *    URL to fetch, no route to resolve, no server to ask, and nothing that would fail
 *    offline. `loadSubjectFlow` reads the subject out of IndexedDB, which is where the learner
 *    put it. A learner on a plane at 35,000 feet with the pond open is the case that decides
 *    this design: the question they cannot recall is on their device, the room is on their
 *    device, and the route between them must be too.
 * 2. **No router.** There is no URL bar in this application and no routing library in it, so
 *    "a route" here is a *screen selection* - `activeScreen: 'game'` - plus a focused room.
 *    Building a router to express one hop would be the wrong shape of answer.
 * 3. **No fetch of a second copy.** The room's text is not re-derived from the question; the
 *    room is *focused*, and the room panel reads the room from the snapshot the learner
 *    already has. Nothing is duplicated, so the two copies cannot disagree.
 *
 * ## What the route actually does, in order
 *
 * 1. `loadSubjectFlow(subjectId)` - the canonical activation flow
 *    (`src/application/subjectActivation.ts`, the same one the village's portal and the
 *    tutorial use), which loads the subject from local persistence and syncs the session and
 *    progression stores' active subject. Reused rather than reimplemented, which is what makes
 *    "the same route the portal takes" true rather than similar.
 * 2. `setPhase('archaeologist')` - a cleared room is a room under **review**, and the
 *    Archaeologist phase is the workspace that opens onto one. The pond is entered from the
 *    village rather than from a room, so the phase the learner was in when they cast is
 *    whatever they last chose; without this the room would open as a Scribe encounter, which
 *    invites writing a note rather than re-reading one.
 * 3. `setFocusedRoomId(roomId)` - the session store's focused room, which `GameScreen` and
 *    `RoomPanel` already read.
 * 4. `setActiveScreen('game')` - last, because it is the one that swaps the world. Every
 *    write above it is already in place by the time the screen changes, so the dungeon route
 *    mounts with the right subject *and* the right room on its first render rather than
 *    rendering a default room and then correcting itself.
 *
 * The failure path matters: if the subject is not there any more - the learner deleted it
 * between catching the fish and reaching for the question - `loadSubjectFlow` returns
 * `false`, and this returns a **refusal with a sentence** rather than switching to a screen
 * showing nothing. Plan 10.1 asks for a refusal that is visible where the control that caused
 * it is, and the caller renders it in the dialog.
 *
 * ## No learner data
 *
 * `subjectId` and `roomId` are app-minted identifiers carried in application state; neither
 * reaches a DOM id, a selector, or a `data-*` attribute anywhere in this module. This module
 * renders nothing at all - it is a route, and the surface that offers it names it - so there is
 * nothing here that could leak a room's text into an attribute.
 */
import { useCallback } from 'react';

import { useSessionStore } from '@/store/sessionStore';
import { useLoadSubjectFlow } from '@/ui/hooks/useLoadSubjectFlow';

/** Why a recall-question route could not be taken. Codes and sentences, never data. */
export type RecallRoomRouteRefusal = 'subject-unavailable';

/** What the caller needs to render after attempting the route. */
export interface RecallRoomRouteResult {
  readonly ok: boolean;
  /** `null` on success; the refusal code otherwise. */
  readonly refusal: RecallRoomRouteRefusal | null;
  /** The sentence to show where the control that failed is. */
  readonly message: string;
}

/**
 * The refusal sentence.
 *
 * It says what happened *and* what the learner can still do, because a refusal that only says
 * "no" leaves the recall question as the only option, which is the situation the route existed
 * to end.
 */
export const RECALL_ROOM_UNAVAILABLE_MESSAGE =
  'That subject is no longer on this device, so its room cannot be opened. Close this and answer from what you remember, or release the fish.';

/** The destination of the route, as the caller holds it. */
export interface RecallRoomDestination {
  /** The subject the pond was entered from. App-minted. */
  readonly subjectId: string;
  /** The room the recall question was drawn from. App-minted. */
  readonly roomId: string;
}

export interface RecallRoomNavigation {
  /**
   * Focus the recall question's own room, locally.
   *
   * Returns what the caller should render. Never throws: a failed activation is an ordinary
   * thing for a learner to do (they deleted the subject in another tab), and an unhandled
   * rejection in an effect would take the pond with it.
   */
  readonly openRecallRoom: (destination: RecallRoomDestination) => Promise<RecallRoomRouteResult>;
}

/**
 * Wire the local route for one surface.
 *
 * A hook rather than a module function because two of the four steps are store actions, and a
 * hook is how a React component reaches a store without importing `getState`.
 */
export function useRecallRoomNavigation(): RecallRoomNavigation {
  const loadSubjectFlow = useLoadSubjectFlow();
  const setPhase = useSessionStore((s) => s.setPhase);
  const setFocusedRoomId = useSessionStore((s) => s.setFocusedRoomId);
  const setActiveScreen = useSessionStore((s) => s.setActiveScreen);

  const openRecallRoom = useCallback(
    async (destination: RecallRoomDestination): Promise<RecallRoomRouteResult> => {
      // Guarded before the write rather than after it, so a caller that reaches this with
      // nothing (a catch whose subject was cleared) cannot switch the learner into a dungeon
      // route with no subject loaded.
      if (destination.subjectId.trim().length === 0 || destination.roomId.trim().length === 0) {
        return {
          ok: false,
          refusal: 'subject-unavailable',
          message: RECALL_ROOM_UNAVAILABLE_MESSAGE,
        };
      }

      try {
        const activated = await loadSubjectFlow(destination.subjectId);
        if (!activated) {
          return {
            ok: false,
            refusal: 'subject-unavailable',
            message: RECALL_ROOM_UNAVAILABLE_MESSAGE,
          };
        }
        setPhase('archaeologist');
        setFocusedRoomId(destination.roomId);
        setActiveScreen('game');
        return { ok: true, refusal: null, message: '' };
      } catch {
        // A persistence failure is reported as the refusal it is for the learner, rather than
        // as an unhandled rejection inside an event handler.
        return {
          ok: false,
          refusal: 'subject-unavailable',
          message: RECALL_ROOM_UNAVAILABLE_MESSAGE,
        };
      }
    },
    [loadSubjectFlow, setActiveScreen, setFocusedRoomId, setPhase],
  );

  return { openRecallRoom };
}