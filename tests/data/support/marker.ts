/**
 * The synthetic learner-content marker for the Phase 5 data-product gate.
 *
 * One distinctive token is planted, in one go, into every field a learner can
 * author: a subject name, a room topic, a note body, an artifact, a custom
 * sprite's body, an attachment filename, and an attachment's alt text. Every
 * sanitized surface the backup product produces - the `manifest.json` member,
 * the import result, a typed error, an evidence record, a member path - is then
 * required to be free of it.
 *
 * Why one marker rather than a forbidden-word list: a forbidden-word list is
 * satisfied by a surface that carries no data at all, which is exactly the
 * vacuous case. The suite additionally asserts, for every surface, that the
 * record genuinely *contained* the marker before the absence was checked, so
 * "the marker is absent" cannot be explained by "the marker was never there".
 *
 * The marker is synthetic and self-describing. It names no real subject, no
 * real learner, and no real host. The only host used anywhere in this suite is
 * the reserved `example.invalid`.
 */

/** The single distinctive token. Nothing else in the repository contains it. */
export const MARKER_TOKEN = 'KD5MARKER9c41d0e7';

/** Planted as the synthetic subject name. */
export const MARKER_SUBJECT_NAME = `Synthetic Data Gate Subject ${MARKER_TOKEN}`;

/** Planted as a synthetic room topic. */
export const MARKER_ROOM_TOPIC = `Synthetic Data Gate Room Topic ${MARKER_TOKEN}`;

/** Planted as a synthetic note body. */
export const MARKER_NOTE_BODY = [
  `Synthetic note body for the Phase 5 data gate ${MARKER_TOKEN}.`,
  '',
  'Key Points',
  `- Preserve ${MARKER_TOKEN} through export and import.`,
  '',
  'Recall Question',
  `What must survive? ${MARKER_TOKEN}`,
].join('\n');

/** Planted as a synthetic artifact body. */
export const MARKER_ARTIFACT_BODY = `# Synthetic artifact ${MARKER_TOKEN}\n\nArtifact body only.\n`;

/** Planted as a synthetic attachment filename. */
export const MARKER_ATTACHMENT_FILE_NAME = `synthetic-${MARKER_TOKEN}-image.png`;

/** Planted as a synthetic attachment alt text. */
export const MARKER_ATTACHMENT_ALT_TEXT = `synthetic alt text ${MARKER_TOKEN}`;

/** Planted inside a custom sprite's SVG body, which is never parsed. */
export const MARKER_SPRITE_BODY =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" data-marker="${MARKER_TOKEN}">` +
  `<title>synthetic sprite ${MARKER_TOKEN}</title><rect width="8" height="8" fill="#8a6f4e"/></svg>`;

/**
 * Every literal that must never appear on a sanitized surface.
 *
 * The token is the load-bearing entry. The others are the *field names* and
 * filename fragments a leaked record would plausibly carry, and they are listed
 * so a failure message can name the surface without repeating its contents.
 */
export const FORBIDDEN_FRAGMENTS: readonly string[] = [
  MARKER_TOKEN,
  MARKER_ATTACHMENT_FILE_NAME,
  'synthetic-9c41d0e7',
  'subjectName',
  'noteText',
  'artifactMarkdown',
  'fileName',
  'altText',
  'externalUrl',
  'example.invalid',
];

/**
 * Every sanitized fragment found in `text`, sorted.
 *
 * A sanitizer by exclusion list is easy to get wrong in the permissive
 * direction, so this reports *what* matched rather than only that something did.
 * The returned values are the forbidden constants themselves, never a sample of
 * the text, so a failure message cannot leak the surface it is complaining
 * about.
 */
export function forbiddenFragmentsIn(text: string): string[] {
  return FORBIDDEN_FRAGMENTS.filter((fragment) => text.includes(fragment)).sort();
}

/** Compact, leak-free rendering of a forbidden-fragment finding. */
export function describeForbiddenFragments(found: readonly string[]): string {
  if (found.length === 0) return 'no forbidden fragments';
  return `forbidden fragments present: ${[...found].join(', ')}`;
}

/**
 * True when `text` is free of every forbidden fragment.
 *
 * The single predicate every sanitized-surface assertion uses, so "the manifest
 * is clean" means the same thing in every gate.
 */
export function isFreeOfLearnerContent(text: string): boolean {
  return forbiddenFragmentsIn(text).length === 0;
}
