/**
 * The colour panel, and the two glyphs that open it.
 *
 * One panel serves both colouring features: they draw the same kind of thing —
 * a few captioned bands of swatches with a small form under them — and differ
 * only in the colours, the captions and whether the swatches are squares ten to
 * a row or circles five to a row. Everything else is the same, and the parts
 * that are *not* the same are the interesting ones, so they are options rather
 * than a second copy of this file.
 *
 * A third caller arrived with the toolbar's own background colour, which is
 * what `ColorMarkCell` is for: it offers two choices no swatch can paint ("let
 * the theme decide", "no colour at all"), and a panel that could only hold
 * colour codes would have had to drop them or draw them as two blank cells.
 *
 * Drawn by hand rather than built from Obsidian's `Menu`: a `Menu` holds a list
 * of rows, and these are grids of sixty and twenty-five swatches with three
 * bands and a form under them. No shape of `Menu` holds that.
 *
 * Living outside the editor means four things have to be looked after by hand
 * that a `Menu` would have handled: the placement (under the button, flipped up
 * when there is no room below, clamped to the viewport), the ways out (Escape,
 * a press outside, a scroll), the listeners — which is why `close` is the only
 * exit and every path goes through it — and the window it is built in, since
 * Obsidian may have more than one and a panel in the wrong one is invisible
 * without being wrong (see `homeOf`).
 *
 * The glyphs are registered from this file because they belong to the panel:
 * both are drawn by hand, and the name each one is registered under is declared
 * beside the panel that asks for it rather than in an icon file of its own.
 */

import { addIcon, setIcon } from "obsidian";
import { t } from "../i18n";
import { h } from "../utils/dom";

/* ----------------------------------------------------------------- glyphs */

/**
 * The toolbar glyphs: a letter A with a rule under it, and a tilted marker
 * drawing that rule.
 *
 * Keyed by the literal rather than by the constants in `core/`, because the
 * icon-name checker learns which names a plugin registers by reading *this
 * table* — a computed key would leave it unable to tell a self-drawn icon from
 * a typo in one. Each core module declares the name the toolbar asks for, and
 * the smoke test drives the registration below to confirm the spellings still
 * agree.
 *
 * The marker is drawn from the reference plugin's own icon, which no longer
 * ships: its proportions were measured off a screenshot of the toolbar button —
 * the head is a tilted rhombus, the nib a wedge off its lower-left corner, and
 * the green rule under it starts at the nib and is as wide as the head.
 */
const ICONS: Record<string, string> = {
  "mtk-font-color": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5 10 5l5.5 11.5"/><path d="M6.7 12.6h6.6"/><path d="M4 20.5h16" stroke="#22b573"/></svg>`,
  "mtk-background-color": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.1 1.6 20.4 10.4 13.6 14.6 7.3 8.3z"/><path d="M7.3 8.3 4.1 18.3 13.6 14.6"/><path d="M5.2 21h12.6" stroke="#22b573"/></svg>`,
};

/** Makes the glyphs above available to `setIcon`. Called once, from `onload`. */
export function registerColorIcons(): void {
  for (const [id, svg] of Object.entries(ICONS)) addIcon(id, svg);
}

/* ---------------------------------------------------------------- geometry */

/** Just the four edges — what a `DOMRect` and the caret both can give. */
interface AnchorRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const MARGIN = 8;
const GAP = 4;

/* ----------------------------------------------------------------- windows */

/**
 * The window and the document an element actually lives in.
 *
 * `window` and `document` are the *first* window's, and Obsidian can have more
 * than one: a pop-out window shares this JavaScript context, so a button inside
 * one hands its click to code that reads `document` and gets the other. The
 * names Obsidian provides say what the problem is — `activeWindow` exists
 * because `window` is not always the window being looked at — and its own
 * `Modal.open` parents itself to `activeWindow.document.body` rather than to
 * `document.body` for that reason.
 *
 * A panel put in the wrong window fails in the one way nothing reports: it is
 * built, filled, placed and layered, in a window nobody is looking at, while
 * the button that asked for it sits in the right one and appears dead. Every
 * number involved is plausible, because every measurement was taken — just in
 * the other window, whose viewport and scroll position have nothing to do with
 * the anchor's.
 *
 * The caller's own element knows which document it is in, so that is what
 * decides. `activeDocument` answers only for a panel with no anchor at all —
 * the command palette and the hotkey, which is the case Obsidian's global is
 * for; it is guarded because the plugin's `minAppVersion` is older than it.
 */
interface Home {
  readonly doc: Document;
  readonly win: Window;
}

function homeOf(anchor: HTMLElement | null): Home {
  const doc =
    anchor?.ownerDocument ??
    (typeof activeDocument === "undefined" ? document : activeDocument);
  /* A document made by `createHTMLDocument` has no window of its own. The
     global one is then only ever used for measuring, and the panel is not in
     it either way, so there is nothing to be wrong about. */
  return { doc, win: doc.defaultView ?? window };
}

/* ------------------------------------------------------------------- layer */

/** How far above whatever contains it the panel is drawn. */
const LAYER_GAP = 5;
/** Obsidian's `--layer-modal`, for the case where the variable cannot be read. */
const FALLBACK_MODAL_LAYER = 50;

/**
 * Which layer the panel is drawn in.
 *
 * The panel is parented to the document body, which makes it a *sibling* of
 * whatever opened it rather than a child of it. A caller inside a modal — the
 * settings tab is one, `.modal-container` at `--layer-modal` — therefore leaves
 * the panel and the dialog as two boxes in one stacking context, and from then
 * on nothing but those two numbers decides which of them a user can see or
 * press. A number that is too low breaks nothing it can be caught by: the panel
 * is still built, still filled, still placed under the button, and painted
 * behind the dialog, so the only symptom is a button that does nothing.
 *
 * Measured rather than declared, and measured *here* rather than in the
 * stylesheet, for two reasons that have each cost a round:
 *
 * - the dialog's number is not always the ladder's. A theme may put it wherever
 *   it likes, and that number sits on the way up from the anchor — so reading
 *   the anchor's own chain follows it. A constant that was right yesterday
 *   fails silently the day a theme (or the host) moves the dialog;
 * - `styles.css` is a file in someone's vault. One from before this rule
 *   existed, or one that never got copied over, is a vault that paints the
 *   panel at the old layer again — the bug exactly as it was, with the fix
 *   sitting right there in the repository. Inline, the layer travels with the
 *   code that needs it instead.
 *
 * The ladder stays in as a floor, so the ordinary case — nothing on the chain
 * positioned, as in the editor toolbar — still clears a dialog. `auto` parses
 * to NaN and is skipped, which is what makes "positioned ancestors only" fall
 * out of the loop rather than out of a test for it.
 *
 * Measured through the anchor's own window and read from its own body: the
 * dialog this has to clear is the one in *that* document, and the variable is
 * declared on that document's `body`, so the other window's copy of either is
 * not the same number.
 */
function panelLayer(anchor: HTMLElement | null, home: Home): number {
  const view = home.win;
  const body = home.doc.body;
  const ladder = Number.parseInt(
    body ? view.getComputedStyle(body).getPropertyValue("--layer-modal") : "",
    10
  );
  let top = Number.isFinite(ladder) ? ladder : FALLBACK_MODAL_LAYER;
  for (let el: HTMLElement | null = anchor; el; el = el.parentElement) {
    const z = Number.parseInt(view.getComputedStyle(el).zIndex, 10);
    if (Number.isFinite(z) && z > top) top = z;
  }
  return top + LAYER_GAP;
}

/**
 * Where the caret is on screen.
 *
 * Used when the panel is opened from the command palette or a hotkey, where
 * there is no button to hang it off. The editor keeps its DOM selection while
 * the palette is closed, so the browser can still answer this — read from the
 * window the panel is going into, since a selection belongs to a document.
 */
function caretRect(view: Window): AnchorRect | null {
  const selection = view.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
}

/* ------------------------------------------------------------- eyedropper */

interface EyeDropperInstance {
  open(): Promise<{ sRGBHex: string }>;
}

type EyeDropperCtor = new () => EyeDropperInstance;

/**
 * The system colour picker, if this Obsidian has one.
 *
 * Feature-detected rather than assumed: the API arrived in Chromium 95 and
 * Electron ships whichever Chromium it ships, while `minAppVersion` here is
 * 1.4.16. Where it is missing the eyedropper button does what the palette
 * button does, so the press is never a dead end.
 *
 * Looked up on the window the panel is in rather than on `window`, since the
 * constructor is a property of a window and the two are not interchangeable.
 */
function eyeDropperCtor(view: Window): EyeDropperCtor | null {
  const ctor = (view as unknown as { EyeDropper?: unknown }).EyeDropper;
  return typeof ctor === "function" ? (ctor as EyeDropperCtor) : null;
}

/* ------------------------------------------------------------------ panel */

/**
 * A swatch whose value is not a colour a browser paints.
 *
 * Two of the choices a colour picker can honestly offer are not colours: "no
 * override, the theme decides", and "no colour at all". Handed to `buildBand`
 * as bare strings they would be painted with nothing, which draws them exactly
 * like a swatch that failed to load — so they name themselves instead, and say
 * which of the two ways to draw them.
 */
export interface ColorMarkCell {
  /** The value handed to `onPick` — what the caller writes down. */
  readonly value: string;
  /** What it is called, in the tooltip and to a screen reader. */
  readonly label: string;
  /**
   * How to draw it. `"theme"` is the theme's own surface with a sun/moon over
   * it: the colour is deliberately not the point of the choice. `"none"` is
   * the checkerboard, which is what "nothing here" has always looked like.
   */
  readonly mark: "theme" | "none";
}

/** A cell of a band: a colour code, or a value that has to be drawn its own way. */
export type ColorCell = string | ColorMarkCell;

/** One captioned row group of swatches. */
export interface ColorBand {
  /** The heading above the swatches. */
  readonly caption: string;
  /** The swatches, in the order they are drawn. */
  readonly colors: readonly ColorCell[];
}

export interface ColorPickerOptions {
  /** What the panel is called, to a screen reader and to the user's tooltip. */
  readonly title: string;
  readonly bands: readonly ColorBand[];
  /**
   * Draw the swatches as circles, five to a row, rather than as 16px squares
   * ten to a row. Both are the reference plugin's own shapes: its palette is
   * Office's swatch table, and its highlighters are pen caps.
   */
  readonly round: boolean;
  /** The button to hang the panel off; `null` opens it at the caret instead. */
  readonly anchor: HTMLElement | null;
  /**
   * Which spellings a typed colour may use.
   *
   * Passed in rather than fixed here because it is the same policy the feature
   * applies with: the font palette is hex codes, and a panel that accepted an
   * `rgba()` value for it would hand the editor a colour that feature then has
   * to refuse.
   */
  readonly accepts: (value: string) => string | null;
  /**
   * What the caller is using now, when it knows.
   *
   * Only the cell that carries exactly this value is marked, and only when one
   * does — the two colouring features open the panel over a selection that can
   * be any colour at all, so for them nothing matches and nothing is marked.
   */
  readonly current?: string;
  /**
   * What the hex field's placeholder says.
   *
   * Defaults to the hex-only wording, which is right for the two palettes.
   * A caller whose field also takes `var(--…)` has to say so, or the box would
   * describe a narrower set of accepted spellings than `accepts` implements.
   */
  readonly hexPlaceholder?: string;
  /**
   * What the panel says when a typed colour is refused.
   *
   * Defaults to the hex-only wording, for the same reason as the placeholder:
   * a caller that also takes `var(--…)` has to say what it does take, or the
   * refusal would name a narrower set of spellings than the field implements.
   */
  readonly invalidHint?: string;
  /** What the hex field opens with, when the user asks for it. */
  readonly seed: string;
  /** Called once, with a colour in the spelling the feature writes. */
  readonly onPick: (color: string) => void;
}

/**
 * How the open panel is taken down.
 *
 * Held at module scope so the toolbar can close it when it goes away — a panel
 * left behind by an unloaded plugin would sit over the editor with no button
 * left to dismiss it. It is a closure rather than the instance because what the
 * caller wants is the one verb, not the panel.
 */
let closeActive: (() => void) | null = null;

/** Closes the open panel, if there is one. */
export function closeColorPicker(): void {
  closeActive?.();
}

export class ColorPickerPanel {
  private readonly options: ColorPickerOptions;
  /**
   * The window the panel was opened into.
   *
   * Kept because the listeners were attached to *that* window's document and
   * have to come off it again — a panel closed through the other window would
   * leave its Escape key and its press-outside handler behind for good.
   */
  private home: Home | null = null;
  private el: HTMLElement | null = null;
  private hexRow: HTMLElement | null = null;
  private hexInput: HTMLInputElement | null = null;
  private hint: HTMLElement | null = null;

  constructor(options: ColorPickerOptions) {
    this.options = options;
  }

  open(): void {
    // One at a time: a second panel would sit on top of the first, and the
    // first would keep its `document` listeners for as long as it lived.
    closeColorPicker();

    // Which window the anchor is in decides both where the panel is put and
    // how big the space around it is — see `homeOf`.
    const anchor = this.options.anchor ?? null;
    const home = homeOf(anchor);

    // Measured before it can be seen, so its first painted frame is already in
    // place rather than at the corner of the window. Classes rather than inline
    // styles, because the panel is themed like the rest of the plugin.
    const panel = h("div", {
      cls: this.options.round ? "mtk-color-panel is-round is-measuring" : "mtk-color-panel is-measuring",
      attr: { role: "dialog", "aria-label": this.options.title, tabindex: "-1" },
    });
    for (const band of this.options.bands) panel.appendChild(this.buildBand(band));
    panel.appendChild(this.buildFooter());
    this.hint = h("p", { cls: "mtk-color-hint" });
    panel.appendChild(this.hint);

    /* Into the anchor's own window, not into `document.body`: in a pop-out
       those are two different places, and the one the user is looking at is
       the anchor's. */
    home.doc.body.appendChild(panel);
    this.el = panel;
    this.home = home;
    /* Class, not an inline `position`, and before the first paint. The layer is
       measured here (see `panelLayer`). `position` is repeated from the
       stylesheet via `.mtk-color-panel.is-fixed` so that a vault carrying an
       older `styles.css` still gets a panel in the viewport's coordinate space
       rather than one laid out in the flow at the end of the body, under the
       last thing on the page and out of sight. The z-index has to stay inline:
       it is computed from the anchor at open time, so no stylesheet value can
       stand in for it. */
    panel.classList.add("is-fixed");
    panel.style.zIndex = String(panelLayer(anchor, home));
    this.place(home);
    panel.classList.remove("is-measuring");

    // An arrow rather than the instance: the module-level holder is what lets
    // the toolbar take the panel down when the toolbar itself goes away.
    closeActive = () => this.close();
    home.doc.addEventListener("mousedown", this.handleOutside, true);
    home.win.addEventListener("scroll", this.handleScroll, true);
    home.win.addEventListener("resize", this.handleScroll);
    home.doc.addEventListener("keydown", this.handleKey, true);
    panel.focus();
  }

  close(): void {
    if (!this.el) return;
    const home = this.home ?? homeOf(null);
    home.doc.removeEventListener("mousedown", this.handleOutside, true);
    home.win.removeEventListener("scroll", this.handleScroll, true);
    home.win.removeEventListener("resize", this.handleScroll);
    home.doc.removeEventListener("keydown", this.handleKey, true);
    this.el.remove();
    this.el = null;
    this.home = null;
    this.hexRow = null;
    this.hexInput = null;
    this.hint = null;
    closeActive = null;
  }

  /* ------------------------------------------------------------- building */

  /** One band: a caption and the swatches under it. */
  private buildBand(band: ColorBand): HTMLElement {
    const box = h("div", { cls: "mtk-color-band" });
    box.appendChild(h("div", { cls: "mtk-color-caption", text: band.caption }));

    const grid = h("div", { cls: "mtk-color-grid" });
    for (const cell of band.colors) {
      // Two shapes in one list. A colour code is its own label and its own
      // paint; everything else arrives already described, and `mark` is what
      // tells the two apart — so it is read once rather than re-tested.
      const mark = typeof cell === "string" ? null : cell.mark;
      const value = typeof cell === "string" ? cell : cell.value;
      // A colour code is its own name: it is what the user is choosing, and it
      // reads the same in every language.
      const label = typeof cell === "string" ? cell : cell.label;
      const classes = ["mtk-color-swatch"];
      if (mark) classes.push(`is-${mark}`);
      if (value === this.options.current) classes.push("is-active");
      const swatch = h("button", {
        cls: classes.join(" "),
        attr: { type: "button", "aria-label": label, title: label },
      });
      // Nothing to paint for the two marks: `is-theme` borrows the panel's own
      // surface and puts the glyph on it, `is-none` draws the checkerboard.
      if (mark === "theme") setIcon(swatch, "sun-moon");
      else if (mark === null) swatch.style.backgroundColor = value;
      swatch.addEventListener("click", () => this.pick(value));
      grid.appendChild(swatch);
    }
    box.appendChild(grid);
    return box;
  }

  private buildFooter(): HTMLElement {
    const footer = h("div", { cls: "mtk-color-footer" });
    footer.appendChild(this.buildTool("pipette", t("color.panel.eyedropper"), () => this.sampleScreen()));
    footer.appendChild(this.buildTool("palette", t("color.panel.palette"), () => this.revealHex()));

    // A form rather than a bare div, so Enter in the field submits it without a
    // key handler of its own.
    this.hexRow = h("form", { cls: "mtk-color-hex is-hidden" });
    this.hexInput = h("input", {
      cls: "mtk-color-hex-input",
      attr: {
        type: "text",
        placeholder: this.options.hexPlaceholder ?? t("color.panel.hexPlaceholder"),
        "aria-label": t("color.panel.hexLabel"),
        spellcheck: "false",
        autocomplete: "off",
      },
    });
    /* The refusal is taken back as soon as the user starts fixing it, not at
       the next blur: the character that is wrong is usually one they can see,
       and a red sentence left under a box they have already corrected reads as
       a second mistake. */
    this.hexInput.addEventListener("input", () => {
      this.hexInput?.classList.remove("is-invalid");
      this.hexInput?.removeAttribute("aria-invalid");
      if (this.hint) this.hint.textContent = "";
    });
    this.hexRow.appendChild(this.hexInput);
    this.hexRow.appendChild(
      h("button", { cls: "mtk-color-hex-apply", text: t("color.panel.apply"), attr: { type: "submit" } })
    );
    this.hexRow.addEventListener("submit", (event) => {
      event.preventDefault();
      this.commitHex();
    });
    footer.appendChild(this.hexRow);

    return footer;
  }

  private buildTool(icon: string, label: string, onClick: () => void): HTMLElement {
    const button = h("button", {
      cls: "clickable-icon mtk-color-tool",
      attr: { type: "button", "aria-label": label, title: label },
    });
    setIcon(button, icon);
    button.addEventListener("click", onClick);
    return button;
  }

  /* -------------------------------------------------------------- actions */

  private pick(color: string): void {
    // Closed before the callback runs: applying moves the editor's selection,
    // and the editor scrolls its caret into view — which would close a panel
    // that was still listening.
    this.close();
    this.options.onPick(color);
  }

  private revealHex(): void {
    this.hexRow?.classList.remove("is-hidden");
    if (this.hexInput && this.hexInput.value === "") this.hexInput.value = this.options.seed;
    this.hexInput?.focus();
    this.hexInput?.select();
  }

  private commitHex(): void {
    const input = this.hexInput;
    if (!input) return;
    const color = this.options.accepts(input.value);
    if (!color) {
      input.classList.add("is-invalid");
      // Stated rather than only coloured: a border that turns red says nothing
      // to a screen reader, and nothing at all to anyone who cannot see it.
      input.setAttribute("aria-invalid", "true");
      if (this.hint) this.hint.textContent = this.options.invalidHint ?? t("color.panel.invalid");
      input.focus();
      return;
    }
    this.pick(color);
  }

  /**
   * Asks the system for a colour, falling back to the hex field.
   *
   * The rejection is the user pressing Escape in the system picker, which is a
   * decision rather than a failure: this panel stays open on the swatches, so
   * the next press can be a different one.
   */
  private sampleScreen(): void {
    // The panel's own window: the constructor hangs off a window, not off the
    // picker, so a pop-out asks its own.
    const Ctor = eyeDropperCtor(this.home?.win ?? window);
    if (!Ctor) {
      this.revealHex();
      return;
    }
    void new Ctor().open().then(
      (result) => {
        const color = this.options.accepts(result.sRGBHex);
        if (color) this.pick(color);
      },
      () => undefined
    );
  }

  /* ------------------------------------------------------------ placement */

  private place(home: Home): void {
    const el = this.el;
    if (!el) return;

    /* The anchor's rect and the viewport it has to fit in come from the same
       window, which is the whole point: a rect is measured against the viewport
       that contains it, so pairing one window's rect with another's width puts
       the panel wherever the two happen to disagree — the middle of a screen
       neither element is on. */
    const view = home.win;
    const rect = this.options.anchor?.getBoundingClientRect() ?? caretRect(view);
    const width = el.offsetWidth;
    const height = el.offsetHeight;

    let left = rect ? rect.left : view.innerWidth / 2 - width / 2;
    let top = rect ? rect.bottom + GAP : MARGIN + 64;

    // Below the anchor is where it belongs; above it is where it fits when the
    // button is near the foot of the window — which it is for anyone who has
    // scrolled their editor to the bottom.
    if (top + height > view.innerHeight - MARGIN) {
      const flipped = rect ? rect.top - GAP - height : top;
      top = flipped >= MARGIN ? flipped : Math.max(MARGIN, view.innerHeight - MARGIN - height);
    }
    left = Math.max(MARGIN, Math.min(left, view.innerWidth - MARGIN - width));

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  /* ------------------------------------------------------------- handlers */

  private readonly handleOutside = (event: MouseEvent): void => {
    const target = event.target as Node | null;
    if (this.el && target && this.el.contains(target)) return;
    this.close();
  };

  private readonly handleScroll = (): void => {
    this.close();
  };

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    }
  };
}
