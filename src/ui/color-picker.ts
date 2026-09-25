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
 * Drawn by hand rather than built from Obsidian's `Menu`: a `Menu` holds a list
 * of rows, and these are grids of sixty and twenty-five swatches with three
 * bands and a form under them. No shape of `Menu` holds that.
 *
 * Living outside the editor means three things have to be looked after by hand
 * that a `Menu` would have handled: the placement (under the button, flipped up
 * when there is no room below, clamped to the viewport), the ways out (Escape,
 * a press outside, a scroll), and the listeners — which is why `close` is the
 * only exit and every path goes through it.
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

/**
 * Where the caret is on screen.
 *
 * Used when the panel is opened from the command palette or a hotkey, where
 * there is no button to hang it off. The editor keeps its DOM selection while
 * the palette is closed, so the browser can still answer this.
 */
function caretRect(): AnchorRect | null {
  const selection = window.getSelection();
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
 */
function eyeDropperCtor(): EyeDropperCtor | null {
  const ctor = (window as unknown as { EyeDropper?: unknown }).EyeDropper;
  return typeof ctor === "function" ? (ctor as EyeDropperCtor) : null;
}

/* ------------------------------------------------------------------ panel */

/** One captioned row group of swatches. */
export interface ColorBand {
  /** The heading above the swatches. */
  readonly caption: string;
  /** The swatches, in the order they are drawn. */
  readonly colors: readonly string[];
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

    document.body.appendChild(panel);
    this.el = panel;
    this.place();
    panel.classList.remove("is-measuring");

    // An arrow rather than the instance: the module-level holder is what lets
    // the toolbar take the panel down when the toolbar itself goes away.
    closeActive = () => this.close();
    document.addEventListener("mousedown", this.handleOutside, true);
    window.addEventListener("scroll", this.handleScroll, true);
    window.addEventListener("resize", this.handleScroll);
    document.addEventListener("keydown", this.handleKey, true);
    panel.focus();
  }

  close(): void {
    if (!this.el) return;
    document.removeEventListener("mousedown", this.handleOutside, true);
    window.removeEventListener("scroll", this.handleScroll, true);
    window.removeEventListener("resize", this.handleScroll);
    document.removeEventListener("keydown", this.handleKey, true);
    this.el.remove();
    this.el = null;
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
    for (const color of band.colors) {
      const swatch = h("button", {
        cls: "mtk-color-swatch",
        // The colour code is its own label: it is what the user is choosing,
        // and it reads the same in every language.
        attr: { type: "button", "aria-label": color, title: color },
      });
      swatch.style.backgroundColor = color;
      swatch.addEventListener("click", () => this.pick(color));
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
        placeholder: t("color.panel.hexPlaceholder"),
        "aria-label": t("color.panel.hexLabel"),
        spellcheck: "false",
        autocomplete: "off",
      },
    });
    this.hexInput.addEventListener("input", () => this.hexInput?.classList.remove("is-invalid"));
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
      if (this.hint) this.hint.textContent = t("color.panel.invalid");
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
    const Ctor = eyeDropperCtor();
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

  private place(): void {
    const el = this.el;
    if (!el) return;

    const rect = this.options.anchor?.getBoundingClientRect() ?? caretRect();
    const width = el.offsetWidth;
    const height = el.offsetHeight;

    let left = rect ? rect.left : window.innerWidth / 2 - width / 2;
    let top = rect ? rect.bottom + GAP : MARGIN + 64;

    // Below the anchor is where it belongs; above it is where it fits when the
    // button is near the foot of the window — which it is for anyone who has
    // scrolled their editor to the bottom.
    if (top + height > window.innerHeight - MARGIN) {
      const flipped = rect ? rect.top - GAP - height : top;
      top = flipped >= MARGIN ? flipped : Math.max(MARGIN, window.innerHeight - MARGIN - height);
    }
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - MARGIN - width));

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
