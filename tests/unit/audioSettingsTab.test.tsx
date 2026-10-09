/**
 * Phase 10: the accessible audio settings surface.
 *
 * The plan's exit criterion for this phase is one sentence - "User audio controls
 * are keyboard and screen-reader accessible" - and it is the kind of sentence that
 * is easy to claim and hard to have earned. So this file is organised around the
 * six ways that sentence is usually only *asserted* rather than delivered:
 *
 * 1. **The tab and the panel.** The Audio tab is a real `tab` in the existing
 *    `tablist`, its panel is the only `tabpanel` mounted while it is selected, and
 *    the theme tab beside it is untouched - three options, no `cozy-parchment`,
 *    because the theme picker is a later phase's job and this one only adds audio.
 * 2. **Names and values.** All three switches and both sliders are reachable by
 *    role *and* accessible name, and the panel contains no fourth control that
 *    slipped in unnamed. Each volume exposes its value four ways - `aria-valuenow`,
 *    `aria-valuemin`/`max`, `aria-valuetext`, and a number in plain sight - because
 *    a bare slider with no readout is the usual way this requirement fails.
 * 3. **Writing through the store.** Every control calls a store action, verified
 *    against a wrapped action rather than against the resulting state alone, so a
 *    surface that mutated the store directly would fail here. Turning a switch
 *    flips `aria-checked` and changes nothing else.
 * 4. **The mute distinction.** Mute is not "music off": muting and un-muting leaves
 *    both per-bus choices and both volumes exactly as they were, which is the
 *    property the audio contract states and the one a learner is most likely to
 *    lose. The help text has to say so, and a slider for an off bus stays enabled.
 * 5. **Persistence.** Mute and both volumes round-trip: the UI writes the whole
 *    payload, a fresh store module reading the persisted payload comes back with the
 *    same five values, and the payload still carries the pre-existing theme key.
 * 6. **Control panel, not player.** Nothing here constructs an `AudioContext` or
 *    registers a gesture listener, checked at runtime *and* against the component's
 *    own source, because the runtime check alone would pass on a surface that
 *    unlocked audio from a settings click.
 *
 * ## Honesty about what jsdom cannot check
 *
 * Native range keyboard operation cannot be exercised in jsdom: the platform's
 * arrow-key and `Home`/`End` handling does not exist here, and no test can prove a
 * slider responds to a key in a real browser. What *is* checkable, and checked, is
 * that the surface did not take that behaviour over - the sliders are real
 * `input[type=range]` elements, a synthesised arrow key changes nothing, and the
 * component source contains no key handler and no arrow-key name at all. Real screen
 * reader output is not verified here either; the accessible names are asserted
 * through the same engine axe and Testing Library use, which is a proxy and not the
 * thing itself.
 *
 * ## Isolation
 *
 * The preferences store is a module singleton, so each test sets only the five audio
 * fields and restores them afterwards, and `localStorage` is cleared between tests so
 * one test's persisted payload cannot become the next test's hydrated state. The
 * reload test deliberately re-imports the store after `vi.resetModules()`, which is
 * what a page load is from the store's point of view, and it reads that instance
 * rather than the one the component is bound to.
 *
 * Privacy: every fixture is synthetic. The one string that looks like learner data,
 * `LEARNER_MARKER`, is planted in application state precisely so the assertion that
 * it never reaches an attribute value is not vacuous.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import i18n from '@/i18n';
import { AudioSettingsTab } from '@/ui/components/AudioSettingsTab';
import { SettingsModal } from '@/ui/components/SettingsModal';
import { usePreferencesStore, __testing as preferencesTesting } from '@/store/preferencesStore';
import { audioManager } from '@/services/audioManager';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The documented defaults, restated here so a store change shows up as a diff. */
const DEFAULT_AUDIO = {
  musicVolume: 0.4,
  sfxVolume: 0.6,
  muted: false,
  musicEnabled: true,
  sfxEnabled: true,
} as const;

/** A string no part of the application should ever render or attribute. */
const LEARNER_MARKER = 'Zebulon Quicksilver Lecture 42';

/** The gesture event names the audio service listens for. */
const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const;

/** The panel's fixed ids, mirrored so a rename fails here as well as in the DOM. */
const IDS = {
  mute: 'settings-audio-mute',
  muteLabel: 'settings-audio-mute-label',
  muteHelp: 'settings-audio-mute-help',
  music: 'settings-audio-music',
  musicLabel: 'settings-audio-music-label',
  musicHelp: 'settings-audio-music-help',
  musicVolume: 'settings-audio-music-volume',
  sfx: 'settings-audio-sfx',
  sfxLabel: 'settings-audio-sfx-label',
  sfxHelp: 'settings-audio-sfx-help',
  sfxVolume: 'settings-audio-sfx-volume',
} as const;

/** The original store actions, so a wrapped action can be restored afterwards. */
const ORIGINAL_ACTIONS = {
  setMusicVolume: usePreferencesStore.getState().setMusicVolume,
  setSfxVolume: usePreferencesStore.getState().setSfxVolume,
  setMuted: usePreferencesStore.getState().setMuted,
  setMusicEnabled: usePreferencesStore.getState().setMusicEnabled,
  setSfxEnabled: usePreferencesStore.getState().setSfxEnabled,
};

type AudioActionName = keyof typeof ORIGINAL_ACTIONS;
type ActionCalls = Record<AudioActionName, unknown[][]>;

/** The five persisted audio fields, read straight out of the store. */
function audioState(): {
  musicVolume: number;
  sfxVolume: number;
  muted: boolean;
  musicEnabled: boolean;
  sfxEnabled: boolean;
} {
  const state = usePreferencesStore.getState();
  return {
    musicVolume: state.musicVolume,
    sfxVolume: state.sfxVolume,
    muted: state.muted,
    musicEnabled: state.musicEnabled,
    sfxEnabled: state.sfxEnabled,
  };
}

/** The persisted payload exactly as the store wrote it. */
function persistedPayload(): Record<string, unknown> {
  const raw = window.localStorage.getItem(preferencesTesting.PREFERENCES_STORAGE_KEY);
  expect(raw, 'the surface persisted nothing').not.toBeNull();
  return JSON.parse(raw as string) as Record<string, unknown>;
}

function helpTextFor(id: string): string {
  const element = document.getElementById(id);
  expect(element, `no element with id ${id}`).not.toBeNull();
  return (element as HTMLElement).textContent ?? '';
}

beforeEach(async () => {
  window.localStorage.clear();
  await i18n.changeLanguage('en');
  // Only the five audio fields, and set directly so the test's own starting state
  // is never itself a persisted write.
  usePreferencesStore.setState({ ...DEFAULT_AUDIO });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  usePreferencesStore.setState({ ...DEFAULT_AUDIO, ...ORIGINAL_ACTIONS });
  vi.restoreAllMocks();
});

// ── 1. The tab and the panel ───────────────────────────────────────────────

describe('the Audio tab', () => {
  it('is a real tab in the settings tablist, with its panel the only one mounted', () => {
    render(<SettingsModal currentTheme="dark" onThemeChange={() => {}} onClose={() => {}} />);

    const tabs = screen.getAllByRole('tab');
    // Phase 23 turns on Gentle assistance by default, so the Assistance settings tab is
    // present in the default build alongside the audio tab.
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Theme',
      'Language',
      'Shortcuts',
      'Audio',
      'Assistance',
    ]);
    expect(screen.getByRole('tab', { name: 'Audio' })).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(screen.getByRole('tab', { name: 'Audio' }));

    expect(screen.getByRole('tab', { name: 'Audio' })).toHaveAttribute('aria-selected', 'true');
    // The panel is named, so a screen reader landing on it says what it is.
    expect(screen.getByRole('tabpanel', { name: 'Audio settings' })).toBeInTheDocument();
    // The theme and language panels are unmounted while the audio one is shown, so
    // their radios cannot be tabbed into from here.
    expect(screen.queryByRole('radiogroup', { name: 'UI theme choices' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tabpanel', { name: 'Theme settings' })).not.toBeInTheDocument();
  });

  /*
   * Phase 21: this assertion changed, and the reason is recorded rather than the expectation quietly
   * retyped.
   *
   * It asserted the theme radios' exact `textContent`. The radio members now render a `✓` mark for the
   * checked one, because Phase 21 requires every coloured state to have a non-colour equivalent and the
   * accent fill is the only signal this picker had. `textContent` therefore now reads
   * `'✓ NightDeep navy…'`.
   *
   * The **property worth asserting** is unchanged and is now asserted in two pieces rather than one:
   *
   * 1. the picker's *content* is exactly the three themes, each with its own title and description -
   *    compared with the mark stripped, because the mark is state, not content;
   * 2. the checked state is carried by `aria-checked` **and** by a mark that is in the DOM and hidden
   *    from the accessibility tree, so it is neither invisible to a screen reader nor noisy in its
   *    announcement.
   *
   * A single `textContent` equality could not express (2), and expressing (1) as "text plus possibly a
   * mark" would have let a second mark slip in unnoticed.
   */
  it('leaves the theme picker exactly as it found it', () => {
    render(<SettingsModal currentTheme="dark" onThemeChange={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Theme' }));

    const group = within(screen.getByRole('radiogroup', { name: 'UI theme choices' }));
    const themes = group.getAllByRole('radio');

    // (1) The content, with the state mark removed.
    expect(
      themes.map((theme) => (theme.textContent ?? '').replace('✓', '')),
    ).toEqual([
      'NightDeep navy UI chrome with balanced contrast for long sessions.',
      'ArcadeA brighter, more saturated UI palette with energetic cyan accents.',
      'AuroraA neon-teal and violet variant with stronger contrast on buttons and headers.',
    ]);

    // (2) The state: one checked member, carrying both channels, and the mark excluded from the
    // accessibility tree so it is not announced twice.
    expect(themes.map((theme) => theme.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    const marks = document.querySelectorAll('.settings-choice-mark');
    expect(marks, 'the checked theme has no non-colour mark').toHaveLength(1);
    expect(marks[0]?.closest('button')).toBe(themes[0]);
    expect(marks[0]?.getAttribute('aria-hidden'), 'the mark would be announced as well as checked').toBe(
      'true',
    );

    // The accessible name is unchanged by the mark, because the mark is `aria-hidden`.
    expect(group.getByRole('radio', { name: /^Night/ })).toBe(themes[0]);

    // The Cozy parchment recipe is not reachable from the picker, and this phase
    // does not make it reachable.
    expect(document.body.textContent).not.toContain('Parchment');
  });
});

// ── 2. Names and values ────────────────────────────────────────────────────

describe('the controls', () => {
  it('gives every control an accessible name, and adds no unnamed one', () => {
    render(<AudioSettingsTab />);
    const panel = screen.getByRole('tabpanel', { name: 'Audio settings' });

    expect(screen.getByRole('switch', { name: 'Mute all sound' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Background music' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Sound effects' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Music volume' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Sound effects volume' })).toBeInTheDocument();

    // The sweep: every focusable thing the panel renders is one of those five, so a
    // control added without a name cannot join quietly. `role="switch"` and
    // `role="slider"` both replace the implicit `button` and `spinbutton`, so the
    // count is taken from the markup rather than from a role query.
    const interactive = panel.querySelectorAll(
      'button, input, select, textarea, a[href], [role], [tabindex]',
    );
    expect(Array.from(interactive)).toHaveLength(5);
    expect(screen.getAllByRole('switch')).toHaveLength(3);
    expect(screen.getAllByRole('slider')).toHaveLength(2);
  });

  it('exposes each volume as a number, as a percentage, and in plain sight', () => {
    render(<AudioSettingsTab />);

    const music = screen.getByRole('slider', { name: 'Music volume' });
    expect(music).toHaveAttribute('aria-valuemin', '0');
    expect(music).toHaveAttribute('aria-valuemax', '100');
    expect(music).toHaveAttribute('aria-valuenow', '40');
    expect(music).toHaveAttribute('aria-valuetext', '40%');
    expect(music).toHaveValue('40');

    const sfx = screen.getByRole('slider', { name: 'Sound effects volume' });
    expect(sfx).toHaveAttribute('aria-valuenow', '60');
    expect(sfx).toHaveAttribute('aria-valuetext', '60%');

    // The visible number, which is what a learner who cannot see the thumb reads.
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();
  });

  it('rounds a stored volume onto the slider step rather than handing the control a value off the grid', () => {
    // 0.375 is legal to the store and legal as a slider value, but it is not a whole
    // percent. The panel rounds before the value reaches the control, so the control
    // never has to snap one itself.
    usePreferencesStore.setState({ musicVolume: 0.375, sfxVolume: 0.07 });
    render(<AudioSettingsTab />);

    expect(screen.getByRole('slider', { name: 'Music volume' })).toHaveAttribute(
      'aria-valuenow',
      '38',
    );
    expect(screen.getByRole('slider', { name: 'Sound effects volume' })).toHaveAttribute(
      'aria-valuenow',
      '7',
    );
  });

  it('states the on/off state in a word, and keeps the switch name stable across the change', async () => {
    render(<AudioSettingsTab />);
    const music = screen.getByRole('switch', { name: 'Background music' });

    expect(music).toHaveTextContent('On');
    expect(music).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(music);

    // The state word is the non-colour signal; `aria-checked` is the machine one.
    // Neither of them changes what the switch is *called*, because a control whose
    // name changes when you toggle it is a control a screen reader has to re-find.
    expect(music).toHaveTextContent('Off');
    expect(music).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'Background music' })).toBe(music);

    // A language switch re-renders the panel, so the names a screen reader would
    // get in Spanish come from the registered keys rather than from hardcoded
    // English: this is the assertion that they are registered at all.
    await act(async () => {
      await i18n.changeLanguage('es');
    });
    expect(screen.getByRole('switch', { name: 'Silenciar todo el sonido' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Volumen de la música' })).toBeInTheDocument();
  });

  it('teaches the mute distinction in words, not only in three switches', () => {
    render(<AudioSettingsTab />);
    expect(helpTextFor(IDS.muteHelp)).toMatch(/remembered/i);
    expect(helpTextFor(IDS.muteHelp)).toMatch(/different choice/i);
    expect(helpTextFor(IDS.musicHelp)).toMatch(/separately from Mute/i);
    expect(helpTextFor(IDS.sfxHelp)).toMatch(/separately from Mute/i);
  });
});

// ── 3. Writing through the store ───────────────────────────────────────────

/**
 * Replace the five store actions with recording wrappers that still call the real
 * ones, so a test can assert *which* action ran and not merely that the state moved.
 */
function recordActions(): ActionCalls {
  const calls: ActionCalls = {
    setMusicVolume: [],
    setSfxVolume: [],
    setMuted: [],
    setMusicEnabled: [],
    setSfxEnabled: [],
  };
  usePreferencesStore.setState({
    setMusicVolume: (volume: number) => {
      calls.setMusicVolume.push([volume]);
      ORIGINAL_ACTIONS.setMusicVolume(volume);
    },
    setSfxVolume: (volume: number) => {
      calls.setSfxVolume.push([volume]);
      ORIGINAL_ACTIONS.setSfxVolume(volume);
    },
    setMuted: (muted: boolean) => {
      calls.setMuted.push([muted]);
      ORIGINAL_ACTIONS.setMuted(muted);
    },
    setMusicEnabled: (enabled: boolean) => {
      calls.setMusicEnabled.push([enabled]);
      ORIGINAL_ACTIONS.setMusicEnabled(enabled);
    },
    setSfxEnabled: (enabled: boolean) => {
      calls.setSfxEnabled.push([enabled]);
      ORIGINAL_ACTIONS.setSfxEnabled(enabled);
    },
  });
  return calls;
}

describe('writing through the store', () => {
  it('calls one store action per control, and only that one', () => {
    const calls = recordActions();
    render(<AudioSettingsTab />);

    fireEvent.click(screen.getByRole('switch', { name: 'Mute all sound' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Background music' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Sound effects' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Music volume' }), { target: { value: '25' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Sound effects volume' }), {
      target: { value: '75' },
    });

    expect(calls.setMuted).toEqual([[true]]);
    expect(calls.setMusicEnabled).toEqual([[false]]);
    expect(calls.setSfxEnabled).toEqual([[false]]);
    expect(calls.setMusicVolume).toEqual([[0.25]]);
    expect(calls.setSfxVolume).toEqual([[0.75]]);
    expect(audioState()).toEqual({
      musicVolume: 0.25,
      sfxVolume: 0.75,
      muted: true,
      musicEnabled: false,
      sfxEnabled: false,
    });
  });

  it('shows what the store holds, not what the control last asked for', () => {
    usePreferencesStore.setState({ musicVolume: 0.9, sfxVolume: 0.1, muted: true });
    render(<AudioSettingsTab />);

    expect(screen.getByRole('slider', { name: 'Music volume' })).toHaveAttribute(
      'aria-valuenow',
      '90',
    );
    expect(screen.getByRole('slider', { name: 'Sound effects volume' })).toHaveAttribute(
      'aria-valuenow',
      '10',
    );
    expect(screen.getByRole('switch', { name: 'Mute all sound' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByText(/Muted now\./)).toBeInTheDocument();
  });
});

// ── 4. The mute distinction ────────────────────────────────────────────────

describe('mute is not a bus toggle', () => {
  it('leaves both per-bus choices and both volumes alone', () => {
    const calls = recordActions();
    render(<AudioSettingsTab />);

    fireEvent.change(screen.getByRole('slider', { name: 'Music volume' }), { target: { value: '20' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Sound effects volume' }), {
      target: { value: '80' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Background music' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Mute all sound' }));

    // The preference the learner actually expressed, plus the mute on top of it.
    expect(audioState()).toEqual({
      musicVolume: 0.2,
      sfxVolume: 0.8,
      musicEnabled: false,
      sfxEnabled: true,
      muted: true,
    });

    // Muting called exactly one action, and un-muting restored nothing but the mute.
    expect(calls.setMuted).toEqual([[true]]);
    fireEvent.click(screen.getByRole('switch', { name: 'Mute all sound' }));
    expect(calls.setMuted).toEqual([[true], [false]]);
    expect(audioState()).toEqual({
      musicVolume: 0.2,
      sfxVolume: 0.8,
      musicEnabled: false,
      sfxEnabled: true,
      muted: false,
    });
  });

  it('keeps a volume slider reachable while its bus is off', () => {
    usePreferencesStore.setState({ musicEnabled: false, sfxEnabled: false });
    render(<AudioSettingsTab />);

    const music = screen.getByRole('slider', { name: 'Music volume' });
    expect(music).not.toBeDisabled();
    // A disabled control is one a keyboard user has to go looking for, and a
    // learner who has music off is exactly the person who wants to set the level
    // for next time.
    expect(music).not.toHaveAttribute('aria-disabled');
    music.focus();
    expect(music).toHaveFocus();
    fireEvent.change(music, { target: { value: '10' } });
    expect(usePreferencesStore.getState().musicVolume).toBe(0.1);
  });
});

// ── 5. Persistence ─────────────────────────────────────────────────────────

describe('persistence', () => {
  it('persists the whole payload, audio fields and the pre-existing theme key together', () => {
    render(<AudioSettingsTab />);
    fireEvent.click(screen.getByRole('switch', { name: 'Mute all sound' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Music volume' }), { target: { value: '30' } });

    const payload = persistedPayload();
    expect(payload).toMatchObject({
      musicVolume: 0.3,
      sfxVolume: 0.6,
      muted: true,
      musicEnabled: true,
      sfxEnabled: true,
      // The Phase 4 field is still there: an audio write must not drop it.
      colorTheme: 'dark',
      graphicsMode: 'rpg',
    });
  });

  it('brings every audio preference back after a reload', async () => {
    render(<AudioSettingsTab />);
    fireEvent.click(screen.getByRole('switch', { name: 'Mute all sound' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Sound effects' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Music volume' }), { target: { value: '30' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Sound effects volume' }), {
      target: { value: '90' },
    });
    cleanup();

    // A page load, from the store's point of view: a fresh module reading the
    // payload the surface just wrote.
    vi.resetModules();
    const reloaded = await import('@/store/preferencesStore');
    reloaded.usePreferencesStore
      .getState()
      .hydratePreferences(reloaded.__testing.readPersistedPreferences());

    const state = reloaded.usePreferencesStore.getState();
    expect(state.muted).toBe(true);
    expect(state.musicVolume).toBe(0.3);
    expect(state.sfxVolume).toBe(0.9);
    expect(state.musicEnabled).toBe(true);
    expect(state.sfxEnabled).toBe(false);
    expect(state.colorTheme).toBe('dark');
  });

  it('keeps its values when the panel is unmounted and opened again', () => {
    const { unmount } = render(<AudioSettingsTab />);
    fireEvent.click(screen.getByRole('switch', { name: 'Mute all sound' }));
    unmount();

    render(<AudioSettingsTab />);
    // Nothing here holds a copy: the panel is a view of a store that outlives it,
    // which is what "survives a route change" means for a control panel.
    expect(screen.getByRole('switch', { name: 'Mute all sound' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});

// ── 6. Control panel, not player ───────────────────────────────────────────

const COMPONENT_SOURCE = readFileSync(
  join(process.cwd(), 'src', 'ui', 'components', 'AudioSettingsTab.tsx'),
  'utf8',
);

describe('the surface does not start audio', () => {
  it('creates no AudioContext and adds no gesture listener while being used', () => {
    let constructed = 0;
    const globals = globalThis as unknown as Record<string, unknown>;
    const previous = globals.AudioContext;
    class CountingAudioContext {
      constructor() {
        constructed += 1;
      }
    }
    globals.AudioContext = CountingAudioContext;

    const gestureListeners: string[] = [];
    const addSpy = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation(((
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if ((GESTURE_EVENTS as readonly string[]).includes(type) && options !== false) {
          gestureListeners.push(type);
        }
        return EventTarget.prototype.addEventListener.call(window, type, listener, options);
      }) as typeof window.addEventListener);

    try {
      render(<AudioSettingsTab />);
      fireEvent.click(screen.getByRole('switch', { name: 'Mute all sound' }));
      fireEvent.click(screen.getByRole('switch', { name: 'Background music' }));
      fireEvent.change(screen.getByRole('slider', { name: 'Music volume' }), {
        target: { value: '55' },
      });
      fireEvent.keyDown(window, { key: 'Enter' });

      expect(constructed, 'the surface constructed an AudioContext').toBe(0);
      expect(gestureListeners, 'the surface registered a gesture listener').toEqual([]);
      expect(audioManager.getState().unlocked, 'audio became unlocked').toBe(false);
    } finally {
      addSpy.mockRestore();
      if (previous === undefined) delete globals.AudioContext;
      else globals.AudioContext = previous;
    }
  });

  it('does not import the audio service, and implements no keyboard handling of its own', () => {
    // The runtime check above passes on a surface that unlocks audio from a click
    // only in the sense that the browser would also have blocked it. These are the
    // structural claims the phase actually turns on.
    expect(COMPONENT_SOURCE).not.toMatch(/from '@\/services\/audioManager'/);
    expect(COMPONENT_SOURCE).not.toMatch(/from '@\/services\/audio/);
    for (const call of ['unlock(', 'playBgm(', 'playSfx(', 'new AudioContext', 'webkitAudioContext']) {
      expect(COMPONENT_SOURCE, `the source calls ${call}`).not.toContain(call);
    }
    for (const event of ['GestureEvent', 'addEventListener', 'onKeyDown', 'onKeyUp', 'keydown']) {
      expect(COMPONENT_SOURCE, `the source handles ${event}`).not.toContain(event);
    }
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', "'Home'", "'End'"]) {
      expect(COMPONENT_SOURCE, `the source reimplements ${key}`).not.toContain(key);
    }
  });

  it('uses platform controls, so the platform owns the keyboard', () => {
    render(<AudioSettingsTab />);

    // jsdom has no native range keyboard behaviour, so what can be asserted is the
    // shape that inherits it, plus the fact that nothing here took it over.
    for (const name of ['Music volume', 'Sound effects volume']) {
      const slider = screen.getByRole('slider', { name });
      expect(slider.tagName).toBe('INPUT');
      expect(slider).toHaveAttribute('type', 'range');
    }
    for (const name of ['Mute all sound', 'Background music', 'Sound effects']) {
      const control = screen.getByRole('switch', { name });
      expect(control.tagName).toBe('BUTTON');
      expect(control).toHaveAttribute('type', 'button');
    }

    const music = screen.getByRole('slider', { name: 'Music volume' });
    fireEvent.keyDown(music, { key: 'ArrowRight' });
    expect(usePreferencesStore.getState().musicVolume).toBe(0.4);
  });
});

// ── 7. Identifiers and learner data ────────────────────────────────────────

describe('identifiers', () => {
  it('uses fixed ids, and puts no learner data in any attribute value', () => {
    // Planted, so the assertion below is not vacuous: a surface that rendered
    // nothing of this would pass a check that nothing of this is rendered.
    usePreferencesStore.setState({ activeSpritePack: LEARNER_MARKER, colorTheme: 'dark' });
    render(<AudioSettingsTab />);

    const panel = screen.getByRole('tabpanel', { name: 'Audio settings' });
    expect(panel.querySelector(`#${IDS.mute}`)).not.toBeNull();
    expect(panel.querySelector(`#${IDS.music}`)).not.toBeNull();
    expect(panel.querySelector(`#${IDS.sfx}`)).not.toBeNull();
    expect(panel.querySelector(`#${IDS.musicVolume}`)).not.toBeNull();
    expect(panel.querySelector(`#${IDS.sfxVolume}`)).not.toBeNull();

    const attributes = ['id', 'name', 'for', 'title', 'aria-label', 'aria-labelledby', 'aria-describedby'];
    const values: string[] = [];
    for (const element of Array.from(panel.querySelectorAll('*'))) {
      for (const attribute of attributes) {
        const value = element.getAttribute(attribute);
        if (value !== null) values.push(value);
      }
    }
    expect(values.length, 'the panel exposed no id-like attributes at all').toBeGreaterThan(5);
    for (const value of values) {
      expect(value, `an attribute value carried learner data: ${value}`).not.toContain(
        LEARNER_MARKER,
      );
      // Every one is a fixed identifier or one of the component's own fixed words.
      expect(value).toMatch(/^settings-audio-[a-z-]+$|^Audio settings$|^[a-z-]+$/);
    }
  });
});

// ── 8. The panel's own stylesheet ──────────────────────────────────────────

const STYLESHEET = readFileSync(
  join(process.cwd(), 'src', 'ui', 'components', 'audioSettings.css'),
  'utf8',
);

/** The stylesheet with its comments removed, so prose cannot pass for a selector. */
function stylesheetBody(): string {
  return STYLESHEET.replace(/\/\*[\s\S]*?\*\//g, '');
}

interface StyleRule {
  readonly selector: string;
  readonly body: string;
}

/**
 * Every style rule in the sheet, at-rule preludes skipped and at-rule bodies
 * descended into.
 *
 * A regex over `selector {` would report `@media (forced-colors: active)` as a
 * selector and then fail the scoping check for a rule that is not a rule.
 */
function styleRules(source: string): StyleRule[] {
  const found: StyleRule[] = [];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('{', index);
    if (open === -1) break;
    const prelude = source.slice(index, open).trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1;
      else if (source[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    const body = source.slice(open + 1, cursor - 1);
    if (prelude.startsWith('@')) found.push(...styleRules(body));
    else found.push({ selector: prelude, body });
    index = cursor;
  }
  return found;
}

describe('the audio panel stylesheet', () => {
  it('scopes every rule to the panel, and adds no colour of its own', () => {
    const body = stylesheetBody();
    const rules = styleRules(body);
    expect(rules.length).toBeGreaterThan(5);
    for (const rule of rules) {
      for (const part of rule.selector.split(',').map((entry) => entry.trim())) {
        expect(part, `${part} is not scoped to the panel`).toContain('.kd-audio-settings');
      }
    }
    // No new colour pair means no new contrast figure to keep in step: every colour
    // is a custom property the four themes already define.
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(body).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
    expect(body).not.toContain('@font-face');
  });

  it('signals the on state without relying on colour', () => {
    const onState = styleRules(stylesheetBody()).find((rule) =>
      rule.selector.includes("[aria-checked='true']"),
    );
    expect(onState, 'no aria-checked styling for the switch').toBeDefined();
    // The two shapes COZY_STATE_SIGNALS.selected declares, plus the border the
    // control can carry, all declared on the one rule.
    expect(onState?.body).toMatch(/font-weight:\s*700/);
    expect(onState?.body).toMatch(/box-shadow:\s*inset 0 -3px 0 0/);
    expect(onState?.body).toMatch(/border-width:/);
  });

  it('gives every control a focus ring, a 44-pixel target, and no motion to reduce', () => {
    const body = stylesheetBody();
    for (const control of ['kd-audio-switch', 'kd-audio-range']) {
      expect(body, `${control} has no focus ring`).toMatch(
        new RegExp(`\\.${control}[^{}]*:focus-visible`),
      );
      expect(body, `${control} has no 44-pixel floor`).toMatch(
        new RegExp(`\\.${control}[^{}]*\\{[^}]*min-block-size:\\s*var\\(--cozy-s-target-min, 44px\\)`),
      );
    }
    expect(body).toMatch(/outline: var\(--cozy-s-focus-ring-width, 3px\)/);

    // The only motion the panel can have is what the shell stylesheet puts on every
    // button, and this collapses it for the flag-off build the way the Cozy layer
    // collapses it for the flag-on one.
    const withoutReducedMotion = body.replace(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/,
      '',
    );
    expect(withoutReducedMotion).not.toMatch(/\b(transition|animation):/);
    expect(body).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(body).toMatch(/transition: none !important/);
  });

  it('repeats its own class so the shell stylesheet cannot outrank it', () => {
    // `:root[data-graphics='rpg'] button` is (0,2,1) and beats a plain
    // `.kd-audio-settings .kd-audio-switch` at (0,2,0). tests/unit/dataCenter.test.tsx
    // found that collision by measuring a real build; the doubling is the fix.
    const body = stylesheetBody();
    for (const control of ['kd-audio-switch', 'kd-audio-range', 'kd-audio-group']) {
      expect(body, `${control} is not doubled`).toContain(
        `.kd-audio-settings .${control}.${control}`,
      );
    }
  });
});

// ── 9. Translations ────────────────────────────────────────────────────────

/** Every `settings.audio*` key registered in a locale, flattened. */
function enKeysStartingWith(prefix: string): string[] {
  const en = JSON.parse(
    readFileSync(join(process.cwd(), 'src', 'i18n', 'locales', 'en.json'), 'utf8'),
  ) as { settings: Record<string, unknown> };
  return Object.keys(en.settings)
    .filter((key) => key.startsWith(prefix))
    .map((key) => `settings.${key}`);
}

describe('the strings', () => {
  it('registers every key the panel uses, with the inline fallback as its English value', async () => {
    const en = (await import('@/i18n/locales/en.json')).default as unknown as {
      settings: Record<string, unknown> & { tabs: Record<string, string> };
    };
    const es = (await import('@/i18n/locales/es.json')).default as unknown as {
      settings: Record<string, unknown> & { tabs: Record<string, string> };
    };

    // Every `t('settings.…', 'fallback')` pair in the two components, read from the
    // source rather than from a list written here, so a key added without a
    // registration fails and a registration nobody uses is visible.
    const SETTINGS_MODAL_SOURCE = readFileSync(
      join(process.cwd(), 'src', 'ui', 'components', 'SettingsModal.tsx'),
      'utf8',
    );
    const tabLabels = Array.from(
      SETTINGS_MODAL_SOURCE.matchAll(
        /\{ id: '[a-z]+', label: '([^']+)', labelKey: '(settings\.tabs\.[a-z]+)' \}/g,
      ),
    ).map((match) => [match[0], match[2], match[1]] as unknown as RegExpMatchArray);

    const pairs: RegExpMatchArray[] = [
      ...Array.from(
        COMPONENT_SOURCE.matchAll(/\bt\(\s*'(settings\.[a-zA-Z.]+)'\s*,\s*'((?:[^'\\]|\\.)*)'/g),
      ),
      ...Array.from(
        SETTINGS_MODAL_SOURCE.matchAll(
          /\bt\(\s*'(settings\.[a-zA-Z.]+)'\s*,\s*'((?:[^'\\]|\\.)*)'/g,
        ),
      ),
      // The four tab labels are rendered through `t(tab.labelKey, tab.label)`, so
      // their key and their fallback live in the tab table rather than at a call
      // site. Read from that table so a tab added without a key fails here.
      ...tabLabels,
    ];
    expect(pairs.length, 'no translated settings strings were found').toBeGreaterThan(10);

    const read = (source: typeof en, key: string): unknown =>
      key.split('.').reduce<unknown>((node, part) => {
        if (node === null || typeof node !== 'object') return undefined;
        return (node as Record<string, unknown>)[part];
      }, source);

    // The keys this phase added. Everything under `settings.audio` and the four tab
    // labels have to be registered in both locales and to agree with their inline
    // fallback, because a fallback that has drifted is a string that only exists in
    // one of the two places.
    //
    // The pre-existing settings strings are deliberately not policed here. Two of
    // them would fail such a check - `settings.makeItYours` is rendered with an
    // inline fallback and is not registered in either locale, and
    // `settings.resetDefaults` is called twice with two different fallbacks, so its
    // `aria-label` renders as "Reset Defaults" rather than the longer sentence the
    // call site asks for. Both predate this phase and both are the maintainer's to
    // take rather than this file to quietly change.
    const addedKeys = new Set([
      'settings.tabs.theme',
      'settings.tabs.language',
      'settings.tabs.shortcuts',
      'settings.tabs.audio',
      ...enKeysStartingWith('audio'),
    ]);
    expect(addedKeys.size, 'no audio keys were found in en.json').toBeGreaterThan(10);

    for (const key of addedKeys) {
      const registered = read(en, key);
      expect(typeof registered, `en.json is missing ${key}`).toBe('string');
      expect(typeof read(es, key), `es.json is missing ${key}`).toBe('string');
      const used = pairs.find(([, candidate]) => candidate === key);
      expect(used, `${key} is registered but nothing renders it`).toBeDefined();
      expect(registered, `en.${key} drifted from its inline fallback`).toBe(
        (used?.[2] as string).replace(/\\'/g, "'"),
      );
    }
  });
});
