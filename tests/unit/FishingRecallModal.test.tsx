import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FishingRecallModal } from '@/ui/components/FishingRecallModal';
import type { SelfCheckPrompt } from '@/core/review/types';

function makePrompt(overrides: Partial<SelfCheckPrompt> = {}): SelfCheckPrompt {
  return {
    promptId: 'room-1:prompt:1',
    text: 'In one minute, explain how Vector Spaces fits into Linear Algebra.',
    source: 'topic',
    ...overrides,
  };
}

describe('FishingRecallModal', () => {
  it('renders fish name and rarity badge', () => {
    const prompt = makePrompt();
    render(
      <FishingRecallModal
        fishName="Moss Carp"
        rarity="common"
        catalogId="moss-carp"
        description="A placid bottom-feeder."
        recallQuestion={{ prompt, roomId: 'room-1' }}
        onSelfEvaluate={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('Moss Carp')).toBeInTheDocument();
    expect(screen.getByText('COMMON')).toBeInTheDocument();
  });

  it('shows the recall question prompt text', () => {
    const prompt = makePrompt({ text: 'What is the meaning of life?' });
    render(
      <FishingRecallModal
        fishName="Moss Carp"
        rarity="common"
        catalogId="moss-carp"
        description="A fish."
        recallQuestion={{ prompt, roomId: 'room-1' }}
        onSelfEvaluate={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('What is the meaning of life?')).toBeInTheDocument();
    expect(screen.getByText(/Test your knowledge/i)).toBeInTheDocument();
  });

  it('clicking "I got it right" calls onSelfEvaluate with "correct"', () => {
    const onSelfEvaluate = vi.fn();
    const prompt = makePrompt();
    render(
      <FishingRecallModal
        fishName="Moss Carp"
        rarity="common"
        catalogId="moss-carp"
        description="A fish."
        recallQuestion={{ prompt, roomId: 'room-1' }}
        onSelfEvaluate={onSelfEvaluate}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'I got it right' }));
    expect(onSelfEvaluate).toHaveBeenCalledWith('correct');
  });

  it('clicking "I need to review" calls onSelfEvaluate with "incorrect"', () => {
    const onSelfEvaluate = vi.fn();
    const prompt = makePrompt();
    render(
      <FishingRecallModal
        fishName="Moss Carp"
        rarity="common"
        catalogId="moss-carp"
        description="A fish."
        recallQuestion={{ prompt, roomId: 'room-1' }}
        onSelfEvaluate={onSelfEvaluate}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'I need to review' }));
    expect(onSelfEvaluate).toHaveBeenCalledWith('incorrect');
  });

  it('when recallQuestion is null, shows fallback message and "Keep Fish" button', () => {
    const onSelfEvaluate = vi.fn();
    render(
      <FishingRecallModal
        fishName="Abyssal Eel"
        rarity="epic"
        catalogId="abyssal-eel"
        description="A ribbon of shadow."
        recallQuestion={null}
        onSelfEvaluate={onSelfEvaluate}
        onCancel={vi.fn()}
      />,
    );

    expect(
      screen.getAllByText(/No review material available/),
    ).toHaveLength(2);
    expect(screen.getByText(/you can keep this fish/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep Fish' }));
    expect(onSelfEvaluate).toHaveBeenCalledWith('correct');
  });

  it('when recallQuestion is null, clicking Cancel calls onCancel', () => {
    const onCancel = vi.fn();
    render(
      <FishingRecallModal
        fishName="Abyssal Eel"
        rarity="epic"
        catalogId="abyssal-eel"
        description="A ribbon of shadow."
        recallQuestion={null}
        onSelfEvaluate={vi.fn()}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('shows rarity badge with data-rarity attribute for styling', () => {
    const prompt = makePrompt();
    render(
      <FishingRecallModal
        fishName="Gilded Koi"
        rarity="epic"
        catalogId="gilded-koi"
        description="A magnificent fish."
        recallQuestion={{ prompt, roomId: 'room-1' }}
        onSelfEvaluate={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const badge = screen.getByText('EPIC');
    expect(badge).toBeInTheDocument();
    expect(badge.closest('[data-rarity="epic"]')).not.toBeNull();
  });

  it('renders as a dialog with modal accessibility attributes', () => {
    const prompt = makePrompt();
    render(
      <FishingRecallModal
        fishName="Moss Carp"
        rarity="common"
        catalogId="moss-carp"
        description="A placid bottom-feeder."
        recallQuestion={{ prompt, roomId: 'room-1' }}
        onSelfEvaluate={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });
});
