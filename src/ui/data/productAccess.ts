/**
 * The Data Center's single route to the data-product tree, and its single local
 * download.
 *
 * Phase 6 gave the Data Center a second tab, and the second tab needs the same
 * four things the first one did: the live device, its attachment ids, a typed
 * failure report, and a way to hand bytes to the learner as a file. Rather than
 * let each tab grow its own copy - two boundary helpers and two
 * `createObjectURL` implementations, in a screen whose entire argument is that
 * egress cannot happen here - this module holds one of each and both tabs import
 * it.
 *
 * ## Why this file exists rather than living in `DataCenter.tsx`
 *
 * Two reasons, both about the boundary rather than about tidiness.
 *
 * 1. **One `createObjectURL` in the whole Data Center.** The Phase 5 egress gate
 *    pins the allowed local-download call sites by module and count, and it
 *    pinned exactly one in `DataCenter.tsx` because that is where the only one
 *    was. Two tabs means two downloads, and two copies of the four-step
 *    `Blob` → object URL → anchor → **revoke** sequence would be two places a
 *    future edit could forget the revoke. There is one here instead, and the gate
 *    still pins it - to a new path, which is a smaller change than a new
 *    construct.
 * 2. **One statement of the storage-v2 boundary, for two callers.** Phase 5's
 *    comment on `readLiveDevice` is a claim about the *only* place a screen can
 *    reach storage-v2. Two screens cannot both make that claim, so the helper
 *    moved here and the claim moved with it.
 *
 * ## The boundary itself, restated
 *
 * `VITE_DATA_PRODUCTS_V2` owns both products. The product tree is reached only
 * through a lazy `import()` of a string literal, and every *type* from it is
 * reached through a type-position `import()` expression that TypeScript erases -
 * including {@link DeviceRepository}, which is named by the product's own request
 * type rather than by a storage-v2 module, so no file under `src/ui/` names a
 * storage-v2 *implementation* module and none has to be an entry on
 * `tests/migrations/qaHardening.test.ts`'s closed seam allowlist.
 *
 * `readLiveDevice` reaches storage-v2 through the `.kdsubject` product, which
 * re-exports `resolveLiveDeviceRepository`, `readLiveActiveGenerationId`, and
 * `resolveDeviceLocalPayloadBytes` from the `.kdbak` product. One lazy import
 * serves both tabs and both products.
 *
 * ## Read-only, and the one accessor written here
 *
 * Nothing in this module writes. The device reads are `readActiveGenerationId`
 * and `readRecords`, both reads the products themselves perform.
 *
 * {@link readDeviceSubjects} is the one accessor that does not exist in the
 * product tree, and it is a deliberate decision rather than an omission. Choosing
 * which subject to export is a screen concern - the product exports *one named
 * subject* and has no opinion about which one a learner should pick - and the
 * product publishes no list. The obvious alternative, reaching
 * `repositorySelection` or the persistence facade from a screen, would put a UI
 * file on the closed storage-v2 seam allowlist and would make the Data Center
 * know storage-v2 exists by name, which is the one thing plan section 11's "there
 * is exactly one place in the application that knows storage-v2 exists" exists to
 * prevent. So the list is read here, from the same handle the product is handed,
 * with the same `readRecords` call the `.kdbak` export already used for
 * attachment ids. **No export path was added to either product.**
 *
 * ## Privacy
 *
 * `readDeviceSubjects` returns subject *names*, because a learner choosing which
 * subject to back up has to be able to tell them apart. A name is rendered in
 * exactly two places in the Data Center: the picker's own option list, and the
 * replace confirmation, which is required to say what it destroys. It never
 * reaches a file name, an error message, a status sentence, or a log: the export
 * status reports counts and the product's constant file name, and
 * `readFailure` reports a code.
 *
 * ## The two template accessors, and why they are two and not one
 *
 * Phase 7's template tab needs the subject **before** an export and the subject
 * **after** an import, and the two reads want deliberately different shapes.
 *
 * {@link readDeviceTemplateSource} is the export side. It returns the room topics
 * and tags and the biome, because those three are the approval step: the learner
 * has to see the topics (a template always carries them, so they are the one thing
 * a share decision turns on) and has to be able to tick each tag. It also returns
 * the snapshot, which is handed straight to the product and is never decoded by
 * the surface.
 *
 * {@link readDeviceTemplateLanding} is the import side, and it returns **no learner
 * text at all** - only counts and the phase state. That asymmetry is the point
 * rather than an accident of two shapes: the surface that reports what an import
 * created is a *reported* surface, it is rendered into a status line and copied
 * into a report, and plan section 12, rule 6 governs reported strings. So the one
 * accessor that feeds a report cannot hand it a topic, even though the accessor
 * beside it can.
 *
 * A template *export* is also the one Data Center operation whose product is
 * **not** reached through the `.kdsubject` product's re-exports, because
 * `subjectTemplate.ts` re-exports nothing from its siblings and must not: a single
 * static re-export would put the ZIP codec in this JSON product's closure, which
 * `tests/data/templateProductBoundary.test.ts` holds against. So the template tab
 * dynamic-imports the product tree itself, and the repository handle it is handed
 * is still the one `readLiveDevice` published - so there is still exactly one
 * route from a screen to storage-v2.
 */

// ── The product's own types, reached without a static edge ──────────────────
//
// A type-position `import()` is erased by TypeScript, so these aliases cost a
// default build nothing and still stop this file compiling the moment a product
// renames a field or changes a type.

type SubjectProduct = typeof import('@/services/persistence/products/subjectBackup');
type FullDeviceProduct = typeof import('@/services/persistence/products/fullDeviceBackup');
type SubjectExportResult = Awaited<ReturnType<SubjectProduct['exportSubjectBackup']>>;
type SubjectImportResult = Awaited<ReturnType<SubjectProduct['importSubjectBackup']>>;
type FullDeviceExportResult = Awaited<ReturnType<FullDeviceProduct['exportFullDeviceBackup']>>;
type FullDeviceImportResult = Awaited<ReturnType<FullDeviceProduct['importFullDeviceBackup']>>;

/**
 * The subject shape the product tree's exporters take.
 *
 * Named from `src/core/` rather than from a product, for two reasons. It is an
 * application-owned type and not a product's own, so the `.kdtemplate` product does
 * not re-export it and naming the product to reach it would be a static edge the
 * Phase 7 boundary gate has to fail on. And `src/core/` is a declared,
 * renderer-neutral layer, so a UI file naming a core type is ordinary rather than a
 * new seam - it is not a storage-v2 module, so this file stays off
 * `tests/migrations/qaHardening.test.ts`'s closed seam allowlist.
 */
type SubjectSnapshot = import('@/core/validation/persistence/types').SubjectSnapshot;

/** Re-exported so a caller can name a typed failure without reaching a product. */
export type FailureReport = import('@/ui/data/RecoveryStatus').RestoreFailureReport;

/**
 * The live storage-v2 handle, named by a product request type.
 *
 * Both products take the same repository - `StorageV2Repository` - and neither
 * product's request type is imported statically. `SubjectExportRequest` is the one
 * named here so this module has a single product specifier to erase; the `.kdbak`
 * request is structurally identical, which is why the device tab can hand this
 * same handle to the `.kdbak` product without a cast.
 */
export type DeviceRepository = import('@/services/persistence/products/subjectBackup').SubjectExportRequest['repository'];

/** The live device: its handle, and the generation its pointer names. */
export interface LiveDevice {
  readonly repository: DeviceRepository;
  readonly generationId: string;
}

/** One subject on this device, as the picker needs to describe it. */
export interface DeviceSubject {
  /** Opaque. Handed straight to the product; never rendered. */
  readonly subjectId: string;
  /** The learner's own name for it, read from the device's record. */
  readonly name: string;
  /** How many rooms it has, so two similarly named subjects can be told apart. */
  readonly roomCount: number;
}

// ── The live device ────────────────────────────────────────────────────────

/**
 * The live storage-v2 handle and the generation its pointer names.
 *
 * The product's request type *is* a repository handle, so the screen that hands a
 * generation to the product has to be able to reach the handle the bootstrap
 * published. The product publishes it - `resolveLiveDeviceRepository()` and
 * `readLiveActiveGenerationId()` - and this module asks the product for both,
 * which is what makes this the only route from a screen to storage-v2.
 *
 * The boundary this rests on is plan section 11's "there is exactly one place in
 * the application that knows storage-v2 exists", restated one level down:
 * `tests/migrations/qaHardening.test.ts` holds a closed allowlist
 * (`STORAGE_V2_SEAMS`) of the files permitted to name a storage-v2 module, and a
 * screen that reached `repositorySelection` itself would have to be an entry on
 * it. Going through the product instead means no UI file is on that list, the
 * product tree stays the single seam, and a build with the flag off still
 * contains none of it - the accessor is reached by a lazy `import()` of a
 * literal, so the selection module and the repository type behind it are fetched
 * only when a learner actually takes or restores a backup.
 *
 * `null` is the expected answer rather than an error: while
 * `VITE_STORAGE_REPOSITORY` is `legacy` there is no versioned store to read, and
 * the screen says so in words instead of failing.
 */
export async function readLiveDevice(): Promise<LiveDevice | null> {
  const product = await import('@/services/persistence/products/subjectBackup');
  const repository = await product.resolveLiveDeviceRepository();
  if (repository === null) return null;
  const generationId = await product.readLiveActiveGenerationId();
  if (generationId === null) return null;
  return { repository, generationId };
}

/** The attachment ids a generation references, which is what the payload map is keyed by. */
export async function readDeviceAttachmentIds(
  repository: DeviceRepository,
  generationId: string,
): Promise<string[]> {
  const snapshot = await repository.readRecords(generationId);
  return snapshot.records.attachmentMetadata.map((envelope) => envelope.value.attachmentId);
}

/**
 * One subject's own attachment ids.
 *
 * The device tab asks for every id in the generation because a `.kdbak` is a whole
 * generation. A `.kdsubject` is one subject, so asking for every id would hand the
 * device-local resolver a list of ids that belong to other subjects and then throw
 * the answer away - a full-resolution read for a quarter of the result.
 */
export async function readDeviceSubjectAttachmentIds(
  repository: DeviceRepository,
  generationId: string,
  subjectId: string,
): Promise<string[]> {
  const snapshot = await repository.readRecords(generationId);
  return snapshot.records.attachmentMetadata
    .filter((envelope) => envelope.value.subjectId === subjectId)
    .map((envelope) => envelope.value.attachmentId);
}

/**
 * The subjects in a generation, for the export picker.
 *
 * The accessor written here rather than in the product tree, for the reason this
 * module's header gives. Sorted by name with the identifier as the tiebreak, so
 * the picker's order is a function of the device's own data and not of an
 * IndexedDB cursor - the same determinism argument the product makes for the
 * order of records inside an archive.
 *
 * A subject whose snapshot does not carry a usable name still appears, described
 * by its room count, because silently omitting a subject from a backup picker is
 * worse than a vague label: a learner who cannot find a subject concludes the
 * app cannot back it up.
 */
export async function readDeviceSubjects(
  repository: DeviceRepository,
  generationId: string,
): Promise<DeviceSubject[]> {
  const snapshot = await repository.readRecords(generationId);
  const subjects: DeviceSubject[] = [];
  for (const envelope of snapshot.records.subjects) {
    const subjectId = envelope.value.subjectId;
    if (typeof subjectId !== 'string' || subjectId.length === 0) continue;
    subjects.push({
      subjectId,
      name: readSubjectName(envelope.value.snapshot),
      roomCount: countRooms(envelope.value.snapshot),
    });
  }
  return subjects.sort((left, right) => {
    const byName = left.name.localeCompare(right.name, 'en');
    if (byName !== 0) return byName;
    return left.subjectId < right.subjectId ? -1 : left.subjectId > right.subjectId ? 1 : 0;
  });
}

/**
 * The learner's own name for a subject, or a phrase that says it has none.
 *
 * Read from the **device's** record, never from an archive: a chosen `.kdsubject`
 * is untrusted input, and a name it supplied is a value an attacker chose. The
 * replace confirmation, which has to name what it destroys, therefore names what
 * *this device* calls that subject.
 */
function readSubjectName(snapshot: unknown): string {
  const dungeon = (snapshot as { dungeon?: unknown } | null)?.dungeon;
  const name = (dungeon as { subjectName?: unknown } | null)?.subjectName;
  if (typeof name === 'string' && name.trim().length > 0) return name;
  return 'Subject with no name';
}

function countRooms(snapshot: unknown): number {
  const rooms = (snapshot as { rooms?: unknown } | null)?.rooms;
  if (rooms === null || typeof rooms !== 'object' || Array.isArray(rooms)) return 0;
  return Object.keys(rooms as Record<string, unknown>).length;
}

// ── The template tab's two reads ───────────────────────────────────────────

/**
 * One room, as the export side of the template tab needs to see it.
 *
 * Only what an approval decision turns on: the topic, the tags, and the opaque
 * handle. Nothing else about the room is read, so there is no note, no artifact,
 * no image, and no review state anywhere in the value - the surface cannot render
 * what this accessor does not return.
 */
export interface DeviceTemplateRoom {
  /** Opaque. Never rendered, and never reaches a file name. */
  readonly roomId: string;
  /** The learner's own topic. Rendered, because a template always carries it. */
  readonly topic: string;
  /** The learner's own tags on this room. Rendered as unticked approval boxes. */
  readonly tags: readonly string[];
}

/**
 * Everything the template **export** needs about one subject on this device.
 *
 * The snapshot travels with it because the product's exporter is a pure function
 * of a snapshot, and re-reading the record for it would be a second read of the
 * same generation for a value this one already has.
 */
export interface DeviceTemplateSource {
  readonly subjectId: string;
  readonly name: string;
  /**
   * The subject's root room, or `null` when it holds none this read could resolve.
   *
   * Not for the product - the product resolves the root itself, from the snapshot, and
   * refuses a snapshot without one. It is here so the export list can lead with the root,
   * which matters because the list is **bounded**: on a subject with hundreds of rooms
   * the tail is what a bound drops, and a bound that dropped the root would hide the one
   * topic a learner most needs before they share a file.
   */
  readonly rootRoomId: string | null;
  readonly rooms: readonly DeviceTemplateRoom[];
  /**
   * The biome this subject already uses, or `null` for none.
   *
   * The product does **not** read a subject's biome: `approvedBiome` is a
   * parameter with no default, so a biome is in the file only because a learner
   * ticked it. This accessor supplies the *value* to offer, and never the
   * decision.
   */
  readonly biome: string | null;
  /**
   * The subject's own snapshot, handed straight to the product.
   *
   * Never rendered, never logged, and never copied into a message. It is here
   * because the product's export signature is a snapshot and the Data Center has
   * no other way to produce one.
   */
  readonly snapshot: SubjectSnapshot;
}

/**
 * What the template **import** created, read back from the device.
 *
 * Counts and one closed code, and no learner text: every field here reaches a
 * report, and this is the read that feeds the report. The room count, the blank
 * room count, and the four per-room tallies are *measurements* taken from the
 * record the product wrote, so "it landed in Creator state with blank rooms" is
 * something this surface checked rather than something it was told.
 */
export interface DeviceTemplateLanding {
  readonly subjectId: string;
  /** Read from this device, so it is a name the application holds. */
  readonly name: string;
  readonly roomCount: number;
  /** Rooms whose state, note, artifact, image list, and review count are all blank. */
  readonly blankRoomCount: number;
  /** Rooms carrying a note. A count, never the note. */
  readonly roomsWithNotes: number;
  /** Rooms carrying a written artifact. A count, never the artifact. */
  readonly roomsWithArtifacts: number;
  /** Image records across every room. A count, never a file name. */
  readonly roomAttachmentCount: number;
  /** Rooms with any review history. A count. */
  readonly roomsWithReviewHistory: number;
  /** The subject's own phase state, from the device record. */
  readonly phaseState: string;
}

/** The `dungeon` sub-object of a record's snapshot, or an empty object. */
function dungeonOf(snapshot: unknown): Record<string, unknown> {
  const dungeon = (snapshot as { dungeon?: unknown } | null)?.dungeon;
  return typeof dungeon === 'object' && dungeon !== null && !Array.isArray(dungeon)
    ? (dungeon as Record<string, unknown>)
    : {};
}

/** A non-empty string with its own whitespace, or `null` for anything else. */
function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value;
}

/** A trimmed, non-empty string, or `null` for anything else. */
function readBoundedString(value: unknown): string | null {
  return readNonEmptyString(value)?.trim() ?? null;
}

function isBlankRoom(room: Record<string, unknown>): boolean {
  return (
    room.state === 'Created' &&
    readBoundedString(room.noteText) === null &&
    (room.artifactMarkdown === null || room.artifactMarkdown === undefined) &&
    Array.isArray(room.attachments) &&
    room.attachments.length === 0 &&
    (typeof room.reviewPassCount !== 'number' || room.reviewPassCount === 0)
  );
}

/**
 * The export side's read: one subject's own rooms, tags, biome, and snapshot.
 *
 * `null` is the honest answer for a subject this generation does not hold, which
 * is the ordinary case a learner reaches by picking a template and then choosing a
 * file while a subject is removed underneath them. Rooms are ordered by topic and
 * then by room id, so the list a learner reads is a function of the device's own
 * data rather than of an IndexedDB cursor's order.
 */
export async function readDeviceTemplateSource(
  repository: DeviceRepository,
  generationId: string,
  subjectId: string,
): Promise<DeviceTemplateSource | null> {
  const generation = await repository.readRecords(generationId);
  for (const envelope of generation.records.subjects) {
    if (envelope.value.subjectId !== subjectId) continue;
    const snapshot = envelope.value.snapshot;
    const rooms: DeviceTemplateRoom[] = [];
    const roomMap = (snapshot as { rooms?: unknown } | null)?.rooms;
    if (typeof roomMap === 'object' && roomMap !== null && !Array.isArray(roomMap)) {
      for (const [roomId, value] of Object.entries(roomMap as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue;
        const room = value as Record<string, unknown>;
        // Not trimmed: the product writes `RoomMetadata.topic` verbatim, so a trimmed
        // copy here would let the room list show a different string from the one the
        // file carries, on a surface whose entire job is that they agree.
        const topic = readNonEmptyString(room.topic);
        if (topic === null) continue;
        const tags = Array.isArray(room.tags)
          ? room.tags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
          : [];
        rooms.push({ roomId, topic, tags });
      }
    }
    const rootRoomId = readBoundedString(dungeonOf(snapshot).rootRoomId);
    // The root first, then by topic and then by id: the same shape as the product's own
    // canonical room order, which is breadth-first from the root, so the list a learner
    // reads is the order the file itself uses. Leading with the root is also what makes
    // the surface's bound safe - a bounded list drops its tail, and the root is the one
    // topic that must not be the thing that got dropped.
    rooms.sort((left, right) => {
      if (left.roomId === rootRoomId) return -1;
      if (right.roomId === rootRoomId) return 1;
      const byTopic = left.topic.localeCompare(right.topic, 'en');
      if (byTopic !== 0) return byTopic;
      return left.roomId < right.roomId ? -1 : left.roomId > right.roomId ? 1 : 0;
    });
    return {
      subjectId,
      name: readSubjectName(snapshot),
      rootRoomId: rootRoomId !== null && rooms.some((room) => room.roomId === rootRoomId) ? rootRoomId : null,
      rooms,
      biome: readBoundedString(dungeonOf(snapshot).biome),
      snapshot,
    };
  }
  return null;
}

/**
 * The import side's read-back: what the device now holds for the minted subject.
 *
 * Deliberately returns counts where the export side returned text. The claims this
 * licenses are "a new subject was added", "it has N rooms", "every one of those N
 * rooms is blank", and "it is in the Create state" - and each of them is a
 * measurement of a record the product wrote, checked here rather than assumed.
 * Nothing else about the subject is read, so a topic cannot reach the report even
 * by accident.
 *
 * `null` when the subject is not in the generation, which after a successful write
 * is an anomaly rather than a state: the surface reports the counts it has and says
 * the read-back found nothing, instead of claiming a verification that did not run.
 */
export async function readDeviceTemplateLanding(
  repository: DeviceRepository,
  generationId: string,
  subjectId: string,
): Promise<DeviceTemplateLanding | null> {
  const generation = await repository.readRecords(generationId);
  for (const envelope of generation.records.subjects) {
    if (envelope.value.subjectId !== subjectId) continue;
    const snapshot = envelope.value.snapshot;
    const roomMap = (snapshot as { rooms?: unknown } | null)?.rooms;
    const values: Record<string, unknown>[] =
      typeof roomMap === 'object' && roomMap !== null && !Array.isArray(roomMap)
        ? Object.values(roomMap as Record<string, unknown>).filter(
            (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
          )
        : [];
    return {
      subjectId,
      name: readSubjectName(snapshot),
      roomCount: values.length,
      blankRoomCount: values.filter((room) => isBlankRoom(room)).length,
      roomsWithNotes: values.filter((room) => readBoundedString(room.noteText) !== null).length,
      roomsWithArtifacts: values.filter(
        (room) => room.artifactMarkdown !== null && room.artifactMarkdown !== undefined,
      ).length,
      roomAttachmentCount: values.reduce(
        (total, room) => total + (Array.isArray(room.attachments) ? room.attachments.length : 0),
        0,
      ),
      roomsWithReviewHistory: values.filter(
        (room) => typeof room.reviewPassCount === 'number' && room.reviewPassCount > 0,
      ).length,
      phaseState: readBoundedString(dungeonOf(snapshot).phaseState) ?? 'unreported',
    };
  }
  return null;
}

// ── Failure reporting ──────────────────────────────────────────────────────

/**
 * Read a failure the way the product says failures may be read: a code, and
 * details that are codes, counts, and lengths.
 *
 * `toReport()` is the sanitized form the product itself publishes, and it is
 * preferred over reading `code`/`details` off the instance. A failure that is not
 * typed at all - an `IndexedDB` error, say - is reported as
 * `UNEXPECTED_ERROR` with **no message**: a message is the one field a foreign
 * error is free to fill with anything, and a subject name in a paragraph is
 * exactly the leak this product was built to prevent.
 */
export function readFailure(error: unknown): FailureReport {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      code?: unknown;
      details?: unknown;
      toReport?: () => unknown;
    };
    if (typeof candidate.toReport === 'function') {
      const report = candidate.toReport() as { code?: unknown; details?: unknown } | null;
      if (report !== null && typeof report === 'object' && typeof report.code === 'string') {
        return { code: report.code, details: readDetailValues(report.details) };
      }
    }
    if (typeof candidate.code === 'string') {
      return { code: candidate.code, details: readDetailValues(candidate.details) };
    }
  }
  return { code: 'UNEXPECTED_ERROR', details: {} };
}

/** Keep only the value shapes a typed detail is allowed to carry. */
function readDetailValues(details: unknown): Readonly<Record<string, string | number | boolean | null>> {
  if (typeof details !== 'object' || details === null) return {};
  const kept: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      kept[key] = value;
    }
  }
  return kept;
}

// ── The download ───────────────────────────────────────────────────────────

/**
 * Hand an archive's bytes to the learner as a file on this device.
 *
 * Four steps and no fifth: a `Blob` that owns its bytes, an object URL, an anchor
 * that carries the product's file name, and a revoke. The revoke is deferred by
 * one task rather than run inline, because some browsers have not finished
 * taking a copy of the blob when the click handler returns, and revoking inside
 * the handler cancels the download there.
 *
 * The file name is always the product's constant. Nothing a learner authored can
 * reach a file name, which is plan section 12, rule 6 and is the reason a
 * `.kdsubject` is not called `<subject name>.kdsubject`.
 */
export function downloadBackupFile(bytes: Uint8Array, fileName: string, mediaType = 'application/zip'): void {
  // A Blob must own its bytes: a view over a larger buffer would otherwise carry
  // the rest of that buffer into the file.
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mediaType });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

// ── Result adaptation ──────────────────────────────────────────────────────

/**
 * The `.kdbak` export result, narrowed to the fields the device tab reports.
 *
 * The type comes from the product through `import()`, so a rename stops this
 * compiling rather than producing an `undefined` in a status sentence.
 */
export function toDeviceExportReport(result: FullDeviceExportResult): {
  readonly fileName: string;
  readonly byteLength: number;
  readonly subjectCount: number;
  readonly externalOnlyCount: number;
} {
  return {
    fileName: result.fileName,
    byteLength: result.bytes.byteLength,
    subjectCount: result.manifest.recordCounts.subjects,
    externalOnlyCount: result.externalOnlyAttachments.length,
  };
}

/** The `.kdbak` import result, narrowed to the fields the device tab reports. */
export function toDeviceImportReport(result: FullDeviceImportResult): {
  readonly generationId: string;
  readonly previousActiveGenerationId: string | null;
  readonly activated: boolean;
  readonly previousGenerationRetained: boolean;
  readonly keepPreviousGeneration: boolean;
  readonly retentionNote: string;
  readonly disclosedWarnings: FullDeviceImportResult['disclosedWarnings'];
  readonly externalOnlyAttachments: FullDeviceImportResult['externalOnlyAttachments'];
  readonly recordCounts: FullDeviceImportResult['recordCounts'];
  readonly contentChecksum: string;
  readonly restoredActiveSubjectId: string | null;
  readonly reusedArchiveGenerationId: boolean;
  readonly migrationReceiptCount: number;
  readonly receiptNote: string;
} {
  return {
    generationId: result.generationId,
    previousActiveGenerationId: result.previousActiveGenerationId,
    activated: result.activated,
    previousGenerationRetained: result.previousGenerationRetained,
    keepPreviousGeneration: result.keepPreviousGeneration,
    retentionNote: result.retentionNote,
    disclosedWarnings: result.disclosedWarnings,
    externalOnlyAttachments: result.externalOnlyAttachments,
    recordCounts: result.recordCounts,
    contentChecksum: result.contentChecksum,
    restoredActiveSubjectId: result.restoredActiveSubjectId,
    reusedArchiveGenerationId: result.reusedArchiveGenerationId,
    migrationReceiptCount: result.migrationReceiptCount,
    receiptNote: result.receiptNote,
  };
}

/** The `.kdsubject` export result, narrowed to the fields the subject tab reports. */
export function toSubjectExportReport(result: SubjectExportResult): {
  readonly fileName: string;
  readonly byteLength: number;
  readonly roomCount: number;
  readonly externalOnlyCount: number;
} {
  return {
    fileName: result.fileName,
    byteLength: result.bytes.byteLength,
    roomCount: result.manifest.roomCount,
    externalOnlyCount: result.externalOnlyAttachments.length,
  };
}

/**
 * The `.kdsubject` import result, narrowed to the fields the subject tab reports.
 *
 * Every field here is a count, a code, or an opaque identifier. The two fields
 * that would be learner content - `importedSubjectId` and `replacedSubjectId` -
 * are deliberately **not** in the report: the surface that names the subject it
 * just created reads the device's own records after the import, which is the
 * difference between a name the application chose and a name a file supplied.
 */
export function toSubjectImportReport(result: SubjectImportResult): {
  readonly mode: 'copy' | 'replace';
  readonly activated: boolean;
  readonly previousGenerationRetained: boolean;
  readonly previousActiveGenerationId: string | null;
  readonly identifiersRemapped: number;
  readonly unresolvedReferenceCount: number;
  readonly crossSubjectAchievementsCarried: number;
  readonly carriedForwardRecordCounts: Readonly<Record<string, number>>;
  readonly destroyedRecordCounts: Readonly<Record<string, number>>;
  readonly foreignState: SubjectImportResult['foreignState'];
  readonly verbatimDisclosures: SubjectImportResult['verbatimDisclosures'];
  readonly disclosedWarnings: SubjectImportResult['disclosedWarnings'];
  readonly externalOnlyAttachments: SubjectImportResult['externalOnlyAttachments'];
  readonly receiptPolicy: string;
  readonly receiptNote: string;
  readonly previousGenerationReceiptCount: number;
  readonly recordCounts: SubjectImportResult['recordCounts'];
  readonly contentChecksum: string;
  readonly generationId: string;
} {
  return {
    mode: result.mode,
    activated: result.activated,
    previousGenerationRetained: result.previousGenerationRetained,
    previousActiveGenerationId: result.previousActiveGenerationId,
    identifiersRemapped: result.identifiersRemapped,
    unresolvedReferenceCount: result.unresolvedReferenceCount,
    crossSubjectAchievementsCarried: result.crossSubjectAchievementsCarried,
    carriedForwardRecordCounts: result.carriedForwardRecordCounts,
    destroyedRecordCounts: result.destroyedRecordCounts,
    // Counts and closed codes, carried through whole. `foreignState` is the answer
    // to "what did that import do to *other* subjects?", and `verbatimDisclosures`
    // is the answer to "what did the copy choose not to rewrite?" - the product
    // computed both so a report would not have to guess. Both are count-only by the
    // product's own contract, and the surface renders them as words and numbers, so
    // no bystander identifier can reach the DOM through this adapter either.
    foreignState: result.foreignState,
    verbatimDisclosures: result.verbatimDisclosures,
    disclosedWarnings: result.disclosedWarnings,
    externalOnlyAttachments: result.externalOnlyAttachments,
    receiptPolicy: result.receiptPolicy,
    receiptNote: result.receiptNote,
    previousGenerationReceiptCount: result.previousGenerationReceiptCount,
    recordCounts: result.recordCounts,
    contentChecksum: result.contentChecksum,
    generationId: result.generationId,
  };
}
