import { FuzzySuggestModal, type App } from "obsidian";
import { DIAGRAM_KINDS, type DiagramKind } from "../core/kinds";
import { t } from "../i18n";

/**
 * A searchable list of every diagram kind the plugin can insert.
 *
 * A picker rather than eleven commands: the command palette is for the handful
 * of things you reach for constantly, and ten more entries would only make the
 * two that matter harder to find. It is also the only place the *purpose* of
 * each kind can be shown — the scene line is what someone who cannot yet tell a
 * state diagram from a sequence diagram actually needs to read.
 */
export class DiagramKindPicker extends FuzzySuggestModal<DiagramKind> {
  private readonly choose: (kind: DiagramKind) => void;

  constructor(app: App, choose: (kind: DiagramKind) => void) {
    super(app);
    this.choose = choose;
    this.setPlaceholder(t("command.pickKind.placeholder"));
  }

  getItems(): DiagramKind[] {
    return DIAGRAM_KINDS;
  }

  /**
   * The scene is searchable too: someone hunting for "排期" has no reason to
   * know that what they want is called a gantt chart.
   */
  getItemText(item: DiagramKind): string {
    return `${t(item.nameKey)} ${item.keyword} ${t(item.sceneKey)}`;
  }

  onChooseItem(item: DiagramKind): void {
    this.choose(item);
  }
}
