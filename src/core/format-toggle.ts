/**
 * Surrounding a selection with a pair of markers, and taking them off again.
 *
 * Markdown has no underline, so the toolbar writes the HTML tag Obsidian
 * renders instead — but the arithmetic is the same for any prefix/suffix pair,
 * and it lives here rather than in the editor callback so it can be exercised
 * without an editor, a vault or a DOM: the input is a document string plus two
 * offsets, and the output is the one span the caller should replace.
 *
 * Everything is offsets rather than line/column pairs, which is what makes a
 * selection spanning several lines work: a column-based implementation has to
 * decide what "four characters before the start" means on a different line.
 */

export interface ToggleSpan {
  /** Start offset of the span to replace. */
  from: number;
  /** End offset (exclusive) of that span. */
  to: number;
  /** What the document should hold between `from` and `to` afterwards. */
  insert: string;
  /** Selection start afterwards, in the coordinates of the new document. */
  selStart: number;
  /** Selection end afterwards, in the coordinates of the new document. */
  selEnd: number;
}

/**
 * Whether `marker` sits at `at`.
 *
 * Compared case-insensitively because HTML tag names are: a `<U>` someone
 * pasted out of a web page is the same tag, and the marker's length is what
 * every offset below is computed from. A negative or out-of-range `at` is not
 * a match — `slice` would otherwise count back from the end of the document
 * and invent a match near a tag that is not there.
 */
function markerAt(doc: string, at: number, marker: string): boolean {
  if (at < 0 || at + marker.length > doc.length) return false;
  return doc.slice(at, at + marker.length).toLowerCase() === marker.toLowerCase();
}

/**
 * What to do so that the selection ends up wrapped exactly once by
 * `prefix`/`suffix`, or unwrapped when it already is.
 *
 * Four cases, in the order they are tested:
 *
 * 1. The cursor sits between an empty pair (`<u>|</u>`) — both tags go, since
 *    the pair already encloses nothing.
 * 2. Something is selected and the pair sits *outside* it — the tags go, and
 *    the selection keeps covering the text it covered.
 * 3. The selection *is* the pair (`<u>word</u>`) — that happens when someone
 *    selects a whole underlined word, and wrapping it again would nest tags,
 *    so the pair is stripped instead.
 * 4. Anything else — the pair is added, and the selection is left covering the
 *    inner text, so pressing the button again undoes it.
 *
 * An empty selection that is *not* inside an empty pair falls to case 4: the
 * pair is inserted and the caret lands between the two tags, which lets the
 * user type the underlined text straight away.
 */
export function toggleWrap(
  doc: string,
  start: number,
  end: number,
  prefix: string,
  suffix: string
): ToggleSpan {
  const open = prefix.length;
  const close = suffix.length;
  const inner = doc.slice(start, end);

  if (start === end && markerAt(doc, start - open, prefix) && markerAt(doc, start, suffix)) {
    return {
      from: start - open,
      to: start + close,
      insert: "",
      selStart: start - open,
      selEnd: start - open,
    };
  }

  if (markerAt(doc, start - open, prefix) && markerAt(doc, end, suffix)) {
    return {
      from: start - open,
      to: end + close,
      insert: inner,
      selStart: start - open,
      selEnd: end - open,
    };
  }

  if (end - start >= open + close && markerAt(doc, start, prefix) && markerAt(doc, end - close, suffix)) {
    const text = inner.slice(open, inner.length - close);
    return { from: start, to: end, insert: text, selStart: start, selEnd: start + text.length };
  }

  return {
    from: start,
    to: end,
    insert: `${prefix}${inner}${suffix}`,
    selStart: start + open,
    selEnd: end + open,
  };
}
