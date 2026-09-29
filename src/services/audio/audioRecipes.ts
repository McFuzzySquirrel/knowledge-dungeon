/**
 * The shipped sound of the game, as data.
 *
 * ## Why recipes rather than files
 *
 * Phase 10 requires CC0-only media, and `scripts/check-cc0-assets.mjs` reports
 * `cc0-approved: 0` today: every one of the 90 registered files is
 * `legacy-unverified`, which is exactly the class the gate refuses to put in a
 * bundle. Shipping an audio binary in that state would have required either
 * laundering a provenance class the gate deliberately does not allow itself to
 * upgrade, or authoring media in a phase whose non-goals are "no music
 * composition workflow" and "no final world-specific asset production".
 *
 * So the shipped default is *synthesis*, and this module is the synthesis. The
 * provenance registry already has a class for this: `procedural`, meaning the
 * bytes are produced by committed code rather than copied from a third party,
 * so no external licence attaches. That is a truthful classification for a
 * waveform defined by an oscillator and an envelope in source.
 *
 * The alternative - a file-backed backend - is implemented alongside this one
 * (`src/services/audio/fileBackend.ts`) and takes over the moment a real CC0
 * recording is registered, without changing this table or the manager's public
 * surface. Nothing here is a place a licence string has to be remembered,
 * because there is nothing here to license.
 *
 * ## Why one recipe per id and not one generic blip
 *
 * The id space is closed and small - three tracks, seventeen effects - and every
 * id already has a name that says what it is (`fish-catch` is not
 * `fish-splash`). A single shared "click" would have made those ids cosmetic.
 * Each recipe below therefore differs in envelope, pitch and timbre from every
 * other, which is what lets a learner tell a correct catch from a miss by ear
 * alone before the on-screen result appears.
 *
 * Everything in this module is a pure constant. No clock, no randomness, no
 * `Math.random`, no learner data: the same id produces the same waveform on every
 * device, which is what lets a test assert on the recipe rather than on captured
 * audio, and which keeps this module trivially renderer-neutral.
 */

/** A waveform type, named without depending on a global constructor. */
export type AudioWaveform = 'sine' | 'triangle' | 'sawtooth' | 'square';

/**
 * One shaped tone.
 *
 * `endHz` glides the pitch across the tone's life, which is how a recipe gets a
 * rising "caught it" or a falling "missed it" without a second node.
 */
export interface SfxVoice {
  readonly waveform: AudioWaveform;
  readonly startHz: number;
  readonly endHz: number;
  /** Delay from the start of the effect, for a chord or a two-hit rhythm. */
  readonly offsetSeconds: number;
  readonly durationSeconds: number;
  /** Amplitude of this voice, relative to the effect's own bus. */
  readonly peak: number;
  /** Linear fade-in. `0` is a percussive start, which most UI sounds want. */
  readonly attackSeconds: number;
}

/** A sustained voice under a background track. */
export interface PadVoice {
  readonly waveform: AudioWaveform;
  readonly frequencyHz: number;
  /** Small offsets in cents. Unison tones alone sound like a test tone. */
  readonly detuneCents: number;
  readonly peak: number;
}

/**
 * A background track: a sustained bed plus a repeating figure.
 *
 * The figure is cycled rather than composed, which is what keeps "no music
 * composition workflow" honest - there is no bar structure to author, export, or
 * review, only a table of pitches and a step time.
 */
export interface MusicRecipe {
  readonly padVoices: readonly PadVoice[];
  /** Rate of the amplitude drift that keeps the bed from sounding like a held note. */
  readonly lfoHz: number;
  /** Depth of that drift, relative to the bed's own peak. */
  readonly lfoDepth: number;
  /** Pitches cycled by the figure, in Hz. */
  readonly figureHz: readonly number[];
  readonly figureIntervalSeconds: number;
  readonly figureWaveform: AudioWaveform;
  readonly figurePeak: number;
  readonly figureSeconds: number;
}

/** Shorthand for a percussive tone, which is most of what SFX is. */
function voice(
  waveform: AudioWaveform,
  startHz: number,
  durationSeconds: number,
  peak: number,
  overrides: Partial<Omit<SfxVoice, 'waveform' | 'startHz' | 'durationSeconds' | 'peak'>> = {},
): SfxVoice {
  return {
    waveform,
    startHz,
    endHz: startHz,
    offsetSeconds: 0,
    durationSeconds,
    peak,
    attackSeconds: 0,
    ...overrides,
  };
}

// ── Background tracks ─────────────────────────────────────────────────────

/** The three built-in tracks, keyed by the ids the legacy callers already pass. */
export const MUSIC_RECIPES: Readonly<Record<string, MusicRecipe>> = {
  // Outdoors and unhurried: a major triad with a long, even figure.
  'bgm-village': {
    padVoices: [
      { waveform: 'triangle', frequencyHz: 110, detuneCents: 0, peak: 0.5 },
      { waveform: 'triangle', frequencyHz: 164.81, detuneCents: 4, peak: 0.38 },
      { waveform: 'sine', frequencyHz: 220, detuneCents: -5, peak: 0.26 },
      { waveform: 'sine', frequencyHz: 277.18, detuneCents: 6, peak: 0.16 },
    ],
    lfoHz: 0.08,
    lfoDepth: 0.22,
    figureHz: [440, 554.37, 659.25, 554.37],
    figureIntervalSeconds: 0.9,
    figureWaveform: 'triangle',
    figurePeak: 0.22,
    figureSeconds: 0.75,
  },
  // Enclosed and slightly uneasy: a minor triad, low, with a slow figure.
  'bgm-dungeon': {
    padVoices: [
      { waveform: 'sine', frequencyHz: 73.42, detuneCents: 0, peak: 0.55 },
      { waveform: 'triangle', frequencyHz: 110, detuneCents: -6, peak: 0.4 },
      { waveform: 'triangle', frequencyHz: 146.83, detuneCents: 7, peak: 0.24 },
      { waveform: 'sine', frequencyHz: 174.61, detuneCents: -3, peak: 0.14 },
    ],
    lfoHz: 0.05,
    lfoDepth: 0.3,
    figureHz: [146.83, 174.61, 220, 174.61, 146.83, 130.81],
    figureIntervalSeconds: 1.1,
    figureWaveform: 'sine',
    figurePeak: 0.2,
    figureSeconds: 0.9,
  },
    // Tense and close: the same bed compressed into a minor second, moving fast.
  'bgm-boss': {
    padVoices: [
      { waveform: 'sawtooth', frequencyHz: 55, detuneCents: 0, peak: 0.32 },
      { waveform: 'sawtooth', frequencyHz: 82.41, detuneCents: 8, peak: 0.26 },
      { waveform: 'triangle', frequencyHz: 116.54, detuneCents: -9, peak: 0.22 },
      { waveform: 'sine', frequencyHz: 123.47, detuneCents: 5, peak: 0.18 },
    ],
    lfoHz: 0.14,
    lfoDepth: 0.18,
    figureHz: [110, 138.59, 164.81, 138.59],
    figureIntervalSeconds: 0.55,
    figureWaveform: 'square',
    figurePeak: 0.12,
    figureSeconds: 0.4,
  },
};

// ── Sound effects ─────────────────────────────────────────────────────────

/**
 * One recipe per effect id.
 *
 * The table is keyed by the closed `SfxKind` union rather than typed as one, so
 * a lookup for an id the compiler accepts can still miss at runtime if the table
 * and the union ever drift apart. The manager treats a miss as "no sound" instead
 * of a crash; `tests/unit/audioManager.test.ts` asserts the table covers the union
 * so the drift is caught where it happens.
 */
export const SFX_RECIPES: Readonly<Record<string, readonly SfxVoice[]>> = {
  // Interface: quiet, short, and pitched the same way across click and hover, so
  // a screen reader user and a sighted user get one interface, not two.
  'ui-click': [voice('triangle', 880, 0.07, 0.5)],
  'ui-hover': [voice('sine', 1320, 0.05, 0.22)],

  // Encounters: a rising third for the start, a settled fifth for success.
  'encounter-start': [
    voice('triangle', 220, 0.18, 0.45, { endHz: 330 }),
    voice('sine', 440, 0.2, 0.2, { offsetSeconds: 0.1 }),
  ],
  'encounter-success': [
    voice('triangle', 392, 0.16, 0.42),
    voice('triangle', 587.33, 0.28, 0.38, { offsetSeconds: 0.12 }),
  ],

  // Progression: a small two-step climb. Ascending, because it is a reward.
  'xp-earn': [
    voice('square', 659.25, 0.08, 0.24),
    voice('square', 987.77, 0.12, 0.2, { offsetSeconds: 0.07 }),
  ],
  'artifact-collect': [
    voice('sine', 523.25, 0.12, 0.4),
    voice('sine', 783.99, 0.16, 0.3, { offsetSeconds: 0.09 }),
    voice('sine', 1046.5, 0.24, 0.22, { offsetSeconds: 0.18 }),
  ],

  // Characters: a soft, breathy double tone. Deliberately unlike a reward.
  'npc-greet': [
    voice('sine', 392, 0.14, 0.32, { attackSeconds: 0.03 }),
    voice('sine', 466.16, 0.18, 0.24, { offsetSeconds: 0.11, attackSeconds: 0.03 }),
  ],
  'door-open': [
    voice('sine', 180, 0.4, 0.35, { endHz: 320, attackSeconds: 0.05 }),
  ],

  // Threat: the only square wave in the set, and the loudest.
  'boss-encounter': [
    voice('square', 110, 0.5, 0.4, { endHz: 82.41 }),
    voice('sawtooth', 220, 0.45, 0.22, { endHz: 164.81 }),
  ],
  // A four-note climb, but from a fourth above the catch so the two rewards are
  // distinguishable: `fish-catch` is what a good minute sounds like, this is what a
  // rarer milestone sounds like, and they must not be the same four pitches.
  'achievement-unlock': [
    voice('triangle', 587.33, 0.12, 0.4),
    voice('triangle', 698.46, 0.12, 0.36, { offsetSeconds: 0.1 }),
    voice('triangle', 880, 0.12, 0.34, { offsetSeconds: 0.2 }),
    voice('sine', 1174.66, 0.5, 0.3, { offsetSeconds: 0.3, attackSeconds: 0.02 }),
  ],

  // Rewards: bright, with a shimmer above the main pitch.
  'loot-drop': [
    voice('triangle', 659.25, 0.12, 0.36, { endHz: 880 }),
    voice('sine', 1760, 0.18, 0.14, { offsetSeconds: 0.06 }),
  ],
  'portal-enter': [
    voice('sine', 220, 0.55, 0.34, { endHz: 880, attackSeconds: 0.08 }),
    voice('sine', 330, 0.5, 0.16, { endHz: 1320, attackSeconds: 0.08 }),
  ],

  // The fishing loop, which is the one a learner hears most often. Each step is
  // shaped by what happens next: the cast is a falling whoosh, the splash is
  // noise-like and short, the bite is two taps, the reel rises, the catch is a
  // wide major chord, and the miss is the same descent as the cast but longer
  // and lower, so "nothing happened" does not sound like "something happened".
  'fish-cast': [
    voice('sine', 900, 0.28, 0.4, { endHz: 220, attackSeconds: 0.02 }),
    voice('triangle', 300, 0.18, 0.16, { offsetSeconds: 0.2, endHz: 180 }),
  ],
  'fish-splash': [
    voice('sine', 1400, 0.16, 0.42, { endHz: 500 }),
    voice('triangle', 700, 0.12, 0.24, { offsetSeconds: 0.04, endHz: 260 }),
  ],
  'fish-bite': [
    voice('square', 1046.5, 0.05, 0.3),
    voice('square', 1318.51, 0.07, 0.26, { offsetSeconds: 0.08 }),
  ],
  'fish-reel': [
    voice('triangle', 392, 0.42, 0.34, { endHz: 784, attackSeconds: 0.03 }),
  ],
  'fish-catch': [
    voice('triangle', 523.25, 0.14, 0.42),
    voice('triangle', 659.25, 0.16, 0.38, { offsetSeconds: 0.09 }),
    voice('triangle', 783.99, 0.2, 0.36, { offsetSeconds: 0.18 }),
    voice('sine', 1046.5, 0.45, 0.26, { offsetSeconds: 0.26, attackSeconds: 0.02 }),
  ],
  'fish-miss': [
    voice('sine', 440, 0.45, 0.32, { endHz: 174.61, attackSeconds: 0.04 }),
    voice('triangle', 220, 0.4, 0.18, { endHz: 110 }),
  ],
};
