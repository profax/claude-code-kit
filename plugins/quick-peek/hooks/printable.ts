// Text from outside a plugin on its way to the screen: a file's lines, a reply, what a program said.
// Both plugins carry this file; `cargo test -p checks` keeps the two copies the same.

/**
 * `text` with U+FFFD for each control character but tab and newline. Claude Code refuses a whole
 * drawn tree that holds one, an escape sequence included, and draws the row its own way.
 */
export const printable = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '�')
