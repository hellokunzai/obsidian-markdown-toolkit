/**
 * Markdown outline -> mind map body.
 *
 * Turns the thing people already wrote (headings, nested bullets, numbered
 * lists) into the indented text mermaid's `mindmap` expects. Anything the
 * recogniser does not understand is skipped rather than guessed at, because a
 * wrong structure is worse than a missing line.
 */

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

const MAX_DEPTH = 8;

/** Removes the inline markdown that only adds noise inside a diagram node. */
export function stripInlineMarkup(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

interface OutlineItem {
  depth: number;
  text: string;
}

export function outlineToItems(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const heading = HEADING_RE.exec(raw);
    if (heading) {
      const body = stripInlineMarkup(heading[2]);
      if (body) items.push({ depth: heading[1].length - 1, text: body });
      continue;
    }
    const bullet = BULLET_RE.exec(raw);
    if (bullet) {
      const body = stripInlineMarkup(bullet[2]);
      if (!body) continue;
      // A bullet sits one level under the deepest heading that preceded it.
      const headingDepth = items.length
        ? items.reduce((max, item) => (item.depth > max ? item.depth : max), 0)
        : 0;
      const indentLevel = Math.floor(bullet[1].replace(/\t/g, "  ").length / 2);
      items.push({ depth: headingDepth + 1 + indentLevel, text: body });
    }
  }
  return items;
}

function needsQuoting(text: string): boolean {
  return /[[](){}"|]/.test(text);
}

function nodeToken(text: string): string {
  return needsQuoting(text) ? `["${text.replace(/"/g, "#quot;")}"]` : `[${text}]`;
}

/**
 * `rootTitle` is only used when the selection has no single top item — without
 * a root, mermaid's `mindmap` grammar has nothing to hang the tree on.
 */
export function outlineToMindmapBody(text: string, rootTitle: string): string | null {
  const items = outlineToItems(text);
  if (!items.length) return null;

  const min = items.reduce((lowest, item) => Math.min(lowest, item.depth), Infinity);
  const lines: string[] = ["mindmap"];

  const roots = items.filter((item) => item.depth === min);
  const shareRoot = roots.length > 1;
  if (shareRoot) lines.push(`  ${nodeToken(rootTitle)}`);

  let previousDepth = min;
  for (const item of items) {
    const depth = Math.min(MAX_DEPTH, item.depth - min) + (shareRoot ? 1 : 0);
    // Deep jumps (a bullet under a skipped heading level) are clamped so the
    // emitted indentation always grows by one step at a time.
    previousDepth = Math.min(depth, previousDepth + 1);
    lines.push(`${"  ".repeat(previousDepth + 1)}${nodeToken(item.text)}`);
  }
  return lines.join("\n");
}
