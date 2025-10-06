import { Plugin, Notice, TFile, prepareFuzzySearch } from "obsidian";

export default class AdvancedNativeSearchPlugin extends Plugin {
  async onload() {
    console.log("Loading Advanced native search plugin");

    this.addCommand({
      id: "ans-attach-native-observer",
      name: "ANS: Attach native Search observer (Unofficial)",
      callback: () => this.attachNativeObserver(),
    });

    this.addCommand({
      id: "ans-run-official-api-logs",
      name: "ANS: Run official API search logs",
      callback: () => this.runOfficialApiLogs(),
    });
  }

  onunload() {
    console.log("Unloading Advanced native search plugin");
  }

  /**
   * パターン1: 非公式APIアプローチ
   * SearchView の内部構造にアクセスし、DOM変化を監視しながら
   * 内部配列（例: dom.vChildren._children）をダンプします。
   */
  async attachNativeObserver() {
    // 検索ペインを開いていない場合は開く
    let leaves = this.app.workspace.getLeavesOfType("search");
    if (!leaves.length) {
      const leaf = this.app.workspace.getLeftLeaf(true);
      await leaf.setViewState({ type: "search" });
      leaves = this.app.workspace.getLeavesOfType("search");
    }
    if (!leaves.length) {
      new Notice("ANS: Unable to open Search view.");
      return;
    }

    const view: any = leaves[0].view;
    console.log("[ANS] SearchView:", view);

    // 内部構造のスナップショット取得（存在すれば）
    try {
      const dom = view?.dom;
      const vChildren = dom?.vChildren;
      // バージョン差異に備えて両方試す
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

    // DOM 監視対象の要素を確保（存在するものを順に採用）
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

    new Notice(
      "ANS: Native SearchView observer attached. Run a search and check console."
    );
  }

  /**
   * パターン2: 公式APIアプローチ
   * - prepareFuzzySearch を使い、各ファイル本文に対する SearchResult をログ出力。
   * - MetadataCache を使い、タグ一覧・特定プロパティの有無をログ出力。
   */
  async runOfficialApiLogs() {
    console.log(
      "%c--- [Pattern 2: Official API] ---",
      "color: cyan; font-weight: bold;"
    );

    const files = this.app.vault.getMarkdownFiles();
    if (!files.length) {
      new Notice("ANS: No Markdown files found.");
      return;
    }

    // 例1: 本文に対するファジー検索（クエリは適宜変更）
    const query = "demo";
    const fuzzy = prepareFuzzySearch(query);
    const fuzzyResults: Array<{ path: string; result: any }> = [];

    for (const file of files) {
      const text = await this.app.vault.read(file);
      const res = fuzzy(text); // SearchResult | null
      if (res) {
        fuzzyResults.push({ path: file.path, result: res });
      }
    }
    console.log("[ANS] FuzzySearch query:", query);
    console.log("[ANS] FuzzySearch results:", fuzzyResults);

    // 例2: MetadataCache 経由でタグ一覧を取得
    const tagsRecord = this.app.metadataCache.getTags();
    console.log(
      "[ANS] MetadataCache.getTags() -> Record<string, number> (first 10):",
      Object.fromEntries(Object.entries(tagsRecord).slice(0, 10))
    );

    // 例3: frontmatter の特定プロパティを持つファイル一覧
    const propertyToSearch = "status";
    const filesWithProperty = files.filter((file) => {
      const cache = this.app.metadataCache.getFileCache(file);
      return cache?.frontmatter?.[propertyToSearch] !== undefined;
    });
    console.log(
      `[ANS] Files with frontmatter property '${propertyToSearch}':`,
      filesWithProperty
    );

    new Notice(
      "ANS: Official API logs printed. Open devtools console to inspect."
    );
  }
}
