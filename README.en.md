[简体中文](README.md) · English

# Markdown Toolkit

> Visually edit diagrams, mind maps and flowcharts in Obsidian, 12 kinds in all, and write the result straight back as plain text. The same canvas also edits Markdown tables that hold formulas. There's a formatting toolbar, file-explorer enhancements and attachment management on top.

- Current version: 0.21.0
- Minimum Obsidian: 1.4.16
- Desktop and mobile. No network, no account, no paid features.

---

## What it does

The idea is simple: Markdown is the data. Everything lives in a fenced code block or an ordinary Markdown table, so it stays under version control, moves across platforms, and reads fine in any Markdown tool. All five capabilities can be switched on or off one module at a time from the Feature modules tab; see Settings below.

### 1. Visual diagram editor (core)

Write a diagram as a code block, click it, and the canvas editor opens. Drag things around and the result is written back into the code block. 12 kinds are built in:

`mindmap` · `flowchart` · `sequence` · `class` · `state` · `er` · `gantt` · `pie` · `gitGraph` · `timeline` · `ishikawa` · `bar`

- Self-rendered SVG with dagre auto-layout. No external CDN, no network.
- Drag nodes wherever you like. Their positions go into a comment line inside the block, so they come back the way you left them, and other renderers skip that line.
- The code block is the data. Whatever you see, you can change, and whatever you change is still plain text.
- The diagram list in the settings filters as you type: all 12 in one place, each with its keyword and whether it has a visual editor.
- Pinch to zoom the preview on mobile.

Commands:

| Command | Description |
|---|---|
| Insert a mind map block | Insert an empty `mindmap` block |
| Insert a flowchart block | Insert an empty `flowchart` block |
| Insert a diagram… | Pick one of the 12 kinds to insert |
| Turn the selected outline into a mind map | Select a multi-level list, get a mind map |
| Edit the diagram at the cursor | Open the visual editor when the cursor is in a block |

### 2. Table editor

In the reading view and in Live Preview, the plugin takes over every Markdown table and puts a frame around it:

- Every table gets framed, formula or not. The one exception is the table your caret is in during Live Preview: that is the table you're typing into, so it goes back to Obsidian and renders as-is.
- Put a formula in a table (say `=sum(B2:B4)`) and it computes. The cell shows the value, the source keeps the formula. Computed cells carry a `ƒ` marker and a tint; turn that off in the Table editor tab if you don't want it.
- Formulas cover `sum` / `avg` / `count` / `max` / `min` and ranges like `B2:B4`. A bad reference shows up as a value such as `#REF!` instead of breaking the render.
- The frame's corner has buttons and a formula-count badge. Export the table as CSV or Markdown, or open the visual editor.
- The editor is spreadsheet-shaped: letter headers and number gutters that stick while you scroll, drag or Shift to select a range, arrows and Tab to move, double-click a cell to type, drag the fill handle to continue a series, Del to clear, Ctrl+C/V to move blocks. Edit a blank cell past the edge and the table grows. Column widths and row heights are draggable, but only for that sitting; they are never written back. Right-click a column or row header for whole-column and whole-row actions. The formula bar shows the selected cell's source, and the cell shows its value.
- Pinch to zoom on mobile.
- Tables have their own auto-save and interval, separate from the diagram editor's.

The toolbar also has an Insert table button and a table ↔ list conversion.

### 3. Editor toolbar

A customizable formatting toolbar, 40+ buttons by default, with submenus you can drag to reorder:

- Format brush: copy one span's formatting onto another.
- Underline: toggle it.
- Text batch tools: strip blank lines, merge or split lines, dedupe, add prefixes or suffixes, add line numbers, trim ends, collapse whitespace, convert between tables and lists, rule-based extraction, and the like.
- Alignment: left, center, right, justify. Done with inline styles in the block, so the plain text still reads fine.
- Dual colour panels: one picker for font colour, one for background colour.
- Fullscreen focus mode: the editor fills the screen and the sidebars and status bar get out of the way.
- Diagram submenu: a "Diagrams" entry on the bar inserts a flowchart or mind-map block outright, or opens the picker for any kind.
- Section headings: drop your own labelled dividers into the bar and edit or delete their text, so the buttons end up grouped the way you think.
- Mobile toolbar: on a phone, Obsidian's own toolbar above the keyboard is hidden automatically, leaving only this plugin's bar. It works the moment you install; there is nothing to set.
- Toolbar background: the bar's own colour. Follow the theme, go transparent, or pick one of eight presets; you can also type `#rrggbb`, `rgb()`/`hsl()` or `var(--theme-variable)`.

Commands: `Toggle format brush` · `Underline` · `Font colour` · `Background colour` · `Fullscreen focus mode`.

### 4. File-explorer enhancements (off by default)

> This module is off until you turn it on in the Feature modules tab.

- Hidden rules: hide entries by exact name, `startsWith::` prefix or `endsWith::` suffix, say the `attachments` folder or `.obsidian`-style entries. Case can be ignored, and matches can be pushed into Obsidian's excluded-files list so they vanish from search, graph view and backlinks. A status-bar count shows how many are hidden right now.
- Manual order: give file-explorer entries a custom order, and reset them back to alphabetical whenever you want.

### 5. Attachment management (off by default)

> This module is off until you turn it on in the Feature modules tab.

- Attachment folder template: variables (`${noteFileName}`, `${folderPath}`, `${originalFileName}`, `${date:YYYYMMDDHHmmss}`) decide where attachments land, relative to the current note or the vault root.
- File-name template: apply a template when renaming or saving attachments.
- Special characters: replace or delete special characters in file and folder names, to avoid sync and cross-platform trouble.
- Sync rename / move: rename or move a note and its attachment folder follows, with every link updated.
- Duplicate separator: pasting a file whose name is taken adds a separator and a counter until a free name turns up.
- Empty-folder policy: after a note leaves, its empty attachment folder can be kept, deleted, or deleted along with empty parent folders.
- Orphan cleanup: when a note is deleted, the attachments it leaves behind go to the trash, and can be restored.

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
| Diagram editor | Auto-save and its interval, the diagram list (searchable, with keyword and visual-editor columns) |
| Attachment handling | Attachment folder and file-name templates, special-character handling, sync rename/move, duplicate separator, empty-folder policy, orphan cleanup |
| File hiding | Entries to hide, ignore case, enable hiding, add to the excluded-files list, status-bar indicator |
| File order | Show the reorder button, open a folder to see the order you gave its names and drag a row's handle to change it, search arranged folders by path, clear one custom order or all of them |

---

## Privacy & compatibility

- No network requests; everything runs locally.
- No external account, no paid features.
- Desktop and mobile (`isDesktopOnly: false`); minimum Obsidian 1.4.16.

---

## Credits

- Diagram layout uses [dagre](https://github.com/dagrejs/dagre) for automatic positioning.
- Icon and interaction ideas come from the Obsidian core editor and [editing-toolbar](https://github.com/cumany/obsidian-editing-toolbar).

## License

MIT © hellokunzai
