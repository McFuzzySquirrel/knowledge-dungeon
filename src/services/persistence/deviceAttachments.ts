/**
 * Device-local room attachments, in the shape the subject store needs.
 *
 * The web build used to post a picked image to `/api/upload`, read a relative
 * path out of the JSON response, and record the result as an *external*
 * attachment pointing at the app's own server. Plan section 2.3 replaces that
 * with a device-local write, and this module is the seam between the storage-v2
 * attachment-bytes store and the subject snapshot's `RoomAttachment` list.
 *
 * Two things this module deliberately does not do:
 *
 * - It never fetches. An external attachment keeps its URL as a URL, is recorded
 *   as `external-only` with `contentHash: null` and no bytes, and is never
 *   downloaded.
 * - It never guesses a MIME type. The bytes are stored with the type the file
 *   picker reported, or `application/octet-stream` when the browser gave none,
 *   because inventing an image type for non-image bytes is how a preview ends up
 *   rendering something the learner did not pick.
 *
 * Renderer-neutral: no renderer import, no network, no React.
 */

import type { RoomAttachment } from '@/core/validation/persistence';

/**
 * The attachment-bytes store is loaded lazily.
 *
 * The device-local database is only needed when a learner actually picks or links
 * an image, so the default build does not pay for it at load time.
 */
async function attachmentStore(): Promise<typeof import('./v2/attachmentBytes')> {
  return import('./v2/attachmentBytes');
}

/** Extension to MIME type, used only when the browser reported none. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};

const FALLBACK_MIME = 'application/octet-stream';

function extensionOf(fileName: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(fileName);
  return match?.[1]?.toLowerCase() ?? '';
}

/** The MIME type to store: the browser's answer, else the extension's. */
function resolveMimeType(file: { type?: string; name?: string }): string {
  if (typeof file.type === 'string' && file.type.trim().length > 0) return file.type;
  const byExtension = MIME_BY_EXTENSION[extensionOf(file.name ?? '')];
  return byExtension ?? FALLBACK_MIME;
}

/** A readable label for the attachment, derived from the file name. */
function altTextFor(fileName: string): string {
  const base = fileName.split('/').pop() ?? fileName;
  return base.replace(/[_-]+/g, ' ').replace(/\.[a-z0-9]+$/i, '').trim();
}

export interface DeviceLocalRoomAttachmentInput {
  readonly subjectId: string;
  readonly roomId: string;
  readonly file: Blob & { readonly name?: string; readonly type?: string };
}

/**
 * Store the picked bytes on this device and return the room attachment that
 * points at them.
 *
 * The returned attachment is `sourceType: 'local'`, so the renderer resolves it
 * through the device-local store and renders the bytes it already has rather
 * than requesting a URL.
 */
export async function addDeviceLocalRoomAttachment(
  input: DeviceLocalRoomAttachmentInput,
): Promise<RoomAttachment | null> {
  const fileName = input.file.name ?? 'attachment';
  const { storeAttachmentBytes } = await attachmentStore();
  const stored = await storeAttachmentBytes({
    subjectId: input.subjectId,
    roomId: input.roomId,
    bytes: input.file,
    mimeType: resolveMimeType(input.file),
    fileName,
    altText: altTextFor(fileName),
  });

  return {
    attachmentId: stored.attachmentId,
    sourceType: 'local',
    fileName,
    mimeType: resolveMimeType(input.file),
    altText: altTextFor(fileName),
    addedAt: stored.storedAt,
  };
}

/**
 * An object URL for bytes already on this device, or `null`.
 *
 * `null` is the honest answer for an attachment whose bytes are not here - an
 * external link, or a local attachment from a build that stored them on a server.
 * The caller must revoke the URL it receives.
 */
export async function readDeviceLocalAttachmentUrl(attachmentId: string): Promise<string | null> {
  const { readAttachmentObjectUrl } = await attachmentStore();
  return readAttachmentObjectUrl(attachmentId);
}

/** Forget an attachment's bytes. Returns `true` when a record was removed. */
export async function removeDeviceLocalAttachment(attachmentId: string): Promise<boolean> {
  const { deleteAttachmentBytes } = await attachmentStore();
  return deleteAttachmentBytes(attachmentId);
}
