/**
 * Type declarations for `scripts/check-memory.mjs`.
 *
 * The enforcer is plain ESM run by `node`, like every other script in `scripts/`. It
 * exports its pure measurement functions so a test can exercise them against a
 * synthetic tree rather than mirroring them, and those exports have no declarations
 * unless this file provides them - which is why the Phase 8 measurement test spawns
 * the CLI and keeps its constants in a TypeScript support module instead.
 *
 * Declaring the surface is the better trade for this gate: its logic is the logic under
 * test, and a mirrored copy would be a second implementation that could disagree with
 * the one CI runs. The declarations below are the enforcer's real exports and nothing
 * else; a new export in the script fails the build here until it is declared, which is
 * the intended direction.
 *
 * This file has no runtime content and is not part of any bundle.
 */

/** The three ways a document pulls JavaScript or CSS before any application code runs. */
export type InitialReferenceKind = 'js-module' | 'js-modulepreload' | 'css-stylesheet';

/** Plan section 10.2: "Any lazy JavaScript chunk: no more than 800 KB gzip", as bytes. */
export const LAZY_CHUNK_GZIP_BYTES: number;

/** The same limit in the unit the report prints. */
export const LAZY_CHUNK_GZIP_KIB: number;

/** Plan section 10.2's mount/unmount cycle count, printed so the browser lane's job is on the record. */
export const MOUNT_UNMOUNT_CYCLES: number;

/** gzip level 9, stated rather than defaulted, so the number is reproducible by hand. */
export const GZIP_LEVEL: number;

/** One declared renderer chunk family: its renderer name, and the two prose fields. */
export interface RendererChunkFamily {
  readonly renderer: string;
  /** Why this family exists, printed when the family is present. */
  readonly reason: string;
  /**
   * What this family's absence from an artifact does and does not establish, printed
   * when the family is absent. Present on every family because "absent" is a state
   * every family can be in and the report has to say something true about it.
   */
  readonly absence: string;
}

/**
 * Renderer chunk families, keyed by the `manualChunks` group prefix `vite.config.ts`
 * declares.
 *
 * The key type is the point, not an accident of the literal: `MeasuredRendererChunk.family`
 * is this union rather than `string`, so a caller cannot hand `evaluateMemoryPreflight` a
 * family this script has no reason text for without a deliberate assertion. The runtime
 * still handles the undeclared case (finding `unknown-renderer-family`) because this
 * declaration describes a JavaScript function, and JavaScript callers are not obliged to
 * agree with it.
 */
export const RENDERER_CHUNK_FAMILIES: Readonly<Record<string, RendererChunkFamily>>;

/** Every declared renderer family name, in declaration order. */
export const RENDERER_FAMILY_NAMES: readonly string[];

/** True for a family declared in `RENDERER_CHUNK_FAMILIES`. */
export function isDeclaredRendererFamily(family: string): boolean;

/** Properties this script deliberately does not measure, each paired with what would establish it. */
export const NOT_MEASURED: ReadonlyArray<{ readonly property: string; readonly needs: string }>;

/** A `<script>` or `<link>` start tag with its attributes lowercased. */
export interface ParsedTag {
  readonly tag: string;
  readonly attributes: Map<string, string>;
}

/** One file the entry document names, with every kind that named it. */
export interface CollectedAsset {
  readonly path: string;
  readonly kinds: readonly string[];
}

/** What the entry document names, split by which browser each list is for. */
export interface CollectedInitialAssets {
  /** What a browser in plan section 2.5's engine matrix downloads. */
  readonly initial: Map<string, CollectedAsset>;
  /** What a browser without module support downloads. Never a finding on its own. */
  readonly nomodule: Map<string, CollectedAsset>;
  /** References that are not initial assets, reported rather than counted. */
  readonly skipped: readonly string[];
  /** References that do not name a file inside the artifact. */
  readonly problems: readonly string[];
}

/**
 * One measured renderer chunk.
 *
 * `family` is the family name the caller reports. A `string` is accepted here on
 * purpose: `rendererChunkFamily` is a filter, so an undeclared family is a
 * representable state of the input, and `evaluateMemoryPreflight` reports it as the
 * finding `unknown-renderer-family` rather than throwing on it. The `family` on the
 * returned `RendererFamilyMeasurement` is the same name, so a caller can tell which
 * declaration it did not get.
 */
export interface MeasuredRendererChunk {
  readonly path: string;
  readonly family: string;
  /** Present only when the chunk could not be read. */
  readonly error?: string;
  readonly rawBytes?: number;
  readonly gzipBytes?: number;
}

/** The chunks of one renderer family, measured or declared absent. */
export interface RendererFamilyMeasurement {
  /** The family name, or the renderer name for a family this script does not declare. */
  readonly family: string;
  readonly renderer: string;
  /**
   * True when this artifact contained the family and the numbers below are
   * measurements. False means the family is absent from the artifact: the counts are
   * then zero by definition and nothing was measured. The two are different claims
   * and the report never merges them.
   */
  readonly present: boolean;
  readonly chunks: readonly MeasuredRendererChunk[];
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly eagerPaths: readonly string[];
}

/** One thing the preflight refuses to let through, with the reason in a sentence. */
export interface PreflightFinding {
  readonly code: string;
  readonly message: string;
}

/** The preflight's verdict. */
export interface MemoryPreflightResult {
  readonly findings: readonly PreflightFinding[];
  readonly ok: boolean;
  /** Measured families by name, present ones only. */
  readonly byFamily: Readonly<Record<string, RendererFamilyMeasurement>>;
  /** Family names actually measured, sorted. */
  readonly families: readonly string[];
  /**
   * Every family the run accounted for, in declaration order, with the families this
   * artifact does not contain marked `present: false`. This is the per-family
   * non-vacuity record: a reader can tell "measured and clean" from "absent, so not
   * measured", which `families` and `measuredCount` together cannot express.
   */
  readonly familiesReport: readonly RendererFamilyMeasurement[];
  /** Renderer names of the families this artifact does not contain. */
  readonly absentFamilies: readonly string[];
  /** Renderer names of the families this artifact does contain and therefore measured. */
  readonly measuredFamilies: readonly string[];
  readonly measuredCount: number;
}

export function parseDocumentTags(html: string): ParsedTag[];
export function isRemoteReference(reference: string): boolean;
export function resolveInitialPath(reference: string): string | undefined;
export function rendererChunkFamily(distRelativePath: string): string | undefined;
export function collectInitialAssets(html: string): CollectedInitialAssets;
export function gzipSize(bytes: Uint8Array): number;
export function measureRendererChunks(
  distDir: string,
  readFile: (absolutePath: string) => Promise<Uint8Array>,
): Promise<{ chunks: MeasuredRendererChunk[]; assetsDirPresent: boolean }>;
export function evaluateMemoryPreflight(input: {
  chunks: readonly MeasuredRendererChunk[];
  assetsDirPresent: boolean;
  entryPaths: ReadonlySet<string>;
}): MemoryPreflightResult;
export function kib(bytes: number): string;
