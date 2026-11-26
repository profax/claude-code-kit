// A part of a path in a reply: underlined under the pointer, and on a click it tells the hooks
// module to show the path in the file manager (with Alt, to open it). The card by the path is the
// terminal's own doing, with no hook involved.
import type { ClientModule } from 'claude-code'

/** The part of the path, the whole path and the line it names, and the style of the text around it. */
type Props = { label: string; path: string; line?: number; bold?: boolean; italic?: boolean; strike?: boolean }

const Link: ClientModule<Props, { isOver: boolean; isPressed?: boolean }> = (props, surface) => {
  surface.onPointer(event => {
    // A click is the left button released over the part it was pressed on.
    if (event.type === 'down') {
      if (event.button === 'left') surface.setState({ isOver: true, isPressed: true })
      return
    }
    if (event.type === 'up') {
      // An area not laid out yet (0 by 0) says nothing of where the pointer is.
      const isInside = surface.columns === 0 || (event.x >= 0 && event.y >= 0 && event.x < surface.columns && event.y < surface.rows)
      if (surface.state?.isPressed && isInside) {
        surface.post({ path: props.path, ...(props.line !== undefined && { line: props.line }), isClicked: true, ...(event.alt && { isAlt: true }) })
      }
      surface.setState({ isOver: isInside })
      return
    }
    const isOver = event.type !== 'leave'
    if (isOver !== (surface.state?.isOver ?? false)) surface.setState({ isOver, isPressed: surface.state?.isPressed })
  })
  const { Text } = surface.elements
  return (
    <Text color="permission" bold={props.bold} italic={props.italic} strikethrough={props.strike} underline={surface.state?.isOver === true}>
      {props.label}
    </Text>
  )
}

export default Link
