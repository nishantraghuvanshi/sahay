/**
 * The picked files themselves, for the length of one browser session.
 *
 * `SetupDraft.files` is persisted to localStorage and can only hold metadata —
 * name, size, type, progress. The bytes have to live somewhere else, because the
 * analysing screen needs to POST them and localStorage cannot store a Blob.
 *
 * Module scope rather than a ref, so navigating 1c -> 1d -> back keeps both the
 * thumbnails and the uploadable file. A full page reload empties it: the draft
 * survives, the bytes do not, and the caregiver is asked to pick the photo again.
 * That is the honest trade — the alternative is base64-ing prescription images
 * into localStorage, where they would persist on the device indefinitely.
 */

const files = new Map<string, File>()
const urls = new Map<string, string>()

export function putFile(id: string, file: File): void {
  files.set(id, file)
  if (file.type.startsWith('image/')) urls.set(id, URL.createObjectURL(file))
}

export function getFile(id: string): File | undefined {
  return files.get(id)
}

export function previewUrl(id: string): string | undefined {
  return urls.get(id)
}

export function dropFile(id: string): void {
  const url = urls.get(id)
  if (url) URL.revokeObjectURL(url)
  urls.delete(id)
  files.delete(id)
}

/** True when the bytes are still in memory — false after a reload. */
export const hasBytes = (id: string): boolean => files.has(id)

/**
 * Drop every staged image and revoke its object URL.
 *
 * Called once onboarding has been saved: the schedule is the record we keep, and
 * holding the photograph of a prescription any longer than it takes to read it is
 * exactly what the DPDP guidance says not to do. Also what stops one test's staged
 * file being visible to the next, since this map is module scope.
 */
export function clearFiles(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url)
  urls.clear()
  files.clear()
}
