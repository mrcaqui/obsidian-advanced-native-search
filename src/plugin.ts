// plugin.ts
import { App, Notice, Plugin } from "obsidian";
import { QueryPromptModal, ResultsModal } from "./ui";
import { runSearch, ParsedQuery, SearchOptions } from "./search";

export default class AdvancedNativeSearchPlugin extends Plugin {
  async onload() {
    console.log("Loading Advanced Native-like Search plugin");

    this.addCommand({
      id: "ans-open-native-like-search",
      name: "ANS: Run native-like search (filter builder)",
      callback: () => {
        new QueryPromptModal(this.app, (parsed, opts, uiState) => this.handleSearchSubmit(parsed, opts, uiState)).open();
      },
    });
  }

  onunload() {
    console.log("Unloading Advanced Native-like Search plugin");
  }

  private async handleSearchSubmit(parsed: ParsedQuery, options: SearchOptions, uiState: { lineTerms: string[] }) {
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

    // Show results modal UI
    new ResultsModal(this.app, matches, { caseSensitive: options.caseSensitive }).open();

    new Notice(`ANS: Search finished. Files ${summary.matchedFiles}, line hits ${summary.totalLineHits}.`);
  }
}