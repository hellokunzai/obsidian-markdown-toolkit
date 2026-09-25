/**
 * The inline span both colouring features write, and the rules for reading one
 * back.
 *
 * Font colour and background colour are two buttons over one mechanism. Both
 * put a `span` around a line, both have to recognise their own span later — to
 * replace the value or to take it off — and both are asked to do so on a line
 * that already carries the *other* one's declaration. So the tag is written and
 * read here, once, and each feature supplies only the property it owns.
 *
 * Merging is why this is one file rather than two. Pressing the background
 * colour on a red line has to give `<span style="color:#d83931;background-color:…">`,
 * not a span inside a span: a nested pair is what leaves a note with three tags
 * around one paragraph after a few presses and no way back to plain text except
 * editing the source. Cancelling one of the two properties rewrites the same
 * tag without it, and cancelling the second takes the span away altogether.
 *
 * Two boundaries, both there to keep other people's markup out of this:
 *
 * - Only a `span` that opens with `style="`, ends at the end of the line, and
 *   declares *nothing but* the two properties below counts. Text alignment
 *   writes `<span style="display:block;text-align:left">`, which is therefore
 *   never mistaken for a colour span and never taken apart by one.
 * - A line whose span holds a second `span` is not read as ours at all: the
 *   inner one is somebody's markup, and stripping the outer one would leave
 *   theirs unclosed.
 */

/* ------------------------------------------------------------- properties */

/**
 * The two declarations this plugin writes, in the order they are written.
 *
 * Fixed, rather than whatever order the two buttons happen to be pressed in:
 * the same pair has to come out as the same bytes every time, or "press the
 * same colour again to take it off" would be comparing a tag against a
 * differently ordered copy of itself and conclude it is a different one. The
 * text colour comes first because that is the order of the two toolbar buttons.
 */
export const COLOR_PROPS = ["color", "background-color"] as const;

export type ColorProp = (typeof COLOR_PROPS)[number];

/** The declarations on one span. Both absent is not a state this module writes. */
export type ColorProps = Partial<Record<ColorProp, string>>;

function isColorProp(name: string): name is ColorProp {
  return (COLOR_PROPS as readonly string[]).includes(name);
}

/* ------------------------------------------------------------ normalising */

const HEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const FUNC = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d+(?:\.\d+)?|\.\d+)\s*)?\)$/;

/**
 * A colour code, spelled the one way this module writes and compares it.
 *
 * Accepting the three-digit shorthand as well as the six is a courtesy to
 * whoever is typing a swatch by hand; it is expanded here so that `#f00` and
 * `#ff0000` are the same colour all the way through, rather than two strings
 * that happen to look alike and never compare equal.
 */
export function normalizeHex(value: string): string | null {
  const match = HEX.exec(value.trim());
  if (!match) return null;
  const digits = match[1].toLowerCase();
  return `#${digits.length === 3 ? digits.replace(/./g, (char) => char + char) : digits}`;
}

/**
 * The `rgb()` / `rgba()` spelling, written back in one canonical form.
 *
 * The reference plugin's translucent and highlighter palettes are declared this
 * way, and they are stored and applied as they are declared rather than
 * converted to a hex code: an alpha channel has no hex spelling, and a
 * translucent highlight is the whole point of that half of the palette. What is
 * canonicalised is the *writing* — spacing, leading zeros, and an alpha of 1
 * folded back into `rgb()` — so that `rgba(0,0,0,1)` and `rgb(0,0,0)` compare
 * equal, which is what a second press needs in order to mean "take it off".
 */
export function normalizeRgb(value: string): string | null {
  const match = FUNC.exec(value.trim());
  if (!match) return null;
  const channels = [match[1], match[2], match[3]].map(Number);
  if (channels.some((channel) => channel > 255)) return null;
  const body = channels.join(",");
  if (match[4] === undefined) return `rgb(${body})`;
  const alpha = Number(match[4]);
  if (!(alpha >= 0 && alpha <= 1)) return null;
  return alpha === 1 ? `rgb(${body})` : `rgba(${body},${alpha})`;
}

/** Either spelling, normalised. `null` when the value is not a colour at all. */
export function normalizeColor(value: string): string | null {
  return normalizeHex(value) ?? normalizeRgb(value);
}

/* --------------------------------------------------------------- the tag */

const OPEN_HEAD = '<span style="';
const OPEN_TAIL = '">';
const CLOSE = "</span>";

export interface ColorSpan {
  /** The declarations the span carries — at least one, never none. */
  readonly props: ColorProps;
  /** The line with the span taken off. */
  readonly inner: string;
}

/**
 * The declarations on an opening tag, or `null` if any of them is not ours.
 *
 * All or nothing on purpose: a span carrying one of our properties *and* one it
 * wrote for another purpose is not a span this module may rewrite, because
 * rewriting it would drop the other declaration on the floor.
 */
function readProps(raw: string): ColorProps | null {
  const props: ColorProps = {};
  let count = 0;
  for (const part of raw.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) return null;
    const name = part.slice(0, colon);
    if (!isColorProp(name)) return null;
    if (props[name] !== undefined) return null;
    const value = normalizeColor(part.slice(colon + 1));
    if (!value) return null;
    props[name] = value;
    count += 1;
  }
  return count > 0 ? props : null;
}

/**
 * Whether everything between the outer tags is, as far as spans go, whole.
 *
 * A span *inside* is fine as long as it opens and closes in there: that is the
 * text-alignment tag, and cutting our own outer pair off leaves it untouched.
 * What is not fine is a close tag belonging to a span that opened before the
 * line did — on `<span …>a</span> and <span …>b</span>` the two tags at the ends
 * of the line are two different spans, and taking them off would leave the
 * second one unopened and the first one unclosed. Counting the depth is what
 * tells the two situations apart; refusing every line that mentions a span
 * would refuse the first one too, and nesting a colour span around an aligned
 * paragraph on every press is exactly the pile-up this module exists to avoid.
 */
function enclosesWholeSpans(inner: string): boolean {
  const tags = /<\/?span\b[^>]*>/gi;
  let depth = 0;
  for (let match = tags.exec(inner); match; match = tags.exec(inner)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * The declarations a line is already wrapped in, with its span taken off.
 *
 * Matched from both ends of the line rather than by looking for `color:`
 * anywhere in it, so a span someone wrote for another purpose is not mistaken
 * for this plugin's wrapper.
 */
export function readColorSpan(line: string): ColorSpan | null {
  if (!line.startsWith(OPEN_HEAD) || !line.endsWith(CLOSE)) return null;
  const body = line.slice(OPEN_HEAD.length, line.length - CLOSE.length);
  const head = body.indexOf(OPEN_TAIL);
  if (head < 0) return null;
  const props = readProps(body.slice(0, head));
  if (!props) return null;
  const inner = body.slice(head + OPEN_TAIL.length);
  if (!enclosesWholeSpans(inner)) return null;
  return { props, inner };
}

/** The opening tag for a set of declarations. Never called with none. */
export function openColorTag(props: ColorProps): string {
  const parts: string[] = [];
  for (const prop of COLOR_PROPS) {
    const value = props[prop];
    if (value !== undefined) parts.push(`${prop}:${value}`);
  }
  return `${OPEN_HEAD}${parts.join(";")}${OPEN_TAIL}`;
}

/**
 * One line with `prop` set to `value` — or, when `value` is `null`, with `prop`
 * taken off.
 *
 * This is the whole of what the two features disagree about: font colour calls
 * it with `"color"`, background colour with `"background-color"`, and both get
 * the same treatment of whatever the other one already wrote. The span is
 * rewritten from its declarations rather than spliced, so the property order
 * stays canonical no matter which button was pressed first.
 *
 * Two cases where the answer is the line itself: nothing to take off, and a
 * line that is not wrapped at all. A mutation that would leave the span empty
 * removes the span instead, because an empty pair of tags around the text is
 * not something the user asked for and not something they can see to delete.
 */
export function writeColorProp(line: string, prop: ColorProp, value: string | null): string {
  const span = readColorSpan(line);
  const inner = span ? span.inner : line;
  const props: ColorProps = {};
  let count = 0;
  for (const name of COLOR_PROPS) {
    const carried = span ? span.props[name] : undefined;
    const kept = name === prop ? value ?? undefined : carried;
    if (kept === undefined) continue;
    props[name] = kept;
    count += 1;
  }
  if (count === 0) return inner;
  return `${openColorTag(props)}${inner}${CLOSE}`;
}

/* ------------------------------------------------------------- selecting */

export interface ColorResult {
  /** What the selection should become. */
  readonly text: string;
  /** False when the press could not mean anything, so the caller can say why. */
  readonly changed: boolean;
}

/**
 * Every content line of `text` rewritten with `prop` set — or, for a `null`
 * `value`, with `prop` taken off.
 *
 * A blank line is spacing rather than content, so it is left exactly as it is.
 * That is also what settles the selection of nothing but blank lines without a
 * guard of its own: the map changes nothing, and the caller's comparison then
 * reports that there was nothing to do.
 *
 * One tag per line, rather than one around the block, and that is the reason
 * this is shared rather than written twice: a span opened on the first line of
 * a selection and closed on the last would be split in two by any blank line in
 * between, and the halves would be tags the user has to find and delete by hand.
 *
 * Whether the selection is being coloured or uncoloured is the caller's
 * decision, not this function's: only a feature knows which property it is
 * comparing, and deciding it once for the whole selection — rather than per
 * line — is what keeps a repeat press predictable. A selection that is half one
 * colour and half plain is not "already that colour", so one press makes all of
 * it that colour and a second takes all of it off again.
 */
export function rewriteLines(text: string, prop: ColorProp, value: string | null): string {
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? line : writeColorProp(line, prop, value)))
    .join("\n");
}

/* --------------------------------------------------------------- applying */

/**
 * The whole of what pressing a colour does, for either feature.
 *
 * Every content line already carrying the target value means the press means
 * "take it off"; anything else means "put it on". Deciding once for the whole
 * selection rather than per line is what keeps the result predictable: a
 * selection that is half red and half plain is not "already red", so one press
 * makes all of it red and a second press takes all of it off again.
 *
 * Only `prop` is read and only `prop` is written. A line that also carries the
 * other feature's declaration keeps it, in the same span — a line is not
 * "already red" because it is highlighted, and highlighting it must not undo
 * its text colour.
 *
 * `normalize` is the one thing the two palettes disagree about: the font
 * palette is hex codes, while the background palette includes values with an
 * alpha channel, which have no hex spelling. It is passed in rather than
 * branched on, because *which spellings this feature writes* and *which ones it
 * accepts from a user* are the same question, asked once per feature.
 */
export function applyColorProp(
  text: string,
  prop: ColorProp,
  color: string,
  normalize: (value: string) => string | null
): ColorResult {
  const target = normalize(color);
  if (!target) return { text, changed: false };

  const content = text.split("\n").filter((line) => line.trim() !== "");
  const remove = content.every((line) => readColorSpan(line)?.props[prop] === target);

  const next = rewriteLines(text, prop, remove ? null : target);
  return { text: next, changed: next !== text };
}

/* --------------------------------------------------------------- storage */

/**
 * The swatch list stored in settings, always exactly `count` long.
 *
 * Repaired one slot at a time — padded, cut down, or a single bad value falling
 * back to that slot's default — because a hand-edited `data.json` must not be
 * able to put an unusable swatch, or a gap, into the palette.
 *
 * Normalisation is passed in rather than assumed: which spellings a slot
 * accepts is the one thing the two palettes genuinely differ on, since a
 * translucent highlight cannot be written as a hex code.
 */
export function sanitizeSlots(
  raw: unknown,
  count: number,
  defaults: readonly string[],
  normalize: (value: string) => string | null
): string[] {
  // Re-typed rather than left as the `any[]` that `Array.isArray` narrows to:
  // every element is checked below, and an `any` on the way in is what makes an
  // unchecked one survive to the palette.
  const source: unknown[] = Array.isArray(raw) ? (raw as unknown[]) : [];
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = source[index];
    const fallback = defaults[index];
    out.push(typeof value === "string" ? normalize(value) ?? fallback : fallback);
  }
  return out;
}
