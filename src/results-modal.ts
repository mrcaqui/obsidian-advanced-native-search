// results-modal.ts
import { App, Modal } from "obsidian";

// 既存のMatchLog型に合致
interface MatchLog {
  path: string;
  name: string;
  stat: { mtime: number; size: number };
  matched: {
    file?: string[];
    path?: string[];
    tags?: string[];
    properties?: Array<{ name: string; value: string | RegExp | null }>;
    globalQuery?: boolean;
    contentPatterns?: string[];
    headingPatterns?: string[];
    lineTerms?: string[];
  };
  line: {
    patternLiteral: string | null;
    hitCount: number;
    hitLineIndices: number[];
  } | null;
  searchResult?: any;
  regexMatchCount?: number;
  excerpts?: Array<{
    line: number;
    text: string;
    sources: string[];
  }>;
  filterHits?: {
    line?: number;
    // 省略: 他のフィールドは不要なら使わない
  };
}

// ハイライト用ユーティリティ（pattern: /.../flags or glob or plain）
function tryParseExplicitRegex(pattern: string): RegExp | null {
  const m = pattern.match(/^\/(.+)\/([a-z]*)$/i);
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2]);
  } catch {
    return null;
  }
}
function globToRegExp(glob: string, caseSensitive: boolean): RegExp {
  const esc = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  let pattern = "";
  for (const ch of glob) {
    if (ch === "*") pattern += ".*";
    else if (ch === "?") pattern += ".";
    else pattern += esc(ch);
  }
  const flags = caseSensitive ? "" : "i";
  return new RegExp(pattern, flags);
}
function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// 任意の複数語をハイライト（単純部分文字列）
function highlightByTerms(text: string, terms: string[], caseSensitive: boolean): string {
  if (!terms?.length) return escapeHTML(text);
  const escaped = escapeHTML(text);
  // 重複や空を除去
  const uniq = Array.from(new Set(terms.filter(Boolean)));
  // オーバーラップ対策として長い語から
  uniq.sort((a, b) => b.length - a.length);
  // まとめてORで1回置換するため、HTMLエスケープ済みテキストに対してパターンを作る
  const parts = uniq.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const rx = new RegExp(`(${parts.join("|")})`, caseSensitive ? "g" : "gi");
  return escaped.replace(rx, "<mark>$1</mark>");
}

// パターン1つをハイライト（正規表現/グロブ/部分文字列）
function highlightByPattern(text: string, pattern: string, caseSensitive: boolean): string {
  const escaped = escapeHTML(text);
  // 明示的正規表現
  const rx = tryParseExplicitRegex(pattern);
  if (rx) {
    // すべての一致箇所を置換
    // 正規表現をHTMLエスケープ後で再適用できないため、元テキストで一致位置を拾い、その範囲をmarkで包む方法をとる
    const matches = Array.from(text.matchAll(rx));
    if (matches.length === 0) return escaped;
    // 区切り挿入
    let out = "";
    let last = 0;
    for (const m of matches) {
      const start = m.index ?? 0;
      const end = start + (m[0]?.length ?? 0);
      out += escapeHTML(text.slice(last, start));
      out += "<mark>" + escapeHTML(text.slice(start, end)) + "</mark>";
      last = end;
    }
    out += escapeHTML(text.slice(last));
    return out;
  }
  // グロブ
  if (pattern.includes("*") || pattern.includes("?")) {
    const grx = globToRegExp(pattern, caseSensitive);
    const matches = Array.from(text.matchAll(grx));
    if (matches.length === 0) return escaped;
    let out = "";
    let last = 0;
    for (const m of matches) {
      const start = m.index ?? 0;
      const end = start + (m[0]?.length ?? 0);
      out += escapeHTML(text.slice(last, start));
      out += "<mark>" + escapeHTML(text.slice(start, end)) + "</mark>";
      last = end;
    }
    out += escapeHTML(text.slice(last));
    return out;
  }
  // ただの部分文字列
  return highlightByTerms(text, [pattern], caseSensitive);
}

// excerpt.sourcesからハイライト対象を抽出
// - "line"なら matched.lineTerms を使用
// - "content:<pattern>"なら <pattern> を使用
function computeHighlightedHTML(excerpt: { text: string; sources: string[] }, matched: MatchLog["matched"], caseSensitive: boolean): string {
  const contentSources = excerpt.sources.filter((s) => s.startsWith("content:"));
  const contentPatterns = contentSources.map((s) => s.slice("content:".length)).filter(Boolean);

  let html = escapeHTML(excerpt.text);
  // まず content: パターンでハイライト（正規表現やグロブも対応）
  for (const pat of contentPatterns) {
    html = highlightByPattern(excerpt.text, pat, caseSensitive); // 元テキストから都度構築
    // 次のループのため、テキストは元に戻して都度適用（重ねがけより、最後の適用結果のみを採用）
    // 必要なら複数パターンORでまとめる処理に差し替え可能
  }
  // 次に lineTerms があればそれでハイライト
  if (matched?.lineTerms?.length) {
    html = highlightByTerms(excerpt.text, matched.lineTerms, caseSensitive);
  }

  return html;
}

export class ResultsModal extends Modal {
  private results: MatchLog[];
  private caseSensitive: boolean;

  constructor(app: App, results: MatchLog[], opts?: { caseSensitive?: boolean }) {
    super(app);
    this.results = results;
    this.caseSensitive = !!opts?.caseSensitive;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // タイトル
    const title = contentEl.createEl("div", { text: "Search results" });
    title.addClass("setting-item-name");
    title.style.marginBottom = "8px";

    // コンテナ
    const container = contentEl.createEl("div");
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "12px";
    container.style.maxHeight = "70vh";
    container.style.overflow = "auto";

    // ファイルごとにグループ化表示
    for (const r of this.results) {
      const group = container.createEl("div");
      group.style.border = "1px solid var(--background-modifier-border)";
      group.style.borderRadius = "8px";
      group.style.padding = "8px";

      // ヘッダー（ファイル名、パス、ヒット数など）
      const header = group.createEl("div");
      header.style.display = "flex";
      header.style.alignItems = "baseline";
      header.style.justifyContent = "space-between";
      header.style.gap = "8px";

      const left = header.createEl("div");
      const nameEl = left.createEl("div", { text: r.name });
      nameEl.style.fontWeight = "600";
      const pathEl = left.createEl("div", { text: r.path });
      pathEl.style.color = "var(--text-muted)";

      const right = header.createEl("div");
      right.style.textAlign = "right";
      const hits = r.line?.hitCount ?? r.excerpts?.length ?? 0;
      right.createEl("div", { text: `Hits: ${hits}` });
      right.createEl("div", { text: `Size: ${r.stat.size}  •  mtime: ${new Date(r.stat.mtime).toLocaleString()}` });

      // 抜粋カード一覧
      const list = group.createEl("div");
      list.style.display = "flex";
      list.style.flexDirection = "column";
      list.style.gap = "8px";
      list.style.marginTop = "8px";

      for (const ex of r.excerpts ?? []) {
        const card = list.createEl("div");
        card.style.border = "1px solid var(--background-modifier-border)";
        card.style.borderRadius = "6px";
        card.style.padding = "8px";
        card.style.cursor = "pointer";
        card.style.backgroundColor = "var(--background-secondary)";
        card.style.transition = "background-color 0.1s ease";
        card.onmouseenter = () => (card.style.backgroundColor = "var(--background-secondary-alt)");
        card.onmouseleave = () => (card.style.backgroundColor = "var(--background-secondary)");

        // 1行目: 行番号とソース
        const meta = card.createEl("div");
        meta.style.display = "flex";
        meta.style.alignItems = "center";
        meta.style.gap = "8px";
        meta.style.color = "var(--text-muted)";
        meta.style.fontSize = "0.9em";
        meta.createEl("span", { text: ex.line >= 0 ? `Line ${ex.line}` : "Synthetic" });
        meta.createEl("span", { text: `• ${ex.sources.join(", ")}` });

        // 2行目: ハイライト済みテキスト
        const body = card.createEl("div");
        body.style.marginTop = "6px";
        body.style.lineHeight = "1.5";
        body.style.wordBreak = "break-word";
        body.innerHTML = computeHighlightedHTML({ text: ex.text, sources: ex.sources }, r.matched, this.caseSensitive);

        // クリックで該当ファイルへ遷移
        card.onclick = async () => {
          await this.openFileAtLine(r.path, ex.line);
        };
      }
    }
  }

  onClose() {
    this.contentEl.empty();
  }

  // 該当ファイルを開いて可能なら行へスクロール
  private async openFileAtLine(path: string, line: number) {
    try {
      // 新規タブで開く（第3引数openInNewLeaf=trueでも可）
      await this.app.workspace.openLinkText(path, "", false);
      // 最も新しいLeafを取得してカーソル移動
      const leaf = this.app.workspace.getMostRecentLeaf();
      const view: any = leaf?.view;
      const editor: any = view?.editor;
      if (editor && typeof line === "number" && line >= 0) {
        editor.setCursor({ line, ch: 0 });
        // スクロールを確実に
        if (editor.scrollIntoView) {
          editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
        } else if (view.revealLine) {
          view.revealLine(line);
        }
      }
    } catch (e) {
      console.warn("[ANS] openFileAtLine failed:", e);
    }
  }
}