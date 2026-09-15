# Keyboard shortcuts

`Mod` means **⌘ Cmd** on macOS and **Ctrl** on Windows and Linux. Letter and digit shortcuts use the physical key position,
so they work the same on any keyboard layout and with Caps Lock on.

You can also see every shortcut in the app: press **Shift+?** or **Mod+/** (Help → Keyboard shortcuts). The dialog is built
from the commands that are actually registered, so it is always current. To search every command, layer and insertable element,
press **Mod+K** or **Mod+Shift+P**.

Shortcuts don't fire while you type in a text field, and most don't fire while a dialog is open. Exceptions: the command palette
works from text fields, and Undo/Redo in a text field act on the field's own text.

The tables list the command id so plugins and tests can run the same action with `app.commands.run(id)`.
Rows marked *planned* are reserved for features that are still being built. They show up in the in-app list once registered.

## Edit

| Action | Windows / Linux | macOS | Command |
|---|---|---|---|
| Undo | Ctrl+Z | ⌘Z | `edit.undo` |
| Redo | Ctrl+Shift+Z / Ctrl+Y | ⌘⇧Z / ⌘Y | `edit.redo` |
| Delete | Delete / Backspace | ⌦ / ⌫ | `edit.delete` |
| Duplicate | Ctrl+D | ⌘D | `edit.duplicate` |
| Rename layer | F2 | F2 | `edit.rename` |
| Select all (siblings, or every element on the page) | Ctrl+A | ⌘A | `edit.selectAll` |
| Cut *(planned)* | Ctrl+X | ⌘X | `edit.cut` |
| Copy *(planned)* | Ctrl+C | ⌘C | `edit.copy` |
| Paste *(planned)* | Ctrl+V | ⌘V | `edit.paste` |

## Arrange

| Action | Windows / Linux | macOS | Command |
|---|---|---|---|
| Group | Ctrl+G | ⌘G | `arrange.group` |
| Ungroup | Ctrl+Shift+G | ⌘⇧G | `arrange.ungroup` |
| Wrap in stack (auto layout) | Ctrl+Alt+G | ⌘⌥G | `arrange.wrapStack` |
| Wrap in frame | — | — | `arrange.wrapFrame` |
| Align left | Alt+A | ⌥A | `arrange.align.left` |
| Align horizontal centers | Alt+H | ⌥H | `arrange.align.hcenter` |
| Align right | Alt+D | ⌥D | `arrange.align.right` |
| Align top | Alt+W | ⌥W | `arrange.align.top` |
| Align vertical centers | Alt+V | ⌥V | `arrange.align.vcenter` |
| Align bottom | Alt+S | ⌥S | `arrange.align.bottom` |
| Distribute horizontally | Alt+Shift+H | ⌥⇧H | `arrange.distribute.h` |
| Distribute vertically | Alt+Shift+V | ⌥⇧V | `arrange.distribute.v` |
| Tidy up | Alt+Shift+T | ⌥⇧T | `arrange.tidy` |
| Arrange in circle… | — | — | `arrange.radial` |
| Match width | — | — | `arrange.matchWidth` |
| Match height | — | — | `arrange.matchHeight` |
| Bring forward | Ctrl+] | ⌘] | `arrange.bringForward` |
| Send backward | Ctrl+[ | ⌘[ | `arrange.sendBackward` |
| Bring to front | Ctrl+Alt+] | ⌘⌥] | `arrange.bringToFront` |
| Send to back | Ctrl+Alt+[ | ⌘⌥[ | `arrange.sendToBack` |
| Lock / unlock | Ctrl+Shift+L | ⌘⇧L | `arrange.lock` |
| Hide / show | Ctrl+Shift+H | ⌘⇧H | `arrange.hide` |
| Rotate 15° left | — | — | `arrange.rotateLeft` |
| Rotate 15° right | — | — | `arrange.rotateRight` |
| Reset rotation | — | — | `arrange.resetRotation` |

Align needs one unlocked element (it aligns to the parent) or several (they align to each other). Distribute needs three, and
Tidy up and Arrange in circle need two. Locked elements and children of stacks aren't moved. You can still delete locked
elements.

## Tools *(planned)*

| Tool | Key | Command |
|---|---|---|
| Select | V | `tool.select` |
| Hand (pan) | H | `tool.hand` |
| Frame | F | `tool.frame` |
| Section | S | `tool.section` |
| Text | T | `tool.text` |
| Rectangle | R | `tool.rect` |
| Ellipse | O | `tool.ellipse` |
| Line | L | `tool.line` |
| Image | Mod+Shift+K | `tool.image` |

## View

| Action | Windows / Linux | macOS | Command |
|---|---|---|---|
| Command palette | Ctrl+K / Ctrl+Shift+P | ⌘K / ⌘⇧P | `view.palette` |
| Zoom in | Ctrl+= / Ctrl+Shift+= / Ctrl++ | ⌘= / ⌘⇧= / ⌘+ | `view.zoomIn` |
| Zoom out | Ctrl+- / Ctrl+Shift+- | ⌘- / ⌘⇧- | `view.zoomOut` |
| Zoom to 100% | Shift+0 / Ctrl+0 | ⇧0 / ⌘0 | `view.zoom100` |
| Zoom to fit page | Shift+1 | ⇧1 | `view.zoomFit` |
| Zoom to selection | Shift+2 | ⇧2 | `view.zoomSelection` |
| Toggle grid | Ctrl+' | ⌘' | `view.toggleGrid` |
| Toggle rulers | Shift+R | ⇧R | `view.toggleRulers` |
| Show / hide side panels | Ctrl+\ | ⌘\ | `view.togglePanels` |
| Toggle left panel | — | — | `view.toggleLeftPanel` |
| Toggle right panel | — | — | `view.toggleRightPanel` |
| Light / dark / system theme | — | — | `view.theme.light` · `view.theme.dark` · `view.theme.system` |

## Help

| Action | Windows / Linux | macOS | Command |
|---|---|---|---|
| Keyboard shortcuts | Shift+? / Ctrl+/ | ⇧? / ⌘/ | `help.shortcuts` |
| About | — | — | `help.about` |

## Canvas keyboard navigation

| Action | Keys |
|---|---|
| Nudge the selection 1 px *(planned command)* | Arrow keys |
| Nudge the selection 10 px *(planned command)* | Shift+Arrow keys |
| Select the first child, or edit text | Enter |
| Select the parent | Shift+Enter or Esc |
| Select the next / previous sibling | Tab / Shift+Tab |
| Cancel the current drag, resize or rotate | Esc |

## Mouse, trackpad and touch

| Action | Gesture |
|---|---|
| Pan | Scroll, Space+drag, middle-button drag, two-finger drag |
| Zoom around the pointer | Mod+scroll, pinch |
| Select the deepest element (inside groups) | Mod+click |
| Add to or remove from the selection | Shift+click |
| Enter a group / edit text | Double-click |
| Duplicate while dragging | Alt+drag |
| Keep the aspect ratio while resizing | Shift+drag a handle (images keep it by default) |
| Resize from the center | Alt+drag a handle |
| Snap rotation to 15° steps | Shift while rotating |
| Turn off snapping while dragging | Hold Mod |
| Context menu | Right-click or long-press |

## Command palette

| Key | Action |
|---|---|
| ↑ / ↓ | Move through the results |
| Page Up / Page Down | Jump 8 results |
| Enter | Run the command, insert the element, or go to the layer |
| Esc, Mod+K | Close and return focus to where it was |
| `>` prefix | Commands only |
| `@` prefix | Layers on the current page |
| `+` prefix | Insert an element at the center of the view |

Commands you recently ran from the palette are listed first. Commands that don't apply to the current selection are shown greyed
out and can't be run.
