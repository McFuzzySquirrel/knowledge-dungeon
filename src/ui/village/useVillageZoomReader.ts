/**
 * Reading the village camera's zoom without naming a renderer.
 *
 * ## Why this is its own module
 *
 * `VillageScreen` is the composition root, and `tests/phase12/village-shell-split.test.ts` holds it under
 * 900 lines on the reasoning that "the composition root is the *small* thing". The zoom read-out needed a
 * reader, and the reader needs a feature-detection whose whole explanation is about **not** importing a
 * renderer type - which is the kind of note that belongs beside the logic rather than inside a screen.
 *
 * So the screen names one function and the note lives here.
 *
 * ## Why the capability is feature-detected through a local type
 *
 * `VillageWorldHandle` in `src/renderers/pixi/village/VillageWorld.tsx` declares
 * `readCameraState(): CameraState | null` and forwards it. The renderer-neutral
 * `VillageRendererCapabilities` in `src/application/contracts/renderer.ts` declares `readPoi` and
 * `invokeAction` but **not** `readCameraState` - and that file is not this phase's to edit, because adding a
 * member to a renderer-neutral contract is a decision for whoever owns the contract.
 *
 * So the shape is declared locally and read optionally. The consequence is honest rather than accidental:
 *
 * | lane | answers | why |
 * | --- | --- | --- |
 * | Pixi village | a factor | the scene has a `CameraRig` and publishes its state |
 * | Phaser village (the default) | `null` | the rollback lane has no camera rig, so there is nothing to report |
 * | before the world mounts | `null` | the same case `readPoi` answers `null` for |
 *
 * A `null` is rendered as "hidden", not as a placeholder factor. A read-out that said "one times normal" on
 * a screen with no world, or on the lane that cannot report, would be stating something false.
 *
 * ## No learner data
 *
 * A number in, a number or `null` out. No structure, no subject, no room.
 */
import { useCallback } from 'react';

/** The one member this reads, declared locally so no renderer type is imported. */
interface CameraReading {
  readonly readCameraState?: () => { readonly zoom: number } | null;
}

/**
 * A stable reader for the mounted world's zoom factor.
 *
 * @param readHandle the screen's handle getter, already feature-detected and already `useCallback`ed.
 *   Typed as returning `unknown` because a handle that has **no** camera member is still a valid handle:
 *   `VillageRendererCapabilities` declares `readPoi` and `invokeAction` and not `readCameraState`, so
 *   passing one straight through would be a type error for the ordinary case rather than the unusual one.
 * @returns a `() => number | null`
 */
export function useVillageZoomReader(
  readHandle: () => unknown,
): () => number | null {
  return useCallback(
    () => (readHandle() as CameraReading | null | undefined)?.readCameraState?.()?.zoom ?? null,
    [readHandle],
  );
}
