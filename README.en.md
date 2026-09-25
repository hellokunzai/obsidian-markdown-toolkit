[简体中文](README.md) · English

# Markdown Toolkit

> Visually edit diagrams, mind maps and flowcharts inside Obsidian, then write the result back as plain text — plus a formatting toolbar, file-explorer enhancements and attachment management.

- Current version: 0.18.0
- Minimum Obsidian: 1.4.16
- Works on desktop and mobile (no network, no account, no paid features)

---

## What it does

The plugin is built around one idea: **Markdown is the data**. Every diagram lives in a fenced code block in your note, so it stays under version control, travels across platforms, and is readable by any Markdown tool. There are four capabilities:

### 1. Visual diagram editor (core)

Write a diagram as a code block, click it to open a **canvas editor**, drag things around, and the result is written straight back into the code block. **11** diagram kinds are built in:

`mindmap` · `flowchart` · `sequence` · `class` · `state` · `er` · `gantt` · `pie` · `gitGraph` · `timeline` · `ishikawa`

- Self-rendered SVG with [dagre](https://github.com/dagrejs/dagre) auto-layout — **no** external CDN or network.
- Drag nodes on the canvas; their positions are stored in a comment line inside the block, so they survive the next open, and other renderers ignore that line.
- The code block *is* the data: what you see is editable, and what you edit is plain text — never locked in.

Commands:

| Command | Description |
|---|---|
| Insert a mind map block | Insert an empty `mindmap` block |
| Insert a flowchart block | Insert an empty `flowchart` block |
| Insert a diagram… | Pick one of the 11 kinds to insert |
| Turn the selected outline into a mind map | Select a multi-level list, get a mind map |
| Edit the diagram at the cursor | Open the visual editor when the cursor is in a block |

### 2. Editor toolbar

A customizable formatting toolbar (40+ buttons by default, drag-to-reorder submenus):

- **Format brush**: copy a span's formatting onto another span in one click.
- **Underline**: toggle underline.
- **Text batch tools**: strip blank lines, merge/split lines, dedupe, add prefixes/suffixes, line numbers, trim ends, collapse whitespace, table ↔ list conversion, rule-based extraction, and more.
- **Alignment**: left / center / right / justify (via inline styles in the block, still plain-text friendly).
- **Dual colour panels**: font colour and background colour each get their own picker.
- **Fullscreen focus mode**: expand the editor to fill the screen, hiding sidebars and the status bar.

Commands: `Toggle format brush` · `Underline` · `Font colour` · `Background colour` · `Fullscreen focus mode`.

### 3. File-explorer enhancements

- **Hidden rules**: hide entries by exact name, `startsWith::` prefix, or `endsWith::` suffix (e.g. hide the `attachments` folder or `.obsidian`-style entries); optionally case-insensitive; optionally push matches into Obsidian's *excluded files* list (gone from search, graph view and backlinks); a status-bar count shows how many are hidden right now.
- **Manual order**: define a custom display order for file-explorer entries, with a one-click reset back to alphabetical.

### 4. Attachment management

- **Attachment folder template**: use variables (`${noteFileName}`, `${folderPath}`, `${originalFileName}`, `${date:YYYYMMDDHHmmss}`) to decide where attachments land, relative to the current note or the vault root.
- **File-name template**: name saved attachments by a template.
- **Special characters**: replace or delete special characters in folder/file names to avoid sync and cross-platform pitfalls.
- **Sync rename / move**: when a note is renamed or moved, its attachment folder is renamed/moved to match and every link is updated.
- **Duplicate separator**: pasting a file whose name is taken inserts a separator + counter until a free name is found.
- **Empty-folder policy**: after a note leaves, the empty attachment folder can be kept / deleted / deleted along with empty parent folders.
- **Orphan cleanup**: when a note is deleted, its orphaned attachments are sent to the trash (recoverable).

---

## Installation

This plugin is **not yet on the Obsidian community store**, so install it with one of the following:

### Option 1: Manual

1. Download the three files from [Releases](https://github.com/hellokunzai/obsidian-mindforge/releases): `main.js`, `manifest.json`, `styles.css`.
2. In your vault, create `<your-vault>/.obsidian/plugins/markdown-toolkit/` (**the folder name must match the plugin id `markdown-toolkit` exactly**).
3. Drop the three files in, restart Obsidian, and enable **Markdown Toolkit** under Settings → Community plugins.

> ⚠️ The plugin id and the folder name must match, or the plugin cannot read/sync its configuration.

### Option 2: BRAT (Beta)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) first.
2. In BRAT, "Add a beta plugin" and enter the repository: `hellokunzai/obsidian-mindforge`.
3. Enable it in the community-plugins list; BRAT handles updates too.

---

## Settings

The settings are split into five tabs:

| Tab | Contents |
|---|---|
| **General** | Default flowchart direction, mind-map growth direction, remember dragged node positions, editor open location |
| **Toolbar** | Add/remove buttons, drag to reorder submenus and sequence |
| **Hidden rules** | Entries to hide, ignore case, enable hiding, add to excluded-files list, status-bar indicator |
| **Manual order** | Enable manual ordering, reset custom order |
| **Attachments** | Attachment folder & file-name templates, special-character handling, sync rename/move, duplicate separator, empty-folder policy, orphan cleanup |

---

## Privacy & compatibility

- **Makes no network requests**; everything runs locally.
- **No external account, no paid features.**
- Works on desktop and mobile (`isDesktopOnly: false`); minimum Obsidian **1.4.16**.

---

## Credits

- Diagram layout uses [dagre](https://github.com/dagrejs/dagre) for automatic positioning.
- Icon and interaction ideas draw on the Obsidian core editor and [editing-toolbar](https://github.com/cumany/obsidian-editing-toolbar).

## License

MIT © hellokunzai
