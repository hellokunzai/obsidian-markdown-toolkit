/**
 * The dialog behind the text tools that need an argument.
 *
 * Three of the fifteen tools (add prefix/suffix, add line numbers, extract
 * between strings) cannot work from the selection alone, and they need one or
 * two short strings, never a form. So this is a single generic dialog rather
 * than three: the caller describes its fields, and the validation callback
 * returns a message to show inline instead of closing.
 *
 * Reporting a bad value in the dialog rather than through a `Notice` matters
 * here because the value is what the user is looking at — a toast that fades
 * out leaves them staring at a field with no idea what was wrong with it.
 */
import { Modal, type App } from "obsidian";
import { h } from "../utils/dom";
import { t } from "../i18n";

export interface TextToolField {
  /** Key the value is reported back under. */
  key: string;
  label: string;
  placeholder?: string;
  value?: string;
  /** Shown under the input, for formats that need explaining. */
  hint?: string;
}

export class TextToolModal extends Modal {
  private readonly heading: string;
  private readonly note: string;
  private readonly fields: readonly TextToolField[];
  private readonly submitLabel: string;
  /**
   * Returns `null` to accept and close, or a message to show in the dialog and
   * stay open. Validation lives with the caller because only it knows the tool.
   */
  private readonly onSubmit: (values: Record<string, string>) => string | null;
  private readonly inputs = new Map<string, HTMLInputElement>();
  private errorEl: HTMLElement | null = null;

  constructor(
    app: App,
    heading: string,
    note: string,
    fields: readonly TextToolField[],
    submitLabel: string,
    onSubmit: (values: Record<string, string>) => string | null
  ) {
    super(app);
    this.heading = heading;
    this.note = note;
    this.fields = fields;
    this.submitLabel = submitLabel;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.appendChild(h("h3", { text: this.heading }));
    if (this.note) contentEl.appendChild(h("p", { cls: "mtk-settings-note", text: this.note }));

    for (const field of this.fields) {
      const row = h("div", { cls: "mtk-field" });
      row.appendChild(h("label", { cls: "mtk-field-label", text: field.label }));

      const input = h("input", {
        cls: "mtk-input",
        attr: { type: "text", placeholder: field.placeholder ?? "" },
      }) as HTMLInputElement;
      input.value = field.value ?? "";
      // Enter commits from any field: there are at most two of them, and the
      // alternative is making the user reach for the mouse in a dialog they
      // opened from a menu.
      input.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.submit();
        }
      });
      row.appendChild(input);
      if (field.hint) row.appendChild(h("div", { cls: "mtk-field-hint", text: field.hint }));

      this.inputs.set(field.key, input);
      contentEl.appendChild(row);
    }

    this.errorEl = h("p", { cls: "mtk-modal-error" });
    contentEl.appendChild(this.errorEl);

    const actions = h("div", { cls: "mtk-modal-actions" });
    const cancel = h("button", {
      cls: "mtk-btn",
      text: t("settings.toolbar.cancel"),
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.close());

    const submit = h("button", {
      cls: "mtk-btn mtk-btn-primary",
      text: this.submitLabel,
      attr: { type: "button" },
    });
    submit.addEventListener("click", () => this.submit());

    actions.appendChild(cancel);
    actions.appendChild(submit);
    contentEl.appendChild(actions);

    const first = this.fields[0];
    if (first) this.inputs.get(first.key)?.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.inputs.clear();
  }

  private submit(): void {
    const values: Record<string, string> = {};
    for (const field of this.fields) values[field.key] = this.inputs.get(field.key)?.value.trim() ?? "";

    const error = this.onSubmit(values);
    if (error) {
      if (this.errorEl) this.errorEl.textContent = error;
      return;
    }
    this.close();
  }
}
