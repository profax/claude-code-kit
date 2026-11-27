// A file's size as a card shows it. Both plugins carry this file; `cargo test -p checks` keeps the
// two copies the same.

/** `bytes` in B, whole KB, or MB and GB to a tenth. */
export const sizeOf = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`
