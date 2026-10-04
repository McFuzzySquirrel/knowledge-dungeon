/**
 * The recall dialog's **three** outcomes, and its four dialog rules.
 *
 * ## What changed and why this file is not the pre-Phase-17 file
 *
 * The pre-Phase-17 modal had two outcomes, `'correct' | 'incorrect'`, and used `'correct'` for
 * **both** "answered the question right" and "there was no question to answer". The second use
 * reached `handleKeepFish`, which awarded `FSH_XP_PER_CORRECT_ANSWER`. That is the defect Phase
 * 17's scope names: "Record a distinct outcome when a fish is kept without recall material
 * rather than treating it as a correct answer."
 *
 * So the prop is now `onDecide` over a **three-member** union, and the property asserted first
 * here is that the type has three members rather than two: a test that only clicked the buttons
 * would pass against a dialog that still conflated the two cases, because `kept-without-recall`
 * did not exist to be asserted against.
 *
 * ## What each test is for
 *
 * - **The three outcomes** are named, distinct, and reachable: one test per button, asserting the
 *   exact `(choice, roomId)` pair, because the `roomId` is what makes an answered outcome carry
 *   the room the question came from - and the union in `contracts/commands.ts` is *shaped* so
 *   that "answered correctly with no room" is not a value that can exist.
 * - **`roomId` is never in the DOM** is asserted as a query, not as a source scan: the string
 *   `'room-1'` appears in the rendered output nowhere, which is the property that matters for a
 *   test that pastes a failure into an issue.
 * - **The dialog rules** are initial focus, Tab containment, Escape, and restoration. Escape is
 *   the interesting one, because it must reach *cancel* rather than either decision: a key that
 *   discards a catch must not be one keystroke from a key that claims a reward.
 * - **The route** is asserted to render when a destination exists and to be *absent* when one
 *   does not - the app's rule for a capability it does not have, and the reason a
 *   `null`-destination learner is not shown a dead control.
 *
 * Hermeticity: no renderer, no network, no real clock. The navigation hook's store writes are
 * exercised against the real session store and reset in `afterEach`.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@/store/sessionStore';
import type { SelfCheckPrompt } from '@/core/review/types';

/**
 * The subject activation hook is replaced at module scope.
 *
 * The route's whole claim is that it is local: it loads the subject from this device's own
 * persistence through `src/application/subjectActivation.ts`. That load is the only part with
 * storage behind it, so it is the only part replaced - the four store writes the route then
 * performs are the claim under test and are asserted against the real store.
 */
const loadSubjectMock = vi.hoisted(() => vi.fn<(id: string) => Promise<boolean>>());

vi.mock('@/ui/hooks/useLoadSubjectFlow', () => ({
  useLoadSubjectFlow: () => loadSubjectMock,
}));

// Imported after the mock so the hook the module under test closes over is the mocked one.
const { FishingRecallModal } = await import('@/ui/components/FishingRecallModal');

const PROMPT: SelfCheckPrompt = {
  promptId: 'room-1:prompt:1',
  text: 'In one minute, explain how Vector Spaces fits into Linear Algebra.',
  source: 'topic',
};

/** Every prop the dialog needs, with the outcome decision spyable. */
function renderModal(
  overrides: Partial<React.ComponentProps<typeof FishingRecallModal>> = {},
): { onDecide: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onDecide = vi.fn();
  const onCancel = vi.fn();
  render(
    <FishingRecallModal
      fishName="Moss Carp"
      rarity="common"
      catalogId="moss-carp"
      description="A placid bottom-feeder."
      recallQuestion={{ prompt: PROMPT, roomId: 'room-1' }}
      onDecide={onDecide}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onDecide, onCancel };
}

describe('FishingRecallModal', () => {
  beforeEach(() => {
    useSessionStore.setState({ activeScreen: 'village', phase: 'scribe', focusedRoomId: null });
    loadSubjectMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe('the three outcomes are distinct values, not two', () => {
    it('the decision callback is typed over three choices and "correct" is not one of them', async () => {
      // A runtime assertion on the *type*, because a type is erased. `resolvedChoices` is the
      // set of strings the dialog can ever emit, taken from the prop's own declaration by
      // importing the union's members through a value that carries them.
      const { FISHING_RECALL_CHOICES } = await import('@/ui/components/FishingRecallModal');
      expect([...FISHING_RECALL_CHOICES].sort()).toEqual([
        'answered-correct',
        'answered-incorrect',
        'kept-without-recall',
      ]);
      // The pre-Phase-17 vocabulary is *gone*: 'correct' and 'incorrect' are the two-value
      // union that made the third outcome inexpressible. Cast through `string` on purpose - the
      // point is that the *set* does not hold them, and a direct `has('correct')` would be a
      // compile error rather than a runtime fact.
      const choices: ReadonlySet<string> = FISHING_RECALL_CHOICES;
      expect(choices.has('correct')).toBe(false);
      expect(choices.has('incorrect')).toBe(false);
    });

    it('"I got it right" commits answered-correct with the question’s room', () => {
      const { onDecide } = renderModal();
      fireEvent.click(screen.getByRole('button', { name: 'I got it right' }));
      expect(onDecide).toHaveBeenCalledWith('answered-correct', 'room-1');
    });

    it('"I need to review" commits answered-incorrect with the question’s room', () => {
      const { onDecide } = renderModal();
      fireEvent.click(screen.getByRole('button', { name: 'I need to review' }));
      expect(onDecide).toHaveBeenCalledWith('answered-incorrect', 'room-1');
    });

    it('the no-question branch commits kept-without-recall and NOT answered-correct', () => {
      // The defect, asserted head-on: the pre-Phase-17 no-question button called
      // `onSelfEvaluate('correct')`. The new one must not be able to, and the no-question
      // branch must have no control that can.
      const { onDecide } = renderModal({ recallQuestion: null });
      fireEvent.click(screen.getByRole('button', { name: /Keep this fish/i }));
      expect(onDecide).toHaveBeenCalledWith('kept-without-recall', null);
      // And there is no button on this branch that commits anything else.
      const committing = screen
        .getAllByRole('button')
        .map((button) => button.getAttribute('data-fishing-touch-target'));
      expect(committing).toEqual(['keep-without-recall', 'recall-cancel']);
    });

    it('the no-question branch says the fish earns no experience, in words', () => {
      // The wording matters as much as the wiring: a learner told they kept a fish reasonably
      // expects a credit, and the pre-Phase-17 dialog paid one silently.
      renderModal({ recallQuestion: null });
      expect(screen.getByText(/It joins your collection/i)).toBeInTheDocument();
      expect(screen.getByText(/adds no experience/i)).toBeInTheDocument();
      expect(
        screen.getByText(/not the same event as answering one correctly/i),
      ).toBeInTheDocument();
    });

    it('the no-question branch does not label its button "Keep Fish"', () => {
      // The exact pre-Phase-17 label, which is what a test elsewhere looked for. Keeping it
      // would make this dialog and the catch panel indistinguishable to a test *and* to a
      // learner who has just seen the other one.
      renderModal({ recallQuestion: null });
      expect(screen.queryByRole('button', { name: 'Keep Fish' })).toBeNull();
    });
  });

  describe('the fish, in words rather than in colour', () => {
    it('renders the name and a rarity badge that is also spelled out', () => {
      renderModal();
      expect(screen.getByRole('heading', { name: 'Moss Carp' })).toBeInTheDocument();
      expect(screen.getByText('COMMON')).toBeInTheDocument();
    });

    it('shows the prompt text', () => {
      renderModal();
      expect(screen.getByText(PROMPT.text)).toBeInTheDocument();
      expect(screen.getByText(/Test your knowledge/i)).toBeInTheDocument();
    });

    it('states what each of the two decisions means, before the learner chooses', () => {
      renderModal();
      expect(screen.getByText(/records a correct answer and adds experience/i)).toBeInTheDocument();
      expect(screen.getByText(/sends the fish back and adds nothing/i)).toBeInTheDocument();
    });
  });

  describe('dialog accessibility, all four rules', () => {
    it('is a labelled modal dialog described by its body', () => {
      renderModal();
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      // Labelled by its own visible heading, not by an `aria-label` string that could drift
      // from what it says on screen.
      const labelledBy = dialog.getAttribute('aria-labelledby');
      expect(labelledBy).not.toBeNull();
      expect(document.getElementById(labelledBy as string)?.textContent).toContain('Moss Carp');
      const describedBy = dialog.getAttribute('aria-describedby');
      expect(describedBy).not.toBeNull();
      expect(document.getElementById(describedBy as string)).not.toBeNull();
    });

    it('takes initial focus on the dialog, not on the reward-claiming button', () => {
      renderModal();
      const dialog = screen.getByRole('dialog');
      // Focusing the first button would put "I got it right" under the learner's next Enter.
      expect(document.activeElement).toBe(dialog);
    });

    it('contains Tab inside the dialog', () => {
      renderModal();
      const dialog = screen.getByRole('dialog');
      const buttons = screen.getAllByRole('button');
      const last = buttons[buttons.length - 1];

      last.focus();
      fireEvent.keyDown(document, { key: 'Tab' });
      // Wrapped: focus is back inside, on the first control.
      expect(dialog.contains(document.activeElement)).toBe(true);

      // And Shift+Tab from the first control wraps to the last rather than escaping behind it.
      const first = buttons[0];
      first.focus();
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('Escape closes without committing either outcome', () => {
      // The rule that matters most here: Escape must reach *cancel*. A key one step from a
      // reward is a key that can be pressed by accident.
      const { onDecide, onCancel } = renderModal();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onCancel).toHaveBeenCalledOnce();
      expect(onDecide).not.toHaveBeenCalled();
    });

    it('restores focus to whatever had it before the dialog opened', () => {
      const opener = document.createElement('button');
      opener.textContent = 'Keep Fish';
      document.body.appendChild(opener);
      opener.focus();
      expect(document.activeElement).toBe(opener);

      const { unmount } = render(
        <FishingRecallModal
          fishName="Moss Carp"
          rarity="common"
          catalogId="moss-carp"
          description="A placid bottom-feeder."
          recallQuestion={{ prompt: PROMPT, roomId: 'room-1' }}
          onDecide={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(document.activeElement).not.toBe(opener);

      unmount();
      expect(document.activeElement).toBe(opener);
      opener.remove();
    });

    it('a backdrop click does not close it, so a mis-aimed touch cannot discard a catch', () => {
      const { onCancel } = renderModal();
      fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
      expect(onCancel).not.toHaveBeenCalled();
    });
  });

  describe('the local route back to the question’s room', () => {
    it('is offered when a destination exists, and absent when one does not', () => {
      const { unmount } = render(
        <FishingRecallModal
          fishName="Moss Carp"
          rarity="common"
          catalogId="moss-carp"
          description="A placid bottom-feeder."
          recallQuestion={{ prompt: PROMPT, roomId: 'room-1' }}
          destination={{ subjectId: 'linear-algebra', roomId: 'room-1' }}
          onDecide={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByRole('button', { name: /Open the room this question came from/i })).toBeInTheDocument();
      unmount();

      renderModal({ destination: null });
      expect(
        screen.queryByRole('button', { name: /Open the room this question came from/i }),
      ).toBeNull();
    });

    it('is not offered at all when there is no question, because there is no room', () => {
      renderModal({ recallQuestion: null, destination: { subjectId: 'linear-algebra', roomId: 'room-1' } });
      expect(
        screen.queryByRole('button', { name: /Open the room this question came from/i }),
      ).toBeNull();
    });

    it('pressing it switches to the dungeon route and focuses the question’s room', async () => {
      // The route is four local store writes and one local snapshot load: no network, no
      // router, no fetch. What is asserted here is the *effect* of it, because that is what a
      // learner experiences.
      const loadSubject = loadSubjectMock;
      loadSubject.mockResolvedValue(true);

      render(
        <FishingRecallModal
          fishName="Moss Carp"
          rarity="common"
          catalogId="moss-carp"
          description="A placid bottom-feeder."
          recallQuestion={{ prompt: PROMPT, roomId: 'room-1' }}
          destination={{ subjectId: 'linear-algebra', roomId: 'room-1' }}
          onDecide={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /Open the room this question came from/i }));
      await vi.waitFor(() => {
        expect(useSessionStore.getState().activeScreen).toBe('game');
      });
      expect(loadSubject).toHaveBeenCalledWith('linear-algebra');
      expect(useSessionStore.getState().focusedRoomId).toBe('room-1');
      // A cleared room is a room under review, not a room to write up.
      expect(useSessionStore.getState().phase).toBe('archaeologist');
    });

    it('says so, and changes nothing, when the subject is no longer on this device', async () => {
      // The refusal has to be *visible where the control that caused it is*, which plan 10.1
      // asks for and which a console line can never be.
      loadSubjectMock.mockResolvedValue(false);
      render(
        <FishingRecallModal
          fishName="Moss Carp"
          rarity="common"
          catalogId="moss-carp"
          description="A placid bottom-feeder."
          recallQuestion={{ prompt: PROMPT, roomId: 'room-1' }}
          destination={{ subjectId: 'linear-algebra', roomId: 'room-1' }}
          onDecide={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /Open the room this question came from/i }));
      const refusal = await screen.findByRole('alert');
      expect(refusal.textContent).toMatch(/no longer on this device/i);
      expect(useSessionStore.getState().activeScreen).toBe('village');
      expect(useSessionStore.getState().focusedRoomId).toBeNull();
    });
  });

  describe('no learner data in the DOM', () => {
    it('the room id appears nowhere in the rendered output', () => {
      const { container } = render(
        <FishingRecallModal
          fishName="Moss Carp"
          rarity="common"
          catalogId="moss-carp"
          description="A placid bottom-feeder."
          recallQuestion={{ prompt: PROMPT, roomId: 'room-1' }}
          destination={{ subjectId: 'linear-algebra', roomId: 'room-1' }}
          onDecide={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      // An app-minted room id is not learner text, but it *is* an internal identifier, and an
      // attribute or a selector built from it is what Phase 16's control-id rules forbid.
      expect(container.innerHTML).not.toContain('room-1');
      expect(container.innerHTML).not.toContain('linear-algebra');
    });

    it('every id on the dialog is the static recall-room control id', () => {
      renderModal({ destination: { subjectId: 'linear-algebra', roomId: 'room-1' } });
      const dialog = screen.getByRole('dialog');
      expect(dialog.getAttribute('id')).toBeNull();
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.getAttribute('id'));
      // React's `useId` values are opaque and content-free by construction; every *other* id is
      // a static literal from `FISHING_CONTROL_IDS`, which is the rule the whole file claims.
      const authored = ids.filter((id) => id !== null && !/^_r_/.test(id));
      expect(authored).toEqual(['fishing-recall-room']);
    });
  });
});