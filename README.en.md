[简体中文](README.md) · English

# Markdown Toolkit

> Visually edit diagrams, mind maps and flowcharts in your notes, 12 kinds in all, then write the result back as plain text. The same canvas edits Markdown tables that hold formulas. A formatting toolbar, file-explorer enhancements and attachment management come with it.

- Current version: 0.21.0
- Minimum Obsidian: 1.4.16
- Desktop and mobile. No network, no account, no paid features.

---

## Why plain text

Diagrams in notes usually end up as screenshots or exported attachments, and the price is that they stop changing alongside the prose. This plugin starts from a different premise: diagrams and tables stay as plain text in the note, and the editor is a visual layer over that text rather than a second copy of it.

Three things follow from that:

- The data lives in a fenced code block or an ordinary Markdown table, so it goes into Git, moves across platforms, and reads fine in any Markdown tool.
- The editor edits that text and writes back to it. There is no second copy and no intermediate format to export.
- Rendering and layout happen locally. Nothing is requested from a server.

All five capabilities below can be switched on or off individually from the Feature modules tab.

---

## What it does

### 1. Visual diagram editor

Write a diagram as a code block, click it, and the canvas editor opens. Drag things around and the result is written back into the code block. 12 kinds are built in:

| Diagram | First line keyword | Good for |
|---|---|---|
| Mind map | `mindmap` | Outlines, brainstorming |
| Flowchart | `flowchart TD` | Processes, branching logic |
| Sequence diagram | `sequenceDiagram` | API calls, service interaction |
| Class diagram | `classDiagram` | Object-oriented design |
| State diagram | `stateDiagram-v2` | State transitions |
| ER diagram | `erDiagram` | Database table relationships |
| Gantt chart | `gantt` | Project scheduling |
| Pie chart | `pie` | Proportions |
| Git graph | `gitGraph` | Branch history |
| Timeline | `timeline` | Events in order |
| Fishbone diagram | `ishikawa-beta` | Root cause analysis |
| Bar chart | `xychart-beta` | Comparing values across categories |

- Self-rendered SVG with dagre auto-layout. No external CDN, no network.
- Drag nodes on the canvas, rename them, add children and siblings, delete them. Positions go into a comment line inside the block, so they come back the way you left them, and other renderers skip that line.
- Tidy layout, undo and redo, zoom, and five node shapes (rectangle, rounded, circle, diamond, hexagon).
- Each block carries an edit affordance in its corner. You can also export SVG or PNG, or open a fullscreen preview.
- A diagram that fails to render does not turn into a blank box: the source is shown with a note about which kind failed.
- The diagram list in settings filters as you type. All 12 in one place, each with its keyword, its typical use, and whether it has a visual editor.
- Pinch to zoom on mobile.

Commands: `Insert a mind map block`, `Insert a flowchart block`, `Insert a diagram…`, `Turn the selected outline into a mind map`, `Edit the diagram at the cursor`.

### 2. Table editor

In the reading view and in Live Preview, the plugin takes over Markdown tables and puts a frame around each one:

- Every table gets framed, formula or not. The one exception is the table your caret is in during Live Preview: that is the table you are typing into, so it goes back to Obsidian and renders as-is.
- Put a formula in a cell (say `=sum(B2:B4)`) and it computes. The cell shows the value, the source keeps the formula. Computed cells carry a `ƒ` marker and a tint; turn that off in the Table editor tab if you would rather not see it.
- Formulas cover `sum`, `avg`, `count`, `max` and `min`, ranges like `B2:B4`, and arithmetic with `+ - * /`, parentheses and a leading minus, such as `=B2-C2`. A bad reference shows up as a value like `#REF!` instead of breaking the render.
- The frame's corner has buttons and a formula-count badge. Export the table as CSV or Markdown, or open the visual editor.
- The editor is spreadsheet-shaped: letter column headers and number row gutters that stick while you scroll; drag or Shift to select a range; arrows and Tab to move; double-click a cell to type; drag the fill handle to continue a series; Del to clear; Ctrl+C/V to move blocks. Edit a blank cell past the edge and the table grows. Column widths and row heights are draggable, but only for that sitting, never written back. Right-click a column or row header to insert or delete whole columns and rows. The formula bar shows the selected cell's source while the cell shows its value, and the name box jumps straight to a cell.
- Pinch to zoom on mobile.
- Tables have their own auto-save and interval, separate from the diagram editor's.

The toolbar also has an Insert table button, and two text tools convert between tables and lists.

### 3. Editor toolbar

A customizable formatting toolbar, 40+ buttons by default, with submenus you can drag to reorder:

- Format brush: copy one span's formatting onto another.
- Underline: Markdown has no underline syntax, so this button writes the HTML tag Obsidian renders.
- Text batch tools: fifteen of them, grouped under Line operations, Text processing and Advanced tools. Strip or insert blank lines, split and merge lines, dedupe, add prefixes and suffixes, add line numbers, trim each line, collapse whitespace, remove all whitespace, convert between tables and lists, and extract text between two markers.
- Alignment: left, centre, right, justify. Done with inline styles in the block, so the plain text still reads fine.
- Dual colour panels: one picker for font colour, one for background colour, with an eyedropper for picking a colour off the screen.
- Fullscreen focus mode: the editor fills the screen and the sidebars and status bar get out of the way.
- Diagram submenu: a Diagrams entry on the bar inserts a flowchart or mind-map block outright, or opens the picker for any kind.
- Section headings: drop your own labelled dividers into the bar and edit or delete their text, so the buttons end up grouped the way you think.
- Mobile toolbar: on a phone, Obsidian's own toolbar above the keyboard is hidden automatically, leaving only this plugin's bar. It works the moment you install; there is nothing to set.
- Toolbar background: the bar's own colour. Follow the theme, go transparent, or pick one of eight presets; you can also type `#rrggbb`, `rgb()`, `hsl()` or `var(--theme-variable)`.

Commands: `Toggle format brush`, `Underline`, `Font colour`, `Background colour`, `Fullscreen focus mode`.

### 4. File-explorer enhancements (off by default)

> This module is off until you turn it on in the Feature modules tab.

- Hidden rules: hide entries by exact name, `startsWith::` prefix or `endsWith::` suffix, say the `attachments` folder or `.obsidian`-style entries. Case can be ignored, and matches can be pushed into Obsidian's excluded-files list so they vanish from search, graph view and backlinks. A status-bar count shows how many are hidden right now.
- Manual order: give folders a custom order and reset them back to alphabetical whenever you want. The settings tab opens each arranged folder to show the order you gave its entries, with a handle to drag rows.

### 5. Attachment management (off by default)

> This module is off until you turn it on in the Feature modules tab.

- Attachment folder template: variables decide where attachments land, relative to the current note or to the vault root. The variables are `${noteFileName}`, `${folderPath}`, `${originalFileName}` and `${date:YYYYMMDDHHmmss}`.
- File-name template: applied when saving and renaming attachments.
- Special characters: replace or delete special characters in file and folder names, to avoid sync and cross-platform trouble.
- Sync rename / move: rename or move a note and its attachment folder follows, with every link updated.
- Duplicate separator: pasting a file whose name is taken adds a separator and a counter until a free name turns up.
- Empty-folder policy: after a note leaves, its empty attachment folder can be kept, deleted, or deleted along with empty parent folders.
- Orphan cleanup: when a note is deleted, the attachments it leaves behind go to the trash, and can be restored.

---

## Commands

Every command is in the command palette and can take a hotkey. Most of them can also be placed on the toolbar.

| Command | Description |
|---|---|
| Insert a mind map block | Insert a `mindmap` block |
| Insert a flowchart block | Insert a `flowchart` block |
| Insert a diagram… | Pick one of the 12 kinds |
| Turn the selected outline into a mind map | Select a multi-level list or some headings, get a mind map |
| Edit the diagram at the cursor | Open the visual editor for the block the cursor is in |
| Toggle format brush | Turn the format brush on or off |
| Underline | Toggle underline |
| Font colour | Open the colour panel |
| Background colour | Open the colour panel |
| Fullscreen focus mode | Toggle fullscreen focus mode |
| Text tools (15) | Plain text without syntax, full width to half width, insert blank lines, remove blank lines, split into lines, merge lines, remove duplicate lines, add a prefix and suffix, add line numbers, trim each line, collapse extra spaces, remove all whitespace, list to table, table to list, extract between two strings |
| Text alignment (4) | Left, centre, right, justify |

---

## Installation

The plugin is on the Obsidian community store, so you can search for it under Settings → Community plugins. Two other ways:

### Option 1: Manual

1. Download the three files from [Releases](https://github.com/hellokunzai/obsidian-markdown-toolkit/releases): `main.js`, `manifest.json`, `styles.css`.
2. In your vault, create `<your-vault>/.obsidian/plugins/markdown-toolkit/`. The folder name has to match the plugin id `markdown-toolkit` exactly.
3. Drop the three files in, restart Obsidian, then enable Markdown Toolkit under Settings → Community plugins.

> Note: the plugin id and the folder name must match, or the configuration cannot be read or saved.

### Option 2: BRAT (Beta)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) first.
2. In BRAT, choose "Add a beta plugin" and enter the repository: `hellokunzai/obsidian-markdown-toolkit`.
3. Enable it in the community-plugins list. BRAT takes care of updates from then on.

---

## Settings

Seven tabs. The Feature modules tab sits on the far left and is always there; the rest follow their module's switch, so turning a module off takes its tab with it.

| Tab | Contents |
|---|---|
| Feature modules | One master switch per module: Toolbar / Table / Diagram / Attachment / File hiding / File order. Turning a module off hides its settings tab and disables its editor feature at the same time. Toolbar, Table and Diagram are on by default; Attachment, File hiding and File order are off until you turn them on |
| Editor toolbar | Toolbar background colour (follow theme / transparent / eight presets / a typed colour), command search, add or remove commands and submenus, section headings, drag to reorder |
| Table editor | Table auto-save and its interval, formula highlighting (the ƒ marker and tint in the reading view, the editor and the preview), a formula reference |
| Diagram editor | Auto-save and its interval, the diagram list (searchable, with keyword, typical use and visual-editor columns) |
| Attachment handling | Attachment folder and file-name templates, special-character handling, sync rename/move, duplicate separator, empty-folder policy, orphan cleanup |
| File hiding | Entries to hide, ignore case, enable hiding, add to the excluded-files list, status-bar indicator, the sidebar eye button |
| File order | Show the reorder button, open a folder to see the order you gave its entries and drag a row's handle to change it, search arranged folders by path, clear one custom order or all of them |

---

## Privacy & compatibility

- No network requests; everything runs locally.
- No external account, no paid features.
- Desktop and mobile (`isDesktopOnly: false`); minimum Obsidian 1.4.16.
- The interface follows Obsidian's language setting, with English and Simplified Chinese built in.

---

## Development

```bash
npm install
npm run dev      # watch and rebuild main.js
npm run build    # type check, then a production build
```

The build produces three files: `main.js`, `manifest.json` and `styles.css`. Sources live under `src/`, split into `core` (pure logic), `charts`, `editor`, `embed`, `features`, `ui` and `utils`. To publish, push a tag named like `v0.21.0` and GitHub Actions builds and creates the release.

---

## Credits

- Diagram layout uses [dagre](https://github.com/dagrejs/dagre) for automatic positioning.
- Icon and interaction ideas come from the Obsidian core editor and [editing-toolbar](https://github.com/cumany/obsidian-editing-toolbar).

## License

MIT © hellokunzai
