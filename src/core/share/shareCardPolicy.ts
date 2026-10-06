/**
 * The executable privacy policy of share cards (plan section 20).
 *
 * ## Why this module exists at all
 *
 * The pre-Phase-20 exporter, `src/ui/utils/progressionShareExport.ts`, drew three
 * things onto an image a learner might publish:
 *
 * 1. raw badge ids - `CreatorPhaseComplete`, `ScribeCentury120` - because
 *    `InventoryBadgesPanel.tsx` has a `BADGE_LABELS` map covering exactly one id and
 *    falls back to `BADGE_LABELS[badgeId] ?? badgeId`;
 * 2. `new Date().toLocaleString()`, which is a function of host locale **and** host
 *    time zone, so one archive rendered differently on two devices - the same defect
 *    class Phase 19 found in `assistanceEngine`, where `Date.parse` reading an
 *    offset-less timestamp as local time changed a ranked result between UTC and
 *    Kolkata;
 * 3. hardcoded colours and `'Inter, sans-serif'`, a second declaration of the Phase 8
 *    Cozy token system.
 *
 * Items 2 and 3 are fixed by omission here: this module has no clock and no colour, and
 * the model it guards produces no date and no styling. Item 1 is what this file is for.
 *
 * ## Allowlist, plus a denylist that is code rather than a comment
 *
 * The allowlist is the primary defence and lives in `./types` as
 * {@link SHARE_CARD_FIELDS}. The denylist below is the second line, and it exists
 * because an allowlist only helps if every path into a card goes through it. Two ways
 * do not: a future {@link ShareCardField} could be added without thinking about the
 * denylist, and a caller can hand {@link buildShareCardModel} a hand-built selection.
 *
 * So {@link isDeniedField} is a real predicate over *values*, and
 * {@link mayFieldAppearOnCard} is the single call the renderer layer makes per row.
 * A test in `tests/unit/shareCards.test.ts` drives the model with selections carrying
 * every denied token and asserts that no row appears - and a sibling test asserts the
 * predicate's own positive and negative cases, so a denylist that denied everything
 * would fail too.
 *
 * ## Determinism
 *
 * No clock, no randomness, no locale, no storage, no network, no DOM. Every order in
 * this module is a fixed declaration order or an explicit sort by code unit - never the
 * caller's array order, never `Object.keys` on a caller-supplied object. Phase 19
 * shipped `findSubjectIdForRoom` reading `subjects` in caller order, which flipped the
 * resolved subject id when two subjects shared a room id; the same shape of bug is
 * closed here by construction rather than by a comment.
 */
import {
  SHARE_CARD_FIELDS,
  SHARE_CARD_FIELDS_BY_KIND,
  SHARE_CARD_FIELD_ORDER,
  isShareCardField,
  isShareCardKind,
  type ShareCardDefaults,
  type ShareCardField,
  type ShareCardKind,
} from './types';

/**
 * The default selection per kind.
 *
 * These are the values a card carries when a learner opens the dialog and clicks
 * straight through, which is the case plan section 20's exit criterion is about: "Default
 * cards contain no raw notes or hidden identifiers."
 *
 * Two deliberate choices, both of them restrictive:
 *
 * - **`subjectName` is in every default**, because a subject name is the learner's own
 *   and they are sharing it on purpose; the UI must still make deselecting it obvious,
 *   and {@link ShareCardModel.subjectName} being separately addressable is what lets it.
 * - **`badgeLabels` is in no default**, even though badge *labels* are now canonical and
 *   safe. Long label lists dominate a small card, and a shorter default card is a card
 *   that reads. It is available in `subject-summary` and `collection` for a learner who
 *   wants it.
 * - **`assistanceSummary` is in no default at all.** Plan section 8 keeps assistance
 *   advisory and private; a card is a private surface too, but it is a surface the
 *   learner deliberately hands to someone else. Assistance is excluded by default in
 *   every kind and appears only on request.
 * - **`collectedNoteCount` is in no default**, though it is a bare count. It counts the
 *   learner's notes, and a count of notes on a shared image invites the question "what
 *   are they?" The count is available in `subject-summary`, `collection`, and
 *   `statistics`; it is nobody's default.
 */
export const DEFAULT_SELECTION_BY_KIND: ShareCardDefaults = Object.freeze({
  'subject-summary': Object.freeze([
    'subjectName',
    'rank',
    'xpTotal',
    'roomsCleared',
    'roomTotal',
    'badgeCount',
    'inventoryCount',
    'studyStreakDays',
    'activeStudyDays',
  ] as const),
  collection: Object.freeze([
    'subjectName',
    'rank',
    'fishTotal',
    'fishUniqueTypes',
    'fishRarityCounts',
  ] as const),
  fish: Object.freeze(['subjectName', 'fishTotal', 'fishUniqueTypes', 'fishRarityCounts'] as const),
  statistics: Object.freeze([
    'subjectName',
    'rank',
    'studyStreakDays',
    'activeStudyDays',
    'sessionsCompleted',
  ] as const),
});

/**
 * Every field a kind may show, in the stable render order the renderer must use.
 *
 * Total over {@link SHARE_CARD_KINDS}; an unknown kind yields an empty list rather
 * than throwing, because the value may come from a restored preference or a future
 * card kind this build does not know.
 */
export function availableFieldsFor(kind: ShareCardKind): readonly ShareCardField[] {
  return SHARE_CARD_FIELD_ORDER[kind] ?? [];
}

/**
 * The default selection for a kind, normalized to the fields that are actually
 * available for it.
 *
 * Normalized rather than returned raw so a default can never name a field the kind
 * does not have, which would otherwise be an unrenderable selection sitting in a frozen
 * constant where nobody would look for it.
 */
export function defaultSelectionFor(kind: ShareCardKind): readonly ShareCardField[] {
  const requested = DEFAULT_SELECTION_BY_KIND[kind] ?? [];
  return requested.filter((field) => isFieldAllowed(kind, field));
}

/**
 * May this field be selected for this kind at all?
 *
 * The one call the renderer layer makes. Both halves matter: the global allowlist and
 * the per-kind table. A field that is in {@link SHARE_CARD_FIELDS} but not in this
 * kind's table returns `false` - that is the "narrower per kind than the global list"
 * decision in `./types` being enforced rather than described.
 *
 * Accepts `unknown`, so it is safe to call on a value read from storage or from a
 * restored preference without narrowing first.
 */
export function isFieldAllowed(kind: ShareCardKind, field: unknown): field is ShareCardField {
  if (!isShareCardKind(kind)) return false;
  if (!isShareCardField(field)) return false;
  return SHARE_CARD_FIELDS_BY_KIND[kind].includes(field);
}

/**
 * The renderer's question, in one call: may this row be drawn on this card?
 *
 * Named separately from {@link isFieldAllowed} so the renderer's intent is legible at
 * the call site - `mayFieldAppearOnCard(kind, field)` reads as a permission, which is
 * what the plan's "never selectable" list needs - while both share one implementation,
 * so there is no second rule to drift.
 */
export function mayFieldAppearOnCard(kind: ShareCardKind, field: unknown): boolean {
  return isFieldAllowed(kind, field);
}

/**
 * The renderer's question about a **value** rather than a field: may this string be written on a
 * card?
 *
 * This is where {@link isDeniedField} is load-bearing, and it answers the question the field-level
 * filter cannot. {@link mayFieldAppearOnCard} decides whether a *row* may be drawn; this decides
 * whether a *string* may be put in one - which is the decision a renderer actually makes when it
 * formats a caption, names a badge, or writes a value a caller supplied.
 *
 * The two are separate on purpose. A row is a declared field, and no declared field is denied. A
 * string can be anything, and only the denylist can say no: a raw badge id, a room id, a
 * timestamp, a storage key.
 *
 * An earlier version of this module also consulted the denylist inside {@link splitSelection}. A
 * mutation probe showed that call was **unreachable** - the allowlist had already rejected every
 * denied name - so it was removed rather than left in place as defence that cannot defend. This
 * function is the reachable form of the same check, and the value-level tests below are what make
 * the denylist non-vacuous.
 *
 * Total over `unknown` and never throws, so a renderer may call it on anything it is about to draw.
 */
export function mayValueAppearOnCard(value: unknown): boolean {
  return !isDeniedField(value);
}

// ── The denylist ────────────────────────────────────────────────────────────

/**
 * Field-shaped values that may never appear on a card.
 *
 * Declared as **field-shaped** rather than as literal forbidden strings, because the
 * ids in this application are minted (`room-7f3a`, `subj_a1b2`, `ses_0001`) and a
 * denylist of literals would match none of them while appearing to be thorough. What
 * these entries share is a *shape*: each is a data category that identifies something -
 * a room, a note, a session, a storage key - and identifying something is exactly what
 * a share card must not do.
 *
 * Each entry is tested against:
 *
 * - an **exact** match, after case folding and trimming, so `NoteTopic` and `noteTopic`
 *   are both denied; and
 * - a **shape** match for the identifier categories, so `room-7f3a`, `roomId`,
 *   `rooms.visited`, and `dungeonRoom_42` are all denied by category.
 *
 * What is deliberately **not** here: the app's own public-ish vocabulary. `Novice`,
 * `Scholar`, `Master`, `common`, `rare`, `epic`, and every canonical badge label are
 * published content and must survive. So is a subject name, because it is the learner's
 * own and selectable. A denylist that denied those would deny the card.
 */
export const DENIED_FIELD_VALUES: readonly string[] = Object.freeze([
  // Note bodies and topics.
  'noteBody',
  'noteMarkdown',
  'noteText',
  'noteTopic',
  'noteTitle',
  'artifactMarkdown',
  'artifactPreview',
  'topic',
  'body',
  'markdown',
  // Rooms and floors.
  'roomId',
  'roomIds',
  'roomList',
  'roomName',
  'floorLabel',
  'floorId',
  'dungeonId',
  // Subjects, sessions, attachments.
  'subjectId',
  'sessionId',
  'attachmentId',
  'attachmentIds',
  'noteId',
  'fishId',
  'badgesPanel',
  // Raw badge identifiers.
  'badgeId',
  'badgeIds',
  'badgeKey',
  // Wall-clock and persistence internals.
  'timestamp',
  'generatedAt',
  'createdAt',
  'updatedAt',
  'caughtAt',
  'collectedAt',
  'dateKey',
  'timeZone',
  'storageKey',
  'localStorage',
  'indexedDB',
  'databaseName',
  'generationId',
  'fileName',
  // Assistance internals.
  'assistanceId',
  'suggestionId',
  'reasonCode',
  'dismissalCount',
  'dismissalRecord',
]);

/**
 * The identifier categories, matched by **shape** rather than by literal.
 *
 * Each entry is a predicate over a folded value. The two halves are deliberate:
 * `roomId` is denied because it *names* a room, and `room-7f3a` is denied because it
 * *is* one. A denylist holding only the first would let the second through, and only
 * the second is what reaches a card.
 */
const DENIED_SHAPES: readonly ((folded: string) => boolean)[] = Object.freeze([
  // `room-7f3a`, `room_id`, `rooms.visited`, `dungeonRoom_42` - and **not** `Room acoustics`.
  // See {@link isRoomIdentifier} for why this cannot be a bare substring test.
  (folded) => isRoomIdentifier(folded),
  // A **minted id prefix**. The application mints ids as `<prefix><separator><suffix>`, so the
  // prefix plus separator is the category test, not the particular suffix. This is the rule that
  // catches `subj_a1b2c3d4`, `ses_0001`, and `note-abc`, which name no field in the literal list
  // and contain no word the word rules above can find.
  (folded) => MINTED_ID_PREFIXES.some((prefix) => folded.startsWith(`${prefix}-`) || folded.startsWith(`${prefix}_`)),
  // `subj_a1b2`, `subjectId`. "Subject" alone is safe (a subject *name* is allowed and
  // arrives through `subjectName`), so this requires an identifier marker too - see
  // `hasIdentifierMarker`.
  (folded) => containsWord(folded, 'subject') && hasIdentifierMarker(folded),
  // `ses_0001`, `sessionId`, `session-9`, but never "sessions completed", which is the
  // `sessionsCompleted` field a statistics card legitimately shows.
  (folded) => containsWord(folded, 'session') && hasIdentifierMarker(folded),
  // Any storage-key shape: a dotted or namespaced persistence path.
  (folded) => /(localstorage|indexeddb|database|generation)[._:-]/.test(folded),
  // `2026-10-05T12:00:00Z`, `2026-10-05`: an ISO date or date-time anywhere in a value.
  (folded) => /\d{4}-\d{2}-\d{2}/.test(folded),
]);

/**
 * The id prefixes this application mints, without their separator.
 *
 * Read off the persisted id shapes - `room-`, `subj_`, `ses_`, `note-`, `fish-`, `gen-`,
 * `att-` - and declared here so a minted id is recognised by **category**. A literal denylist of
 * specific ids would match none of them: `room-7f3a` and `room-9a2b` are different strings and
 * the same thing.
 */
const MINTED_ID_PREFIXES: readonly string[] = Object.freeze([
  'room',
  'subj',
  'subject',
  'ses',
  'session',
  'note',
  'fish',
  'att',
  'attachment',
  'gen',
  'assist',
] as const);

/** {@link DENIED_FIELD_VALUES}, folded once, so {@link isDeniedField} never re-cases per call. */
const DENIED_FIELD_FOLDED: readonly string[] = Object.freeze(
  DENIED_FIELD_VALUES.map((value) => value.toLowerCase()),
);

/** {@link SHARE_CARD_FIELDS}, folded once, for the allowlist short circuit in {@link isDeniedField}. */
const DECLARED_FIELD_FOLDED: ReadonlySet<string> = new Set(
  SHARE_CARD_FIELDS.map((field) => field.toLowerCase()),
);

/**
 * Does the folded value contain this word at all?
 *
 * Plain substring containment, and deliberately so: a word-boundary rule was tried and rejected
 * because the ids that matter are built from the middle of a token, not around it -
 * `dungeonRoom_42`, `roomId`, `subjectId`. Cutting at boundaries would miss all three.
 *
 * So this is the **blunt half** of a rule and is never the whole rule. Every caller pairs it with a
 * test that says *this word is being used as an identifier rather than as English* -
 * {@link hasIdentifierMarker} for `subject` and `session`, {@link isRoomIdentifier} for `room`. A
 * future caller that takes `containsWord` as a complete rule reintroduces the defect this module
 * spent a phase fixing, so the pairing is the contract and the substring test is a building block.
 */
function containsWord(folded: string, word: string): boolean {
  return folded.includes(word);
}

/**
 * Does this value carry an identifier marker - `id`, `ids`, `key`, `uuid`, `hash`, `ref`, or a
 * minted-id **tail** (`-7f3a`, `_0001`)?
 *
 * The split that lets `subjectName` and `sessionsCompleted` through while `subjectId`, `session-4`,
 * `room_id`, and `room id` do not.
 *
 * The boundary in the first alternative is `[^a-z]`, so a marker must be a standalone token. The
 * camel-glued spellings (`roomIds`, `dungeonRoomId`) have no such boundary and are answered by
 * {@link CAMEL_IDENTIFIER_TAIL} instead.
 */
function hasIdentifierMarker(folded: string): boolean {
  return /(^|[^a-z])(id|ids|key|uuid|hash|ref|refs)([^a-z]|$)/i.test(folded) ||
    /[-_][a-z0-9]{4,}$/i.test(folded);
}

/**
 * A marker word such as `id`, `keys`, `list`, or `ref`, camel-glued onto the end of a noun.
 *
 * `roomIds` folded is `roomids`: the marker is plainly there, but there is no non-letter boundary
 * for {@link hasIdentifierMarker} to find, so without this test `roomids` reads as prose.
 */
const CAMEL_IDENTIFIER_TAIL =
  /(?:^|[a-z])rooms?(?:ids?|keys?|uuids?|hashes?|lists?|refs?|names?|paths?)$/i;

/**
 * Does this value name a room the way an **identifier** does, rather than the way a sentence does?
 *
 * ## The defect this replaces
 *
 * The rule used to be `containsWord(folded, 'room')` - a bare substring test. It caught `room-7f3a`,
 * and it also caught `Room acoustics`, `Room 101 calculus`, `My bedroom notes`, and
 * `Living room acoustics`, because `bedroom`, `classroom`, and `living room` all contain `room`.
 *
 * The cost was real and the benefit was nil. `visibleShareCardSubjectName` gates the one free-text
 * string on a card through this predicate, so a learner whose subject was about rooms got a card with
 * **no subject name** - and not one of those four strings identifies anything. The `session` and
 * `subject` rules beside it already required an identifier marker; `room` was the only one of the
 * three that did not, and that asymmetry was the bug.
 *
 * ## The three ways a value names a room, and all three are here
 *
 * 1. **A marker beside the word** - `room_id`, `room id`, `room key`, `room-7f3a`. The same test the
 *    `subject` and `session` rules use, for the same reason.
 * 2. **A camel-glued marker** - `roomIds`, `dungeonRoomIds`, `dungeonRoomKey`.
 * 3. **A path token** - `rooms.visited`, `dungeonRoom_42`, `dungeon_room_42`, `room.4`: "room" inside
 *    a single token that carries a `.` or a `_` and no prose spacing.
 *
 * ## What it costs, stated rather than discovered
 *
 * **Hyphen is not in test 3.** A hyphen is the one separator a human uses in a title, so
 * `rooms-cleared-notes` and `study-room-notes` are hyphenated prose a learner could plausibly have
 * typed, and test 3 deliberately does not reach them. `_` and `.` never occur in English prose, which
 * is what makes them free to mean "this is a key".
 *
 * Being out of test 3 does **not** mean hyphenated tokens are published. Test 1's second
 * alternative - a `-`/`_` tail of four or more alphanumerics - refuses `showroom-physics`, and it is
 * the same pre-existing branch that refuses `room-7f3a`. Widening that branch to spare hyphenated
 * prose would trade the guarantee this whole module exists for, so it is left alone and the residual
 * is recorded as a test rather than fixed in passing. Every case this rule was measured on - `Room
 * acoustics`, `Room 101 calculus`, `My bedroom notes`, `A study room for two`, `Bedroom
 * organisation`, `Classroom management`, `Living room acoustics` - has no hyphen and is published.
 *
 * **A dotted single token is refused** even if a learner meant it as prose, so `living.room` is
 * denied. That is the price of catching `rooms.visited`, and the price is worth paying: a property
 * path is what a persistence layer actually hands a card, and a learner who types a dot into a
 * subject name is not the case the denylist exists for.
 *
 * What survives is the learner's own English - `Room acoustics`, `My bedroom notes`, `Bedroom
 * organisation`, `Classroom management` - which is the entire reason the rule is narrower.
 */
function isRoomIdentifier(folded: string): boolean {
  if (!containsWord(folded, 'room')) return false;
  if (hasIdentifierMarker(folded)) return true;
  if (CAMEL_IDENTIFIER_TAIL.test(folded)) return true;
  return !/\s/.test(folded) && /[._]/.test(folded);
}

/** Fold a value for denylist comparison: trimmed, case-folded, whitespace collapsed. */
function fold(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Is this value one of the never-shareable categories?
 *
 * Total over `unknown`, so it is safe to call on anything. A denial is always a
 * statement that a value must not be *rendered*; it is not an error, and it never
 * throws.
 *
 * ## The allowlist wins
 *
 * A value that is itself a {@link SHARE_CARD_FIELDS} member is **never** denied, and
 * this short circuit comes first for a reason rather than for convenience. The shape
 * rules exist to catch minted ids like `room-7f3a`, and applying one to the vocabulary
 * would deny the very fields the vocabulary declares - which is how a denylist silently
 * becomes a "card can show nothing" gate.
 *
 * So: **the allowlist is authoritative and the denylist is a catch-all for everything
 * else.** A declared field is allowed by definition, because it was reviewed when it
 * was declared; anything unrecognised must survive the denylist on its merits.
 *
 * This short circuit used to be doing rescue work, and is no longer load-bearing at all. The `room`
 * rule was a bare substring test, so `roomsCleared` and `roomTotal` only survived because they are
 * *field ids* - while the authored **labels** for those same fields, `Rooms cleared` and `Rooms in
 * the dungeon`, were refused outright by the same rule, which is the asymmetry this phase measured.
 * {@link isRoomIdentifier} removes it instead of papering over it, because the two cases are the same
 * case: a declared label and a learner's own subject name are both prose, and a denylist that
 * refuses one has to refuse the other.
 *
 * The consequence is stated rather than glossed: with the room rule corrected, **no declared field is
 * denied by any shape rule**, so removing this line is unobservable - a mutation probe confirms it.
 * That is an argument for keeping it anyway, not for deleting it. It is the guarantee a *future*
 * shape rule has to satisfy, it costs one `Set` lookup, and the alternative to keeping it is letting
 * the next blunt rule quietly deny the vocabulary.
 *
 * ## No label allowlist here, on purpose
 *
 * The obvious patch - feeding `SHARE_CARD_FIELD_LABELS` into the allowlist so published
 * copy is exempt - is deliberately **not** done here. It would put a second, overlapping
 * mechanism beside the corrected rule, it would make the policy depend on the content
 * table it exists to police, and it would leave the actual defect - a rule that cannot tell
 * an identifier from a sentence - in place for every other caller. The defence is a test
 * instead: `tests/phase20/shareCardPolicy.test.ts` asserts that **every** authored label
 * passes {@link mayValueAppearOnCard}, so a future label the value gate would refuse fails
 * in the policy suite rather than being silently deleted by a renderer later.
 *
 * ## Raw badge ids
 *
 * A raw badge id is not denied by shape either: `ScribeCentury120` carries no word
 * boundary for any rule above. That case is handled structurally rather than by a
 * pattern - `buildShareCardModel` only ever puts `canonicalBadgeLabel(id)` into a row,
 * and an id with no canonical label produces **no row at all**, so an unrecognised id
 * cannot reach a card by falling back to itself. The unknown-id test in
 * `tests/unit/shareCards.test.ts` pins that.
 */
export function isDeniedField(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const folded = fold(value);
  if (folded.length === 0) return true;
  // The allowlist is authoritative: a declared field is allowed by definition. Compared
  // **case-folded**, so `XPtotal` is recognised as the declared `xpTotal` rather than falling
  // through to the shape rules.
  if (DECLARED_FIELD_FOLDED.has(folded)) return false;
  for (const denied of DENIED_FIELD_FOLDED) {
    if (folded === denied) return true;
  }
  for (const shape of DENIED_SHAPES) {
    if (shape(folded)) return true;
  }
  return false;
}

/**
 * The strict, typed form of {@link isDeniedField}.
 *
 * A type predicate for callers building a denylist-typed value, so a denied string
 * cannot be widened back to `string` by an intermediate `unknown`.
 */
export function isDeniedValue(value: unknown): value is string {
  return isDeniedField(value);
}

/**
 * Split a selection into the fields a card may render and the fields it must not.
 *
 * The one function a caller needs to defend itself: hand it whatever a learner, a
 * restored preference, or a future migration produced, and it returns only fields that
 * are in the global allowlist, in the kind's table, in the kind's stable render order,
 * and not denied. Duplicates collapse. An unknown kind yields both lists empty.
 *
 * {@link normalizeShareCardSelection} is the same computation with the denied half
 * returned as a record of what was dropped, so a UI can say *why* a choice vanished.
 */
export function splitSelection(
  kind: ShareCardKind,
  requested: readonly unknown[] | null | undefined,
): { readonly allowed: readonly ShareCardField[]; readonly dropped: readonly unknown[] } {
  if (!isShareCardKind(kind)) return { allowed: [], dropped: [] };
  const seen = new Set<ShareCardField>();
  const allowed: ShareCardField[] = [];
  const dropped: unknown[] = [];

  // `Array.isArray` rather than `requested ?? []`: a selection restored from a preference, a
  // JSON payload, or a future caller can be any value, and iterating a string yields characters
  // that would each be reported as a dropped field - or, for `''`, throw. Totalness here is the
  // whole reason a hostile selection cannot crash the share dialog.
  if (!Array.isArray(requested)) {
    if (requested !== undefined && requested !== null) dropped.push(requested);
    return { allowed: [], dropped };
  }

  for (const candidate of requested) {
    // One filter, not two. `isFieldAllowed` is total over field *names*, so anything that is not
    // in the allowlist and in this kind's table is rejected here - which means the denylist had
    // nothing left to catch at this point.
    //
    // That was a real finding, and it is recorded rather than papered over: an earlier version
    // called `isDeniedField` here too, and a mutation probe showed the call was **unreachable**.
    // The allowlist already excludes every denied name, because no denied name is a declared
    // field. A second filter that can never fire is not defence in depth; it is a comment with a
    // function call in it, and the next reader believes the denylist is load-bearing here.
    //
    // So the executable denylist lives where it can actually reach something: in
    // {@link isDeniedField} as a public predicate a caller can ask about any value, and in the
    // model's badge rule, which resolves ids rather than names. Probe P3 in the phase report is
    // the evidence.
    if (!isFieldAllowed(kind, candidate)) {
      dropped.push(candidate);
      continue;
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    allowed.push(candidate);
  }

  // Stable render order, never the caller's order.
  return { allowed: orderFields(kind, allowed), dropped };
}

/**
 * Reorder fields into the kind's declared render order, dropping anything not allowed.
 *
 * The stable-order guarantee lives here and nowhere else: `splitSelection` and
 * {@link normalizeShareCardSelection} both go through it, so a row's position on the
 * card is a function of the field's declaration order and never of who asked first.
 */
export function orderFields(
  kind: ShareCardKind,
  fields: readonly ShareCardField[],
): readonly ShareCardField[] {
  const available = availableFieldsFor(kind);
  return available.filter((field) => fields.includes(field));
}

/**
 * Reduce any input to a safe, ordered selection for a kind.
 *
 * The caller-facing form of {@link splitSelection}: returns only what may render. Used
 * by `buildShareCardModel`, and usable directly by a settings screen that persists a
 * selection.
 */
export function normalizeShareCardSelection(
  kind: ShareCardKind,
  requested: readonly unknown[] | null | undefined,
): readonly ShareCardField[] {
  return splitSelection(kind, requested).allowed;
}

/** Every field in the global allowlist. Frozen; the array itself is the contract. */
export const SHARE_CARD_ALL_FIELDS: readonly ShareCardField[] = SHARE_CARD_FIELDS;