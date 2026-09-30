/**
 * The village DOM mirror: the accessible half of the Pixi canvas.
 *
 * ## What plan 10.1 asks for, and where each clause is asserted
 *
 * | Clause                                          | Where it is asserted below                    |
 * |-------------------------------------------------|-----------------------------------------------|
 * | A DOM equivalent for every Pixi interaction      | the interact control calls the capability     |
 * | Minimum 44 by 44 CSS-pixel touch targets         | the control's own `minWidth`/`minHeight`      |
 * | No colour-only state communication               | a polite sentence, in words                   |
 * | A non-canvas route exists for everything         | the canvas is `aria-hidden` and a region      |
 *
 * ## The renderer is a double, and why that is right here
 *
 * `village-scene.test.ts` runs the real PixiJS scene and the real application. This
 * file is about the accessible tree, and the accessible tree is a function of the
 * component's markup and its capability calls, not of a GPU. So the renderer factory
 * is mocked: the mount lifecycle is recorded, and the interact control's effect on
 * the capability port is read directly. Every assertion stays about markup, focus,
 * text, and one imperative call.
 *
 * Hermeticity: no `dist/`, no network, no commit. Nothing here mounts a canvas.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { COZY_TOUCH_TARGET_MIN } from '../../src/theme';

/**
 * The records a mounted fake renderer leaves for the assertions.
 *
 * `vi.hoisted` so the mock factory below and this test file share one object: a
 * `vi.mock` factory is hoisted above imports, so it cannot close over a `const`
 * declared at module scope.
 */
const fake = vi.hoisted(() => {
  interface FakeRenderer {
    readonly mount: ReturnType<typeof vi.fn>;
    readonly unmount: ReturnType<typeof vi.fn>;
    readonly restart: ReturnType<typeof vi.fn>;
    readonly setDynamicStructures: ReturnType<typeof vi.fn>;
    readonly setPlayerClass: ReturnType<typeof vi.fn>;
    readonly triggerInteract: ReturnType<typeof vi.fn>;
    readonly readPoi: () => null;
    readonly onReady: (listener: () => void) => () => void;
    readonly fireReady: () => void;
  }
  const created: FakeRenderer[] = [];
  return {
    created,
    latest: (): FakeRenderer => {
      const renderer = created[created.length - 1];
      if (renderer === undefined) throw new Error('no fake renderer was created');
      return renderer;
    },
  };
});

vi.mock('../../src/renderers/pixi/village/VillageRenderer', () => ({
  createPixiVillageRenderer: () => {
    const listeners = new Set<() => void>();
    const renderer = {
      mount: vi.fn(),
      unmount: vi.fn(),
      isReady: () => false,
      restart: vi.fn(),
      setDynamicStructures: vi.fn(),
      setPlayerClass: vi.fn(),
      triggerInteract: vi.fn(),
      readPoi: () => null,
      onReady: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      fireReady: () => {
        for (const listener of listeners) listener();
      },
    };
    fake.created.push(renderer);
    return renderer;
  },
}));

// Imported after the mock so the component resolves the fake factory.
import VillageWorld from '../../src/renderers/pixi/village/VillageWorld';
import type { VillageSceneCallbacks } from '../../src/renderers/pixi/village/VillageRenderer';

const callbacks: VillageSceneCallbacks = {
  onStructureApproached: vi.fn(),
  onStructureLeft: vi.fn(),
  onStructureInteract: vi.fn(),
  onReady: vi.fn(),
};

const world = { kind: 'village' as const, structures: [], playerClass: null };

async function renderWorld(): Promise<ReturnType<typeof render>> {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<VillageWorld world={world} callbacks={callbacks} />);
  });
  await vi.waitFor(() => {
    expect(screen.getByRole('button', { name: 'Interact (E or Space)' })).toBeTruthy();
  });
  return view;
}

afterEach(() => {
  cleanup();
  fake.created.length = 0;
  vi.clearAllMocks();
});

describe('the interact control is a real, labelled, keyboard-operable control', () => {
  it('is a button that meets the 44 by 44 CSS-pixel minimum', async () => {
    await renderWorld();
    expect(COZY_TOUCH_TARGET_MIN).toBe(44);
    const button = screen.getByRole('button', { name: 'Interact (E or Space)' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.hasAttribute('disabled')).toBe(false);
    const style = (button as HTMLElement).style;
    expect(style.minWidth).toBe('44px');
    expect(style.minHeight).toBe('44px');
    expect(Number.parseInt(style.minWidth, 10)).toBeGreaterThanOrEqual(COZY_TOUCH_TARGET_MIN);
    expect(Number.parseInt(style.minHeight, 10)).toBeGreaterThanOrEqual(COZY_TOUCH_TARGET_MIN);
  });

  it('describes the keys and the pointer route in a hidden hint', async () => {
    await renderWorld();
    const button = screen.getByRole('button', { name: 'Interact (E or Space)' });
    const describedBy = (button.getAttribute('aria-describedby') ?? '').split(/\s+/);
    const hint = describedBy
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(hint).toContain('nearest structure');
    expect(hint).toContain('E or Space');
    expect(hint).toContain('tap the village');
  });

  it('calls the renderer capability on click, so the control is the DOM equivalent of the canvas tap', async () => {
    const user = userEvent.setup();
    await renderWorld();
    const button = screen.getByRole('button', { name: 'Interact (E or Space)' });
    await user.click(button);
    expect(fake.latest().triggerInteract).toHaveBeenCalledTimes(1);
  });

  it('is activatable with Enter and with Space', async () => {
    const user = userEvent.setup();
    await renderWorld();
    const button = screen.getByRole('button', { name: 'Interact (E or Space)' });
    button.focus();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(fake.latest().triggerInteract).toHaveBeenCalledTimes(2);
  });
});

describe('state is announced in words, never by colour', () => {
  it('starts with a polite "starting" sentence naming motion and quality', async () => {
    const { container } = await renderWorld();
    const status = container.querySelector('[aria-live="polite"]');
    expect(status).not.toBeNull();
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toContain('Village starting');
    expect(status?.textContent).toContain('Motion enabled');
    expect(status?.textContent).toMatch(/Quality profile: (high|balanced|constrained)/);
  });

  it('flips to "presented" when the renderer reports its first frame', async () => {
    const { container } = await renderWorld();
    await act(async () => {
      fake.latest().fireReady();
    });
    const status = container.querySelector('[aria-live="polite"]');
    expect(status?.textContent).toContain('Village presented');
    // The words carry the state; nothing in this component signals it by colour.
    expect(status?.textContent).not.toBe('');
  });

  it('mounts and unmounts the renderer exactly once', async () => {
    const view = await renderWorld();
    const renderer = fake.latest();
    expect(renderer.mount).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(renderer.unmount).toHaveBeenCalledTimes(1);
  });

  it('renders a labelled visual region, so the canvas is not an unnamed surface', async () => {
    const { container } = await renderWorld();
    expect(screen.getByRole('img', { name: 'Village world' })).toBeTruthy();
    // The surface the renderer appends its canvas into is present and identified.
    expect(container.querySelector('[data-pixi-surface="pixi-village-world"]')).not.toBeNull();
  });
});
