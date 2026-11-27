// The rows of a fullscreen Claude Code screen that the transcript does not take. Both plugins carry
// this file; `cargo test -p checks` keeps the two copies the same.

/**
 * Above the first transcript row: an empty row, the logo's three and another empty one (measured in
 * Claude Code 2.1.332). Once the transcript fills the screen the logo has scrolled away.
 */
export const HEADER_ROWS = 5
/** Below the last transcript row: the band, the prompt box with its hints, and the status line. */
export const BOTTOM_ROWS = 7
