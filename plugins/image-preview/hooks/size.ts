// A file's size as a card shows it. Both plugins carry this file; `cargo test -p checks` keeps the
// two copies the same.

/**
 * `bytes` in B, whole KB, or MB and GB to a tenth: in the largest unit whose value, once rounded,
 * is 1 or more, so 1048575 bytes is 1.0 MB and not 1024 KB.
 */
export function sizeOf (bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (Math.round(bytes / 1024) < 1024) return `${Math.round(bytes / 1024)} KB`
  const megabytes = bytes / 1024 ** 2
  return Number(megabytes.toFixed(1)) < 1024 ? `${megabytes.toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`
}
