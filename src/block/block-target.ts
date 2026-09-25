import { TFile, type App } from "obsidian";
import { detectMode } from "../core/parse";
import type { DiagramMode } from "../core/model";

/**
 * Locating a fenced block inside a note, and writing a new body back into it.
 *
 * Four rules drive the whole design:
 *
 * 1. **One language, many diagram kinds.** Every diagram lives in a
 *    ```mermaid fence, because that is what the rest of the markdown world
 *    renders. The kind of diagram is therefore *not* in the info string — it is
 *    the first meaningful line of the body (`mindmap`, `flowchart TD`, …). Two
 *    engines can share one language name, so a plain language match would
 *    happily write a mind map into somebody's sequence diagram.
 * 2. **Never overwrite the wrong block.** The rendered element hands us an
 *    occurrence index; that index can drift the moment the user edits the lines
 *    above it. So the index is only a *hint*: it is used when the body still
 *    matches what we rendered, and otherwise we fall back to matching on the
 *    body text.
 * 3. **Always write against the file as it is now.** The write goes through
 *    `Vault.process`, which hands us the current contents, so a save can never
 *    resurrect a stale snapshot over edits made while the editor was open.
 * 4. **Same shape as the reader saw.** A target identifies a block by
 *    `lang + mode`, so a block the user has since retyped into a different kind
 *    of diagram stops matching instead of being clobbered.
 */

export interface Fence {
  /** Info string of the opening fence, lower-cased, first word only. */
  lang: string;
  startLine: number;
  /** Line index of the closing fence. */
  endLine: number;
  body: string;
}

export interface BlockTarget {
  path: string;
  /** Fence info string, e.g. `mermaid`. */
  lang: string;
  /** Which engine owns this block; see rule 1 above. */
  mode: DiagramMode;
  /**
   * Occurrence index among fences that share both `lang` and `mode`, when
   * known. Indexing against every mermaid block in the note would be wrong:
   * that list is what rule 1 exists to avoid.
   */
  index: number | null;
  /** Body we rendered, used to re-find the block. */
  body: string;
}

interface OpenFence {
  char: string;
  length: number;
  lang: string;
  startLine: number;
}

const FENCE_LINE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/;

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Every fenced block in the note, in document order, whatever its language. */
export function listFences(text: string): Fence[] {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const fences: Fence[] = [];
  let open: OpenFence | null = null;

  for (let i = 0; i < lines.length; i++) {
    const match = FENCE_LINE_RE.exec(lines[i]);
    if (!match) continue;
    const marker = match[2];
    const info = match[3];

    if (!open) {
      // An info string may not contain a backtick when the fence is backticks.
      if (marker[0] === "`" && info.includes("`")) continue;
      open = {
        char: marker[0],
        length: marker.length,
        lang: info.trim().split(/\s+/)[0].toLowerCase(),
        startLine: i,
      };
      continue;
    }
    if (marker[0] !== open.char || marker.length < open.length || info.trim()) continue;
    fences.push({
      lang: open.lang,
      startLine: open.startLine,
      endLine: i,
      body: lines.slice(open.startLine + 1, i).join(eol),
    });
    open = null;
  }
  return fences;
}

function sameBody(a: string, b: string): boolean {
  return a.replace(/\r\n/g, "\n").trim() === b.replace(/\r\n/g, "\n").trim();
}

/**
 * The fences that belong to the same engine as the target.
 *
 * Sharing one fence language means a language match alone is not enough: a note
 * with a mind map and a sequence diagram has two `mermaid` blocks, and taking
 * "the first mermaid block" would point a mind map write at the sequence
 * diagram. `detectMode` reads the body's first meaningful line to tell them
 * apart; anything it does not recognise is deliberately not ours to touch.
 */
export function siblingFences(
  text: string,
  target: Pick<BlockTarget, "lang" | "mode">
): Fence[] {
  return listFences(text).filter(
    (fence) => fence.lang === target.lang && detectMode(fence.body) === target.mode
  );
}

/** The block a target points at, or `null` when it can no longer be identified. */
export function findBlock(text: string, target: BlockTarget): Fence | null {
  const candidates = siblingFences(text, target);
  if (!candidates.length) return null;

  const atIndex = target.index !== null ? candidates[target.index] : undefined;
  if (atIndex && sameBody(atIndex.body, target.body)) return atIndex;

  const byBody = candidates.find((fence) => sameBody(fence.body, target.body));
  if (byBody) return byBody;

  // Nothing matches any more: the block was rewritten or moved. Replacing by
  // index blindly would clobber whatever is there now, so only the unambiguous
  // case (exactly one block of this kind) is allowed through.
  if (candidates.length === 1) return candidates[0];
  if (atIndex) return atIndex;
  return null;
}

export function replaceFenceBody(text: string, fence: Fence, body: string): string {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const trimmed = body.replace(/\r?\n+$/, "");
  const replacement = trimmed.length ? trimmed.split(/\r?\n/) : [];
  return [...lines.slice(0, fence.startLine + 1), ...replacement, ...lines.slice(fence.endLine)].join(eol);
}

/**
 * Writes `body` into the targeted block. Returns false when the block could not
 * be located — the caller turns that into a message instead of guessing.
 */
export async function writeBlock(app: App, target: BlockTarget, body: string): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(target.path);
  if (!(file instanceof TFile)) return false;

  try {
    await app.vault.process(file, (data) => {
      const fence = findBlock(data, target);
      if (!fence) return data;
      return replaceFenceBody(data, fence, body);
    });
    return true;
  } catch (error) {
    console.error("MarkdownEditorPlus: could not write diagram block", error);
    return false;
  }
}
