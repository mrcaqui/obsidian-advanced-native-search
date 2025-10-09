// plugin.ts
import { App, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { QueryPromptModal } from "./ui";
import { runSearch, ParsedQuery, SearchOptions, MatchLog } from "./search";
import { ResultsView, VIEW_TYPE_ANS_RESULTS } from "./resultsView";

/**
 * Settings
 */
interface AnsSettings {
  defaultDisplayMode: "split" | "window";
}

const DEFAULT_SETTINGS: AnsSettings = {
  defaultDisplayMode: "split",
};

export default class AdvancedNativeSearchPlugin extends Plugin {
  settings: AnsSettings = { ...DEFAULT_SETTINGS };

  // Track result leaves to reuse/close.
  private splitLeaf: WorkspaceLeaf | null = null;
  private windowLeaf: WorkspaceLeaf | null = null;

  // Last search payload (used when toggling views).
  private lastResults: MatchLog[] = [];
  private lastCaseSensitive = false;
  private lastSummary: { matchedFiles: number; totalLineHits: number; timeMs: number } | null = null;

  async onload() {
    await this.loadSettings();

    console.log("Loading Advanced Native-like Search plugin (ANS) with persistent results view");

    // Register the custom results view
    this.registerView(VIEW_TYPE_ANS_RESULTS, (leaf) => {
      const view = new ResultsView(leaf, this);
      return view;
    });

    // Command to open filter builder and run
    this.addCommand({
      id: "ans-open-native-like-search",
      name: "ANS: Run native-like search (filter builder)",
      callback: () => {
        new QueryPromptModal(this.app, (parsed, opts, uiState) =>
          this.handleSearchSubmit(parsed, opts, uiState)
        ).open();
      },
    });
  }

  onunload() {
    console.log("Unloading Advanced Native-like Search plugin");
    // Do not forcibly detach leaves; let the workspace manage persistence.
  }

  private async handleSearchSubmit(
    parsed: ParsedQuery,
    options: SearchOptions,
    uiState: { lineTerms: string[] }
  ) {
    const { matches, summary } = await runSearch(this.app, parsed, options, uiState);

    // Console summary
    console.log("[ANS] Accepted files:", summary.matchedFiles);
    console.log("[ANS] line: unique hit lines:", summary.totalLineHits);
    console.log("[ANS] Search time (ms):", summary.timeMs);
    console.log("[ANS] Sample results (max 10):", matches.slice(0, 10));
    console.log("[ANS] All results:", matches);

    // Breakdown logging (optional groups)
    if (parsed.filePatterns.length > 0) {
      console.groupCollapsed(`%c[ANS] Breakdown: file — criterion: file name matches each pattern (AND)`, "color:#9cf; font-weight:600;");
      console.log("Patterns:", parsed.filePatterns);
      for (const m of matches) {
        console.log(`${m.path}: file pattern matches=${m.filterHits?.file ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.pathPatterns.length > 0) {
      console.groupCollapsed(`%c[ANS] Breakdown: path — criterion: path matches each pattern (AND)`, "color:#9cf; font-weight:600;");
      console.log("Patterns:", parsed.pathPatterns);
      for (const m of matches) {
        console.log(`${m.path}: path pattern matches=${m.filterHits?.path ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.tagFilters.length > 0) {
      console.groupCollapsed(`%c[ANS] Breakdown: tag — criterion: tag set matches each filter (AND)`, "color:#9cf; font-weight:600;");
      console.log("Filters:", parsed.tagFilters);
      for (const m of matches) {
        console.log(`${m.path}: tag filter matches=${m.filterHits?.tag ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.propertyFilters.length > 0) {
      console.groupCollapsed(`%c[ANS] Breakdown: property — criterion: frontmatter property matches (AND)`, "color:#9cf; font-weight:600;");
      console.log("Filters:", parsed.propertyFilters);
      for (const m of matches) {
        console.log(`${m.path}: property filter matches=${m.filterHits?.property ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.headingPatterns.length > 0) {
      console.groupCollapsed(`%c[ANS] Breakdown: headings — criterion: heading text matches each pattern (AND)`, "color:#9cf; font-weight:600;");
      console.log("Patterns:", parsed.headingPatterns);
      for (const m of matches) {
        console.log(`${m.path}: headings pattern matches=${m.filterHits?.headings ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.contentPatterns.length > 0) {
      console.groupCollapsed(`%c[ANS] Breakdown: content — criterion: body matches each pattern (AND)`, "color:#9cf; font-weight:600;");
      console.log("Patterns:", parsed.contentPatterns);
      for (const m of matches) {
        console.log(`${m.path}: content pattern matches=${m.filterHits?.content ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.linePatterns.length > 0) {
      console.groupCollapsed(`%c[ANS] Breakdown: line — criterion: same line contains ALL terms (AND); unique hit lines`, "color:#9cf; font-weight:600;");
      for (const m of matches) {
        console.log(`${m.path}: line hit lines=${m.filterHits?.line ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.globalQuery) {
      console.groupCollapsed(`%c[ANS] Breakdown: Global Query — criterion: selected targets across vault (Body/Name/Path/Frontmatter/Tags/Headings), OR per file`, "color:#9cf; font-weight:600;");
      for (const m of matches) {
        console.log(`${m.path}: Global Query total=${m.filterHits?.globalQuery ?? 0}`);
        console.log("Breakdown:", m.filterHits?.globalQueryBreakdown);
      }
      console.groupEnd();
    }

    // Persist last search payload for toggling
    this.lastResults = matches;
    this.lastCaseSensitive = options.caseSensitive;
    this.lastSummary = summary;

    // Show results in persistent view using preferred mode
    await this.showResults(matches, { caseSensitive: options.caseSensitive, displayMode: this.settings.defaultDisplayMode });

    new Notice(`ANS: Search finished. Files ${summary.matchedFiles}, line hits ${summary.totalLineHits}.`);
  }

  /**
   * Open or reuse the results view in the requested mode, update its data, and ensure the opposite mode is closed.
   */
  async showResults(
    results: MatchLog[],
    opts: { caseSensitive: boolean; displayMode: "split" | "window" }
  ) {
    if (opts.displayMode === "split") {
      // Close window if open
      if (this.windowLeaf) {
        try {
          this.windowLeaf.detach();
        } catch (e) {
          console.warn("[ANS] Failed to detach window leaf:", e);
        }
        this.windowLeaf = null;
      }

      const view = await this.ensureSplitResultsView();
      view.setData(results, {
        caseSensitive: opts.caseSensitive,
        displayMode: "split",
        summary: this.lastSummary ?? null,
      });
      this.settings.defaultDisplayMode = "split";
      await this.saveSettings();
    } else {
      // Close split if open
      if (this.splitLeaf) {
        try {
          this.splitLeaf.detach();
        } catch (e) {
          console.warn("[ANS] Failed to detach split leaf:", e);
        }
        this.splitLeaf = null;
      }

      const view = await this.ensureWindowResultsView();
      view.setData(results, {
        caseSensitive: opts.caseSensitive,
        displayMode: "window",
        summary: this.lastSummary ?? null,
      });
      this.settings.defaultDisplayMode = "window";
      await this.saveSettings();
    }
  }

  /**
   * Called by ResultsView header toggle buttons to switch modes immediately.
   */
  async requestSwitchDisplayMode(mode: "split" | "window") {
    if (!this.lastResults) return;
    if (this.settings.defaultDisplayMode === mode) {
      // Already in the requested mode; nothing to do.
      return;
    }
    await this.showResults(this.lastResults, {
      caseSensitive: this.lastCaseSensitive,
      displayMode: mode,
    });
  }

  /**
   * Ensure a split (center) results view exists and return it. Reuse existing when possible.
   */
  private async ensureSplitResultsView(): Promise<ResultsView> {
    // Reuse if alive
    if (this.splitLeaf && this.splitLeaf.view?.getViewType() === VIEW_TYPE_ANS_RESULTS) {
      const v = this.splitLeaf.view as unknown as ResultsView;
      // Reveal the leaf
      this.app.workspace.revealLeaf(this.splitLeaf);
      return v;
    }

    // Create new split from active leaf (center area). This splits to the right (vertical split).
    const leaf = this.app.workspace.getLeaf("split");
    await leaf.setViewState({ type: VIEW_TYPE_ANS_RESULTS, active: true });
    leaf.setPinned(true);
    this.splitLeaf = leaf;
    const view = leaf.view as unknown as ResultsView;
    return view;
  }

  /**
   * Ensure a popout window results view exists and return it. Reuse existing when possible.
   */
  private async ensureWindowResultsView(): Promise<ResultsView> {
    if (this.windowLeaf && this.windowLeaf.view?.getViewType() === VIEW_TYPE_ANS_RESULTS) {
      const v = this.windowLeaf.view as unknown as ResultsView;
      // Focus window if possible
      try {
        (v as any)?.win?.focus?.();
      } catch {}
      return v;
    }

    // Open a popout leaf (window)
    const pop = (this.app.workspace as any).openPopoutLeaf?.();
    if (!pop) {
      // Fallback: if popout not available, split instead
      console.warn("[ANS] Popout leaf not available; falling back to split.");
      return await this.ensureSplitResultsView();
    }
    const leaf: WorkspaceLeaf = pop;
    await leaf.setViewState({ type: VIEW_TYPE_ANS_RESULTS, active: true });
    try {
      leaf.setPinned(true);
    } catch {}
    this.windowLeaf = leaf;
    const view = leaf.view as unknown as ResultsView;
    return view;
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}