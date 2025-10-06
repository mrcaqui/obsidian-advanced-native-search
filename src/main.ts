import {
  Plugin,
  Notice,
  TFile,
  prepareFuzzySearch,
  prepareSimpleSearch,
  Modal,
  App
} from "obsidian";

/**
 * シンプルなテキスト入力モーダル。
 */
class QueryPromptModal extends Modal {
  private onSubmit: (query: string, mode: "fuzzy" | "simple") => void;

  constructor(app: App, onSubmit: (query: string, mode: "fuzzy" | "simple") => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Enter search query" });

    const inputEl = contentEl.createEl("input", {
      type: "text",
      placeholder: "e.g., demo, project, Note title"
    });
    inputEl.focus();

    const modeLabel = contentEl.createEl("label", { text: " Mode: " });
    const modeSelect = contentEl.createEl("select");
    modeSelect.createEl("option", { text: "fuzzy (default)", value: "fuzzy" });
    modeSelect.createEl("option", { text: "simple (space-separated words)", value: "simple" });

    const runBtn = contentEl.createEl("button", { text: "Run" });

    const submit = () => {
      const q = inputEl.value.trim();
      const mode = (modeSelect.value as "fuzzy" | "simple") || "fuzzy";
      if (!q) {
        new Notice("Query cannot be empty.");
        return;
      }
      this.onSubmit(q, mode);
      this.close();
    };

    runBtn.onclick = submit;
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * CachedMetadata からタグを収集して頻度を返すユーティリティ。
 * - cache.tags: { tag: string }[] を想定。
 * - frontmatter.tags: string | string[] にも対応（単純分割）。
 */
function collectTagsFromFiles(app: App, files: TFile[]): Record<string, number> {
  const counter = new Map<string, number>();

  const add = (tag: string) => {
    const t = tag.trim();
    if (!t) return;
    counter.set(t, (counter.get(t) ?? 0) + 1);
  };

  const splitFrontmatterTags = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === "string") {
      // 代表的な区切り: カンマ/スペース
      return v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    }
    return [];
  };

  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;

    // cache.tags
    if (Array.isArray(cache.tags)) {
      for (const t of cache.tags) {
        if (t?.tag) add(t.tag);
      }
    }

    // frontmatter.tags
    const fmTags = splitFrontmatterTags(cache.frontmatter?.tags);
    fmTags.forEach(add);
  }

  // Record に変換
  return Object.fromEntries(counter.entries());
}

export default class AdvancedNativeSearchPlugin extends Plugin {
  async onload() {
    console.log("Loading Advanced native search plugin");

    this.addCommand({
      id: "ans-attach-native-observer",
      name: "ANS: Attach native Search observer (Unofficial)",
      callback: () => this.attachNativeObserver()
    });

    this.addCommand({
      id: "ans-run-official-api-logs",
      name: "ANS: Run official API search logs (default query)",
      callback: () => this.runOfficialApiLogs("demo", "fuzzy")
    });

    this.addCommand({
      id: "ans-run-official-api-logs-prompt",
      name: "ANS: Run official API search logs (prompt for query)",
      callback: () => {
        new QueryPromptModal(this.app, (query, mode) => this.runOfficialApiLogs(query, mode)).open();
      }
    });
  }

  onunload() {
    console.log("Unloading Advanced native search plugin");
  }

  async attachNativeObserver() {
    // 検索ペインを開いていない場合は開く
    let leaves = this.app.workspace.getLeavesOfType("search");
    if (!leaves.length) {
      const leaf = this.app.workspace.getLeftLeaf(true);
      if (!leaf) {
        new Notice("ANS: Unable to get left leaf.");
        return;
      }
      await leaf.setViewState({ type: "search" });
      leaves = this.app.workspace.getLeavesOfType("search");
    }
    if (!leaves.length) {
      new Notice("ANS: Unable to open Search view.");
      return;
    }

    const view: any = leaves[0].view;
    console.log("[ANS] SearchView:", view);

    try {
      const dom = view?.dom;
      const vChildren = dom?.vChildren;
      const children = vChildren?.children ?? vChildren?._children;
      console.log("[ANS] dom.vChildren children/_children snapshot:", children);

      if (Array.isArray(children)) {
        const summary = children.map((c: any, idx: number) => {
          const item = c?.item ?? c;
          const file: TFile | undefined = item?.file;
          const path = file?.path ?? item?.path ?? item?.filePath ?? "N/A";
          const matches = item?.result ?? item?.matches ?? null;
          return { idx, path, matches };
        });
        console.log("[ANS] Parsed summary (initial):", summary);
      }
    } catch (e) {
      console.error("[ANS] Error reading internal properties:", e);
    }

    const targetEl =
      view.containerEl ??
      view.dom?.el ??
      view.contentEl ??
      (view.searchDom as HTMLElement | undefined);

    if (!targetEl) {
      new Notice("ANS: Could not find SearchView container element.");
      return;
    }

    const observer = new MutationObserver((_mutations) => {
      try {
        const dom = view?.dom;
        const vChildren = dom?.vChildren;
        const children = vChildren?.children ?? vChildren?._children;
        console.log("[ANS] Mutation: children/_children snapshot:", children);

        if (Array.isArray(children)) {
          const summary = children.map((c: any, idx: number) => {
            const item = c?.item ?? c;
            const file: TFile | undefined = item?.file;
            const path = file?.path ?? item?.path ?? item?.filePath ?? "N/A";
            const matches = item?.result ?? item?.matches ?? null;
            return { idx, path, matches };
          });
          console.log("[ANS] Parsed summary (on mutation):", summary);
        }
      } catch (err) {
        console.error("[ANS] Error during mutation handler:", err);
      }
    });

    observer.observe(targetEl, { childList: true, subtree: true });
    this.register(() => observer.disconnect());

    new Notice("ANS: Native SearchView observer attached. Run a search and check console.");
  }

  /**
   * 公式APIログ出力。任意クエリと検索モードに対応。
   */
  async runOfficialApiLogs(query: string, mode: "fuzzy" | "simple" = "fuzzy") {
    console.log("%c--- [Pattern 2: Official API] ---", "color: cyan; font-weight: bold;");
    console.log(`[ANS] Search mode: ${mode}, query: ${query}`);

    const files = this.app.vault.getMarkdownFiles();
    if (!files.length) {
      new Notice("ANS: No Markdown files found.");
      return;
    }

    const searchFn =
      mode === "simple" ? prepareSimpleSearch(query) : prepareFuzzySearch(query);

    const results: Array<{ path: string; result: any }> = [];
    for (const file of files) {
      const text = await this.app.vault.read(file);
      const res = searchFn(text); // SearchResult | null
      if (res) results.push({ path: file.path, result: res });
    }
    console.log("[ANS] Results:", results);

    // タグ一覧（CachedMetadata から集計）
    const tagsRecord = collectTagsFromFiles(this.app, files);
    console.log("[ANS] Tags (first 10):",
      Object.fromEntries(Object.entries(tagsRecord).slice(0, 10))
    );

    // frontmatter の特定プロパティの有無
    const propertyToSearch = "status";
    const filesWithProperty = files.filter((file) => {
      const cache = this.app.metadataCache.getFileCache(file);
      return cache?.frontmatter?.[propertyToSearch] !== undefined;
    });
    console.log(`[ANS] Files with property '${propertyToSearch}':`, filesWithProperty);

    new Notice("ANS: Official API logs printed. Open devtools console to inspect.");
  }
}