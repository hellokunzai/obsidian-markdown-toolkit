import type { DiagramMode } from "./model";

/**
 * Every mermaid diagram kind this plugin knows by name.
 *
 * Nothing external says what a diagram is. Every kind shares one ```mermaid
 * fence, so the only thing that distinguishes a gantt chart from a mind map is
 * the keyword on the body's first meaningful line. That single line is therefore
 * the entire classification rule, and this table is where it lives: block
 * dispatch, the insert command, the settings reference and the wording of a
 * render failure all read from here rather than each growing a private copy.
 *
 * Every kind in this table has a canvas, which is why `mode` is not optional:
 * the table *is* the list of diagrams the plugin can draw and edit, and an
 * entry without a canvas would be an entry nothing could open. Declaring it
 * required is what makes "a kind with no editor" impossible to represent
 * rather than merely absent today.
 */
export interface DiagramKind {
  /** Stable id. Also the i18n key segment for name / scene / template. */
  id: string;
  /** Keyword written on the first line of the body when this kind is inserted. */
  keyword: string;
  /** Recognises the body's first meaningful line. */
  pattern: RegExp;
  nameKey: string;
  sceneKey: string;
  templateKey: string;
  /** Which canvas opens this kind. Always equal to `id`. */
  mode: DiagramMode;
}

/**
 * `flowchart TD` / `graph LR` … The capture group is the direction, which
 * `parseFlow` needs. The same regex doubles as this kind's recognition rule so
 * the two can never drift apart about what a flowchart header looks like.
 */
export const FLOW_HEADER_RE = /^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/i;

/**
 * The fishbone keyword really is `ishikawa-beta` in mermaid — the diagram type
 * is still beta and the suffix is part of the keyword, so a body opening with
 * a bare `ishikawa` renders as nothing. Both spellings are *recognised*, so a
 * hand-written one is still reported as a fishbone instead of as unknown text,
 * but only the keyword below is ever inserted.
 */
const ISHIKAWA_RE = /^ishikawa(?:-beta)?\b/i;

export const DIAGRAM_KINDS: DiagramKind[] = [
  {
    id: "mindmap",
    keyword: "mindmap",
    pattern: /^mindmap\b/i,
    mode: "mindmap",
    nameKey: "kind.mindmap.name",
    sceneKey: "kind.mindmap.scene",
    templateKey: "template.kind.mindmap",
  },
  {
    id: "flowchart",
    keyword: "flowchart",
    pattern: FLOW_HEADER_RE,
    mode: "flow",
    nameKey: "kind.flowchart.name",
    sceneKey: "kind.flowchart.scene",
    templateKey: "template.kind.flowchart",
  },
  {
    id: "sequence",
    keyword: "sequenceDiagram",
    pattern: /^sequenceDiagram\b/i,
    mode: "sequence",
    nameKey: "kind.sequence.name",
    sceneKey: "kind.sequence.scene",
    templateKey: "template.kind.sequence",
  },
  {
    id: "class",
    keyword: "classDiagram",
    pattern: /^classDiagram\b/i,
    mode: "class",
    nameKey: "kind.class.name",
    sceneKey: "kind.class.scene",
    templateKey: "template.kind.class",
  },
  {
    id: "state",
    keyword: "stateDiagram-v2",
    // The unsuffixed `stateDiagram` is the older syntax and still valid.
    pattern: /^stateDiagram(?:-v2)?\b/i,
    mode: "state",
    nameKey: "kind.state.name",
    sceneKey: "kind.state.scene",
    templateKey: "template.kind.state",
  },
  {
    id: "er",
    keyword: "erDiagram",
    pattern: /^erDiagram\b/i,
    mode: "er",
    nameKey: "kind.er.name",
    sceneKey: "kind.er.scene",
    templateKey: "template.kind.er",
  },
  {
    id: "gantt",
    keyword: "gantt",
    pattern: /^gantt\b/i,
    mode: "gantt",
    nameKey: "kind.gantt.name",
    sceneKey: "kind.gantt.scene",
    templateKey: "template.kind.gantt",
  },
  {
    id: "pie",
    keyword: "pie",
    pattern: /^pie\b/i,
    mode: "pie",
    nameKey: "kind.pie.name",
    sceneKey: "kind.pie.scene",
    templateKey: "template.kind.pie",
  },
  {
    id: "gitGraph",
    keyword: "gitGraph",
    pattern: /^gitGraph\b/i,
    mode: "gitGraph",
    nameKey: "kind.gitGraph.name",
    sceneKey: "kind.gitGraph.scene",
    templateKey: "template.kind.gitGraph",
  },
  {
    id: "timeline",
    keyword: "timeline",
    pattern: /^timeline\b/i,
    mode: "timeline",
    nameKey: "kind.timeline.name",
    sceneKey: "kind.timeline.scene",
    templateKey: "template.kind.timeline",
  },
  {
    id: "ishikawa",
    keyword: "ishikawa-beta",
    pattern: ISHIKAWA_RE,
    mode: "ishikawa",
    nameKey: "kind.ishikawa.name",
    sceneKey: "kind.ishikawa.scene",
    templateKey: "template.kind.ishikawa",
  },
];

const BY_ID = new Map(DIAGRAM_KINDS.map((kind) => [kind.id, kind]));

/** Throws only on a typo in this plugin's own source, never on user input. */
export function kindById(id: string): DiagramKind {
  const kind = BY_ID.get(id);
  if (!kind) throw new Error(`MarkdownEditorPlus: unknown diagram kind "${id}"`);
  return kind;
}

/** The first line that carries meaning; blank lines and `%%` comments are skipped. */
export function firstMeaningfulLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("%%")) continue;
    return line;
  }
  return "";
}

/**
 * The kind a body declares, or `null` when it declares nothing we recognise.
 *
 * Every kind in the table above has a canvas now, so `detectKind` and
 * `detectMode` answer the same question. They stay separate because they mean
 * different things to their callers: `detectMode` is "can I offer an edit
 * pill", while `detectKind` is also used to *name* a diagram in a failure
 * message — and that stays useful even for a kind we cannot draw.
 */
export function detectKind(text: string): DiagramKind | null {
  const line = firstMeaningfulLine(text);
  if (!line) return null;
  return DIAGRAM_KINDS.find((kind) => kind.pattern.test(line)) ?? null;
}
