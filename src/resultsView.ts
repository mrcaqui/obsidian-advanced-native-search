// resultsView.ts
import { ItemView, WorkspaceLeaf } from "obsidian";
import type AdvancedNativeSearchPlugin from "./plugin";
import type { MatchLog } from "./search";
import { globToRegExp } from "./search";

export const VIEW_TYPE_ANS_RESULTS = "ans-results-view";

export class ResultsView extends ItemView {
  private plugin: AdvancedNativeSearchPlugin;
  private currentMode: "split" | "window" = "split";
  private caseSensitive = false;
  private results: MatchLog[] = [];
  private summary: { matchedFiles: number; totalLineHits: number; timeMs: number } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: AdvancedNativeSearchPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_ANS_RESULTS;
  }

  getDisplayText(): string {
    return "ANS Results";
  }

  getIcon(): string {
    return "search";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    // no-op
  }

  /**
   * Update results and re-render.
   */
  setData(
    results: MatchLog[],
    opts: {
      caseSensitive: boolean;
      displayMode: "split" | "window";
      summary: { matchedFiles: number; totalLineHits: number; timeMs: number } | null;
    }
  ) {
    this.results = results ?? [];
    this.caseSensitive = !!opts.caseSensitive;
    this.currentMode = opts.displayMode;
    this.summary = opts.summary ?? null;
    this.render();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    // Root: make the view fill available space and allow the list to stretch.
    contentEl.style.display = "flex";
    contentEl.style.flexDirection = "column";
    contentEl.style.height = "100%";
    contentEl.style.minHeight = "0";

    // Header: Title + summary + toggles
    const header = contentEl.createDiv();
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.gap = "8px";
    header.style.marginBottom = "8px";

    const left = header.createDiv();
    const title = left.createEl("div", { text: "Search results" });
    title.addClass("setting-item-name");

    const sum = this.summary;
    const sub = left.createEl("div", {
      text:
        sum
          ? `Files: ${sum.matchedFiles}  •  Line hits: ${sum.totalLineHits}  •  ${sum.timeMs} ms`
          : `Results: ${this.results.length}`,
    });
    sub.style.color = "var(--text-muted)";
    sub.style.fontSize = "0.9em";

    const right = header.createDiv();
    right.style.display = "flex";
    right.style.alignItems = "center";
    right.style.gap = "6px";

    const splitBtn = right.createEl("button", { text: "Split" });
    const windowBtn = right.createEl("button", { text: "Window" });

    const applyToggleState = () => {
      splitBtn.disabled = this.currentMode === "split";
      windowBtn.disabled = this.currentMode === "window";
      splitBtn.style.opacity = splitBtn.disabled ? "0.6" : "1";
      windowBtn.style.opacity = windowBtn.disabled ? "0.6" : "1";
      splitBtn.title = "Show results in a split pane (center area).";
      windowBtn.title = "Show results in a popout window.";
    };
    applyToggleState();

    splitBtn.onclick = async () => {
      if (this.currentMode === "split") return;
      await this.plugin.requestSwitchDisplayMode("split");
    };
    windowBtn.onclick = async () => {
      if (this.currentMode === "window") return;
      await this.plugin.requestSwitchDisplayMode("window");
    };

    // Wrapper for the list area: occupy all remaining space.
    const listWrapper = contentEl.createDiv();
    listWrapper.style.flex = "1 1 auto";
    listWrapper.style.minHeight = "0";
    listWrapper.style.display = "flex";
    listWrapper.style.flexDirection = "column";

    // Results list: full height of remaining space; scroll when overflowing.
    const container = listWrapper.createDiv();
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "12px";
    container.style.flex = "1 1 auto";
    container.style.minHeight = "0";
    container.style.overflow = "auto";

    for (const r of this.results) {
      const group = container.createDiv();
      group.style.border = "1px solid var(--background-modifier-border)";
      group.style.borderRadius = "8px";
      group.style.padding = "8px";

      const header2 = group.createDiv();
      header2.style.display = "flex";
      header2.style.alignItems = "baseline";
      header2.style.justifyContent = "space-between";
      header2.style.gap = "8px";

      const left2 = header2.createDiv();
      const nameEl = left2.createEl("div", { text: r.name });
      nameEl.style.fontWeight = "600";
      const pathEl = left2.createEl("div", { text: r.path });
      pathEl.style.color = "var(--text-muted)";

      const right2 = header2.createDiv();
      right2.style.textAlign = "right";
      const hits = r.line?.hitCount ?? r.excerpts?.length ?? 0;
      right2.createEl("div", { text: `Hits: ${hits}` });
      right2.createEl("div", { text: `Size: ${r.stat.size}  •  mtime: ${new Date(r.stat.mtime).toLocaleString()}` });

      const list = group.createDiv();
      list.style.display = "flex";
      list.style.flexDirection = "column";
      list.style.gap = "8px";
      list.style.marginTop = "8px";

      for (const ex of r.excerpts ?? []) {
        const card = list.createDiv();
        card.style.border = "1px solid var(--background-modifier-border)";
        card.style.borderRadius = "6px";
        card.style.padding = "8px";
        card.style.cursor = "pointer";
        card.style.backgroundColor = "var(--background-secondary)";
        card.style.transition = "background-color 0.1s ease";
        card.onmouseenter = () => (card.style.backgroundColor = "var(--background-secondary-alt)");
        card.onmouseleave = () => (card.style.backgroundColor = "var(--background-secondary)");

        const meta = card.createDiv();
        meta.style.display = "flex";
        meta.style.alignItems = "center";
        meta.style.gap = "8px";
        meta.style.color = "var(--text-muted)";
        meta.style.fontSize = "0.9em";
        meta.createEl("span", { text: ex.line >= 0 ? `Line ${ex.line}` : "Synthetic" });
        meta.createEl("span", { text: `• ${ex.sources.join(", ")}` });

        const body = card.createDiv();
        body.style.marginTop = "6px";
        body.style.lineHeight = "1.5";
        body.style.wordBreak = "break-word";
        body.innerHTML = this.computeHighlightedHTML(
          { text: ex.text, sources: ex.sources },
          r.matched,
          this.caseSensitive
        );

        card.onclick = async () => {
          await this.openFileAtLine(r.path, ex.line);
        };
      }
    }
  }

  private async openFileAtLine(path: string, line: number) {
    try {
      await this.app.workspace.openLinkText(path, "", false);
      const leaf: any = (this.app.workspace as any).getMostRecentLeaf?.() ?? null;
      const view: any = leaf?.view;
      const editor: any = view?.editor;

      if (editor && typeof line === "number" && line >= 0) {
        editor.setCursor({ line, ch: 0 });
        if (editor.scrollIntoView) {
          editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
        } else if (view?.revealLine) {
          view.revealLine(line);
        }
      }
    } catch (e) {
      console.warn("[ANS] openFileAtLine failed:", e);
    }
  }

  /* =========================
     Highlight helpers (ported from modal UI)
     ========================= */

  private escapeHTML(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  }

  private collectRangesPlain(text: string, term: string, caseSensitive: boolean, out: Array<[number, number]>) {
    if (!term) return;
    const t = caseSensitive ? term : term.toLowerCase();
    const hay = caseSensitive ? text : text.toLowerCase();
    let idx = 0;
    while (true) {
      const pos = hay.indexOf(t, idx);
      if (pos === -1) break;
      out.push([pos, pos + term.length]);
      idx = pos + Math.max(1, term.length);
    }
  }

  private collectRangesRegex(text: string, rx: RegExp, out: Array<[number, number]>) {
    const flags = rx.flags.includes("g") ? rx.flags : rx.flags + "g";
    const grx = new RegExp(rx.source, flags);
    for (const m of text.matchAll(grx)) {
      const start = m.index ?? 0;
      const end = start + (m[0]?.length ?? 0);
      if (end > start) out.push([start, end]);
    }
  }

  private collectRangesGlob(text: string, glob: string, caseSensitive: boolean, out: Array<[number, number]>) {
    const base = globToRegExp(glob, caseSensitive);
    const flags = base.flags.includes("g") ? base.flags : base.flags + "g";
    const grx = new RegExp(base.source, flags);
    for (const m of text.matchAll(grx)) {
      const start = m.index ?? 0;
      const end = start + (m[0]?.length ?? 0);
      if (end > start) out.push([start, end]);
    }
  }

  private mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
    if (ranges.length === 0) return ranges;
    ranges.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const out: Array<[number, number]> = [];
    let [cs, ce] = ranges[0];
    for (let i = 1; i < ranges.length; i++) {
      const [s, e] = ranges[i];
      if (s <= ce) {
        ce = Math.max(ce, e);
      } else {
        out.push([cs, ce]);
        cs = s;
        ce = e;
      }
    }
    out.push([cs, ce]);
    return out;
  }

  private buildHighlightedHTML(
    text: string,
    opts: {
      lineTerms?: string[];
      contentPatterns?: string[];
      exactPhrase?: string; // case-insensitive highlight
      caseSensitive: boolean;
    }
  ): string {
    const ranges: Array<[number, number]> = [];

    // contentPatterns: regex literal, glob, or plain
    for (const pat of opts.contentPatterns ?? []) {
      const rx = this.tryParseExplicitRegex(pat);
      if (rx) {
        this.collectRangesRegex(text, rx, ranges);
      } else if (pat.includes("*") || pat.includes("?")) {
        this.collectRangesGlob(text, pat, opts.caseSensitive, ranges);
      } else {
        this.collectRangesPlain(text, pat, opts.caseSensitive, ranges);
      }
    }

    // lineTerms: plain substrings
    for (const term of opts.lineTerms ?? []) {
      this.collectRangesPlain(text, term, opts.caseSensitive, ranges);
    }

    // exactPhrase: always case-insensitive highlight
    if (opts.exactPhrase) {
      this.collectRangesPlain(text, opts.exactPhrase, false, ranges);
    }

    const merged = this.mergeRanges(ranges);
    if (merged.length === 0) return this.escapeHTML(text);

    let html = "";
    let last = 0;
    for (const [s, e] of merged) {
      if (s > last) html += this.escapeHTML(text.slice(last, s));
      html += "<mark>" + this.escapeHTML(text.slice(s, e)) + "</mark>";
      last = e;
    }
    if (last < text.length) html += this.escapeHTML(text.slice(last));
    return html;
  }

  private tryParseExplicitRegex(pattern: string): RegExp | null {
    const m = pattern.match(/^\/(.+)\/([a-z]*)$/i);
    if (!m) return null;
    try {
      return new RegExp(m[1], m[2]);
    } catch {
      return null;
    }
  }

  private computeHighlightedHTML(
    excerpt: { text: string; sources: string[] },
    matched: MatchLog["matched"],
    caseSensitive: boolean
  ): string {
    const contentSources = excerpt.sources.filter((s) => s.startsWith("content:"));
    const contentPatterns = contentSources.map((s) => s.slice("content:".length)).filter(Boolean);
    const lineTerms = matched?.lineTerms ?? [];
    const exactPhrase = matched?.exactPhrase ?? undefined;

    return this.buildHighlightedHTML(excerpt.text, {
      lineTerms,
      contentPatterns,
      exactPhrase,
      caseSensitive,
    });
  }
}