import {
  FuzzySuggestModal,
  prepareFuzzySearch,
  type App,
  type FuzzyMatch,
  type SearchResult,
} from "obsidian";
import { DIAGRAM_KINDS, type DiagramKind } from "../core/kinds";
import { t } from "../i18n";

/**
 * A searchable list of every diagram kind the plugin can insert.
 *
 * A picker rather than eleven commands: the command palette is for the handful
 * of things you reach for constantly, and ten more entries would only make the
 * two that matter harder to find. Each row shows only the kind's name; the
 * keyword and scene stay searchable without being printed.
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

  /** Only the name is shown; keyword and scene remain searchable below. */
  getItemText(item: DiagramKind): string {
    return t(item.nameKey);
  }

  /**
   * Name matches rank first and highlight; a hit on the keyword or the scene
   * ("排期" → gantt, "数据库" → ER) still lists the kind, without highlights.
   */
  getSuggestions(query: string): FuzzyMatch<DiagramKind>[] {
    const trimmed = query.trim();
    if (!trimmed) {
      return DIAGRAM_KINDS.map((item) => ({ item, match: { score: 0, matches: [] } }));
    }
    const search = prepareFuzzySearch(trimmed);
    const results: FuzzyMatch<DiagramKind>[] = [];
    for (const item of DIAGRAM_KINDS) {
      const nameMatch = search(t(item.nameKey));
      if (nameMatch) {
        results.push({ item, match: nameMatch });
        continue;
      }
      const extraMatch = search(`${item.keyword} ${t(item.sceneKey)}`);
      if (extraMatch) {
        // The hit lands on the hidden keyword/scene text, so drop its
        // highlight ranges — they would point into a string that is
        // never rendered.
        results.push({ item, match: { score: extraMatch.score, matches: [] } });
      }
    }
    return results.sort((a, b) => b.match.score - a.match.score);
  }

  onChooseItem(item: DiagramKind): void {
    this.choose(item);
  }
}
