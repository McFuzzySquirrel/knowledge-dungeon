/**
 * The two renderer normalizers' own answer to "which `event.key` spellings mean space".
 *
 * ## Why this file reads source rather than importing it
 *
 * The renderer modules are inside `src/renderers/**`, which Phase 21's DOM half may not edit and which
 * importing into a component test would pull PixiJS into the jsdom environment. So the spellings are
 * read out of the two `normalizeKey` functions' source text.
 *
 * That is a deliberate trade and it has a cost worth stating: a source read cannot see a normalizer
 * that stops being a literal comparison - a table lookup, say. The cost is accepted because the
 * alternative - a test that restates the same three strings as the implementation - proves nothing
 * at all. The property being asserted is "the DOM control accepts every spelling the renderer
 * accepts", and only reading the renderer can establish it.
 *
 * The right long-term shape is a shared table both sides import. That is recorded here as the
 * follow-up rather than done, because introducing it means editing renderer files.
 */

/** One `key === '<literal>'` comparison in a renderer normalizer. */
export interface NormalizerReading {
  /** The file the normalizer lives in, repository-relative. */
  readonly file: string;
  /** Every `key === '<literal>'` comparison in the function body, in source order. */
  readonly literals: readonly string[];
}

/** The two renderer normalizers that map an `event.key` onto the DOM control's own vocabulary. */
export const SPACE_KEY_NORMALIZER_FILES: readonly string[] = Object.freeze([
  'src/renderers/pixi/fishing/createFishingScene.ts',
  'src/renderers/pixi/input/WorldInputController.ts',
]);

/**
 * The three spellings a space-bar keydown can arrive as.
 *
 * Written out rather than derived, because this is the **requirement**, not a restatement: the
 * current specification says `' '`, old Edge and IE said `'Spacebar'`, and `'Space'` is what several
 * engines and configurations produce - and all three are spellings the renderer already accepts.
 * Membership is checked against this, and this is checked against what the renderers accept, so both
 * directions are covered and neither is self-referential.
 */
export const REQUIRED_SPACE_KEYS: readonly string[] = Object.freeze([' ', 'Spacebar', 'Space']);

/**
 * Every `key === '<literal>'` comparison inside one file's `normalizeKey`.
 *
 * Scoped to the function body so a `key === 'Escape'` elsewhere in a 1,200-line scene file is not
 * reported as a space-bar spelling. The body's end is located by the closing brace at column zero,
 * which is how this repository writes every one of these functions.
 *
 * @throws when the file has no `normalizeKey`, or its body cannot be located. Throwing rather than
 *   returning an empty list is the point: an empty list would make "the DOM accepts everything the
 *   renderer accepts" vacuously true, which is the shape of a gate that passes because it measured
 *   nothing.
 */
export function readNormalizerLiterals(source: string, file: string): NormalizerReading {
  const start = source.indexOf('function normalizeKey(');
  if (start < 0) throw new Error(`${file}: no normalizeKey function to compare against`);
  const end = source.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`${file}: normalizeKey has no closing brace at column zero`);
  const body = source.slice(start, end);
  const literals = [...body.matchAll(/key\s*===\s*'([^']*)'/g)].map((match) => match[1] ?? '');
  // Non-vacuity: a normalizer that read as zero comparisons means the scan is looking at the wrong
  // text, and reporting that as "the DOM accepts everything" would be a green lie.
  if (literals.length === 0) throw new Error(`${file}: normalizeKey body yielded no key comparisons`);
  return { file, literals };
}
