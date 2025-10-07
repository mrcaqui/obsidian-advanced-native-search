// main.ts
import {
  App,
  Modal,
  Notice,
  Plugin,
  TFile,
  prepareFuzzySearch,
  prepareSimpleSearch,
} from "obsidian";

/**
 * 検索ダイアログの検索モード。
 */
type SearchMode = "fuzzy" | "simple" | "regex";

/**
 * ソート設定。
 */
type SortMode = "mtime-desc" | "mtime-asc" | "path-asc";

/**
 * ユーザーが指定する検索オプション。
 */
interface SearchOptions {
  mode: SearchMode;
  caseSensitive: boolean;
  sort: SortMode;
  limit?: number | null;
}

/**
 * クエリで解釈する演算子・フィルターのセット。
 * UIで追加した各フィルタはAND条件で適用されます。
 */
interface ParsedQuery {
  // コンテンツ（本文）に対する「自由語」クエリ（prepare*Search/regexに渡す）
  contentQuery: string;

  // 専用オペレーター（AND結合）
  filePatterns: string[];      // file:
  pathPatterns: string[];      // path:
  tagFilters: string[];        // tag:（#は付いていてもよい）
  contentPatterns: string[];   // content:
  linePatterns: string[];      // line:（同一行に全語を含む AND 条件を1本のlookahead正規表現にまとめる）
  sectionPatterns: string[];   // section:
  blockIdPatterns: string[];   // block:
  tasks?: "todo" | "done" | "any" | null; // task:, task-todo:, task-done:

  // フロントマター・プロパティ（AND結合）
  propertyFilters: Array<{ name: string; value: string | RegExp | null }>;
}

/**
 * ユーティリティ: 文字列が /pattern/flags の形式なら正規表現へ変換。
 */
function tryParseExplicitRegex(pattern: string): RegExp | null {
  const m = pattern.match(/^\/(.+)\/([a-z]*)$/i);
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2]);
  } catch {
    return null;
  }
}

/**
 * ユーティリティ: グロブ（* ?）を正規表現に変換。
 */
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

/**
 * ユーティリティ: サブストリング一致（ケース指定あり）。
 */
function includesWithCase(haystack: string, needle: string, caseSensitive: boolean): boolean {
  if (!caseSensitive) {
    return haystack.toLowerCase().includes(needle.toLowerCase());
  }
  return haystack.includes(needle);
}

/**
 * 値 v がパターン pat に一致するか（ファイル名・パス等用）
 * - /regex/ の場合は正規表現
 - * ? を含む場合はグロブ
 * - それ以外はサブストリング
 */
function matchPattern(v: string, pat: string, caseSensitive: boolean): boolean {
  const rx = tryParseExplicitRegex(pat);
  if (rx) return rx.test(v);

  if (pat.includes("*") || pat.includes("?")) {
    const grx = globToRegExp(pat, caseSensitive);
    return grx.test(v);
  }

  return includesWithCase(v, pat, caseSensitive);
}

/**
 * トークナイザ（ダブルクォートでフレーズを保持、クォートは除去）。
 * 例: hello "quick brown" tag:#x -> ["hello", "quick brown", "tag:#x"]
 */
function tokenizeWithQuotes(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    while (i < n && /\s/.test(input[i])) i++;
    if (i >= n) break;

    if (input[i] === '"') {
      i++;
      let buf = "";
      while (i < n && input[i] !== '"') {
        buf += input[i++];
      }
      if (i < n && input[i] === '"') i++;
      if (buf.length) tokens.push(buf);
    } else {
      let buf = "";
      while (i < n && !/\s/.test(input[i])) {
        buf += input[i++];
      }
      if (buf.length) tokens.push(buf);
    }
  }
  return tokens;
}

/**
 * あるファイルに付いているタグ一覧（#なし、重複なし）を返す。
 * - cache.tags
 * - frontmatter.tags（string | string[]）
 */
function getTagsForFile(app: App, file: TFile): Set<string> {
  const set = new Set<string>();
  const cache = app.metadataCache.getFileCache(file);

  // in-body tags
  const tags = cache?.tags;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (!t?.tag) continue;
      const raw = String(t.tag);
      const cleaned = raw.startsWith("#") ? raw.slice(1) : raw;
      if (cleaned) set.add(cleaned);
    }
  }

  // frontmatter tags
  const fm = cache?.frontmatter;
  const fmTags = fm?.tags;
  const push = (x: unknown) => {
    const s = String(x ?? "").trim();
    if (!s) return;
    const cleaned = s.startsWith("#") ? s.slice(1) : s;
    if (cleaned) set.add(cleaned);
  };
  if (Array.isArray(fmTags)) {
    for (const v of fmTags) push(v);
  } else if (typeof fmTags === "string") {
    // カンマ/スペース区切りを許容
    for (const v of fmTags.split(/[,\s]+/)) push(v);
  }

  return set;
}

/**
 * フロントマターのプロパティ一致チェック。
 */
function matchProperty(cache: any, name: string, value: string | RegExp | null, caseSensitive: boolean): boolean {
  const fm = cache?.frontmatter;
  if (!fm) return false;

  const v = fm[name];
  if (typeof v === "undefined") return false;

  if (value === null) {
    // 存在チェックのみ
    return true;
  }

  // 値マッチ
  if (value instanceof RegExp) {
    return value.test(String(v));
  }

  // 値が配列 or スカラの場合に対応（配列は ANY マッチ）
  if (Array.isArray(v)) {
    return v.some((item) => {
      const s = String(item ?? "");
      return caseSensitive ? s === value : s.toLowerCase() === value.toLowerCase();
    });
  } else {
    const s = String(v ?? "");
    return caseSensitive ? s === value : s.toLowerCase() === value.toLowerCase();
  }
}

/**
 * セクション見出し（cache.headings）からパターン一致を確認。
 */
function matchSection(app: App, file: TFile, pattern: string, caseSensitive: boolean): boolean {
  const cache = app.metadataCache.getFileCache(file);
  const headings = cache?.headings;
  if (!Array.isArray(headings) || headings.length === 0) return false;

  const rx = tryParseExplicitRegex(pattern);
  for (const h of headings) {
    const text: string = h.heading ?? "";
    if (!text) continue;
    if (rx) {
      if (rx.test(text)) return true;
    } else {
      if (matchPattern(text, pattern, caseSensitive)) return true;
    }
  }
  return false;
}

/**
 * ブロックID（cache.blocks）一致チェック。
 */
function matchBlockId(app: App, file: TFile, pattern: string, caseSensitive: boolean): boolean {
  const cache = app.metadataCache.getFileCache(file);
  const blocks = cache?.blocks;
  if (!blocks) return false;
  const rx = tryParseExplicitRegex(pattern);
  const entries: Array<{ id: string }> = [];
  // blocksはRecord<string, BlockCache>の想定
  for (const k of Object.keys(blocks)) {
    const id = k;
    entries.push({ id });
  }
  for (const b of entries) {
    if (rx) {
      if (rx.test(b.id)) return true;
    } else {
      if (matchPattern(b.id, pattern, caseSensitive)) return true;
    }
  }
  return false;
}

/**
 * 正規表現の特殊文字をエスケープ。
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * line: (AND) — 同じ行にすべての語を含む lookahead 正規表現リテラルを生成。
 * 例: ["tool","har"] -> '/^(?=.*tool)(?=.*har).*$/i'
 */
function buildLineRegexLiteral_AND(terms: string[], caseSensitive: boolean): string {
  const core = terms.map((t) => `(?=.*${escapeRegex(t)})`).join("") + ".*";
  const flags = caseSensitive ? "" : "i";
  return `/^${core}$/` + (flags ? flags : "");
}

/**
 * line: 用 — 1本の AND 正規表現（同じ行に全語）を受け取り、
 * - 少なくとも1行がヒットしているか（ファイル採用判定）
 * - ヒットした行（ユニーク）の件数と行番号を返す
 */
function countLineMatches_AND(
  text: string,
  andPatternLiteral: string | null,
  caseSensitive: boolean
): {
  hasAnyHit: boolean;
  hitCount: number;
  hitLineIndices: number[];
} {
  if (!andPatternLiteral) {
    return { hasAnyHit: true, hitCount: 0, hitLineIndices: [] };
  }
  const lines = text.split(/\r?\n/);
  const rx =
    tryParseExplicitRegex(andPatternLiteral) ??
    new RegExp(andPatternLiteral, caseSensitive ? "" : "i");

  const hitSet = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (rx.test(lines[i])) {
      hitSet.add(i);
    }
  }
  const indices = Array.from(hitSet.values()).sort((a, b) => a - b);
  return {
    hasAnyHit: indices.length > 0,
    hitCount: indices.length,
    hitLineIndices: indices,
  };
}

/**
 * コンテンツマッチ（content:）用。
 */
function contentContains(text: string, pattern: string, caseSensitive: boolean): boolean {
  const rx = tryParseExplicitRegex(pattern);
  if (rx) return rx.test(text);
  return matchPattern(text, pattern, caseSensitive);
}

/**
 * 検索結果エントリ（ログ用）。
 */
interface MatchLog {
  path: string;
  name: string;
  stat: { mtime: number; size: number };
  matched: {
    file?: string[];
    path?: string[];
    tags?: string[];
    properties?: Array<{ name: string; value: string | RegExp | null }>;
    contentQuery?: boolean;
    contentPatterns?: string[];
    sectionPatterns?: string[];
    blockIdPatterns?: string[];
    tasks?: "todo" | "done" | "any" | null;
    lineTerms?: string[];
  };
  // 行ヒット詳細
  line: {
    patternLiteral: string | null;
    hitCount: number; // このファイル内の行ヒット数（ユニーク行）
    hitLineIndices: number[]; // 行番号（0-based）
  } | null;
  // prepare*Searchの結果（あれば）
  searchResult?: any;
  // regexモード時のマッチ数（簡易）
  regexMatchCount?: number;
}

/**
 * シンプルな検索入力モーダル（フィルタビルダー）。
 * - 各フィルタは個別に追加したものがAND条件になります。
 * - line は語を1つずつチップ追加（har を追加 → tool を追加）すると「同じ行に har と tool の両方が必要」となります。
 *   括弧はUIでは付けず、内部でANDのlookahead正規表現にまとめます。
 */
class QueryPromptModal extends Modal {
  private onSubmit: (parsed: ParsedQuery, options: SearchOptions, uiState: { lineTerms: string[] }) => void;

  // 内部状態：各フィルタ（すべてAND）
  private filePatterns: string[] = [];
  private pathPatterns: string[] = [];
  private tagFilters: string[] = [];
  private contentPatterns: string[] = [];
  private lineTerms: string[] = []; // ANDに必要な語の集合（同じ行に全語）
  private sectionPatterns: string[] = [];
  private blockIdPatterns: string[] = [];
  private propertyFilters: Array<{ name: string; value: string | RegExp | null }> = [];
  private tasks: "todo" | "done" | "any" | null = null;

  // 一般コンテンツ検索（prepare*Search / regexに渡す）
  private contentQueryInputEl!: HTMLInputElement;

  // オプション
  private modeSelect!: HTMLSelectElement;
  private csCheckbox!: HTMLInputElement;
  private sortSelect!: HTMLSelectElement;
  private limitInput!: HTMLInputElement;

  constructor(app: App, onSubmit: (parsed: ParsedQuery, options: SearchOptions, uiState: { lineTerms: string[] }) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h3", { text: "ネイティブ風検索（フィルタビルダー）" });

    const info = contentEl.createEl("div");
    info.addClass("setting-item-description");
    info.setText("各オプションごとにテキストを入力して「＋」でフィルタを追加してください。追加したフィルタはAND条件になります。");

    // 一般コンテンツ検索（prepareFuzzy/Simple/Regex）
    this.contentQueryInputEl = this.makeTextRow(contentEl, "本文クエリ（fuzzy/simple/regex 用）", "例: quick brown", null);

    // file:
    this.makeAddableFilterRow(
      contentEl,
      "file（ファイル名 — AND）",
      "例: 2025-09  または *.md",
      (v) => this.addChip(this.filePatterns, v),
      () => this.filePatterns
    );

    // path:
    this.makeAddableFilterRow(
      contentEl,
      "path（パス — AND）",
      "例: notes/project  または */daily/*",
      (v) => this.addChip(this.pathPatterns, v),
      () => this.pathPatterns
    );

    // tag:
    this.makeAddableFilterRow(
      contentEl,
      "tag（タグ — AND）",
      "例: project  または #project",
      (v) => {
        const tag = v.startsWith("#") ? v.slice(1) : v;
        this.addChip(this.tagFilters, tag);
      },
      () => this.tagFilters
    );

    // content:
    this.makeAddableFilterRow(
      contentEl,
      "content（本文に含まれる語句 — AND）",
      "例: endpoint  または /end.*point/i",
      (v) => this.addChip(this.contentPatterns, v),
      () => this.contentPatterns
    );

    // line:（同じ行に全語 — AND）
    this.makeLineRow(contentEl);

    // section:
    this.makeAddableFilterRow(
      contentEl,
      "section（見出し名 — AND）",
      "例: Overview  または /章\\d+/",
      (v) => this.addChip(this.sectionPatterns, v),
      () => this.sectionPatterns
    );

    // block:
    this.makeAddableFilterRow(
      contentEl,
      "block（ブロックID — AND）",
      "例: abc123",
      (v) => this.addChip(this.blockIdPatterns, v),
      () => this.blockIdPatterns
    );

    // property:
    this.makePropertyRow(contentEl);

    // tasks:
    this.makeTaskRow(contentEl);

    // オプション（モード・ケース・ソート・リミット）
    this.makeOptionsRow(contentEl);

    // 実行
    const buttonRow = contentEl.createEl("div");
    buttonRow.style.marginTop = "12px";
    const runBtn = buttonRow.createEl("button", { text: "検索を実行" });
    runBtn.onclick = () => this.submit();
  }

  onClose() {
    this.contentEl.empty();
  }

  // ユーティリティ: シンプルな1行テキスト
  private makeTextRow(parent: HTMLElement, label: string, placeholder: string, onEnter: (() => void) | null): HTMLInputElement {
    const row = parent.createEl("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";
    row.style.marginTop = "8px";

    row.createEl("label", { text: label, cls: "setting-item-name" });
    const inputEl = row.createEl("input", { type: "text", placeholder });
    inputEl.style.flex = "1 1 auto";

    if (onEnter) {
      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") onEnter();
      });
    }
    return inputEl;
  }

  // ユーティリティ: 配列に chip を追加＆再描画
  private addChip(arr: string[], v: string) {
    const val = v.trim();
    if (!val) {
      new Notice("値が空です。");
      return;
    }
    arr.push(val);
    this.requestChipRefresh?.();
  }

  // 共通の「テキスト＋＋ボタン＋チップ群」
  private requestChipRefresh: (() => void) | null = null;

  private makeAddableFilterRow(
    parent: HTMLElement,
    label: string,
    placeholder: string,
    onAdd: (value: string) => void,
    getList: () => string[]
  ) {
    const wrap = parent.createEl("div");
    wrap.style.marginTop = "8px";

    const title = wrap.createEl("div", { text: label });
    title.addClass("setting-item-name");

    const row = wrap.createEl("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";

    const inputEl = row.createEl("input", { type: "text", placeholder });
    inputEl.style.flex = "1 1 auto";

    const addBtn = row.createEl("button", { text: "+" });
    addBtn.onclick = () => onAdd(inputEl.value);

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") onAdd(inputEl.value);
    });

    const chipsEl = wrap.createEl("div");
    chipsEl.style.display = "flex";
    chipsEl.style.flexWrap = "wrap";
    chipsEl.style.gap = "6px";
    chipsEl.style.marginTop = "6px";

    const refresh = () => {
      chipsEl.empty();
      const list = getList();
      list.forEach((v, idx) => {
        const chip = chipsEl.createEl("span", { text: v });
        chip.style.border = "1px solid var(--background-modifier-border)";
        chip.style.borderRadius = "12px";
        chip.style.padding = "2px 8px";
        chip.style.display = "inline-flex";
        chip.style.alignItems = "center";
        chip.style.gap = "6px";

        const del = chipsEl.createEl("button", { text: "×" });
        del.style.marginLeft = "6px";
        del.onclick = () => {
          list.splice(idx, 1);
          refresh();
        };
        chip.appendChild(del);
        chipsEl.appendChild(chip);
      });
    };

    // 共有の再描画フックをこのタイミングで差し替え
    const prev = this.requestChipRefresh;
    this.requestChipRefresh = () => {
      prev?.();
      refresh();
    };
    refresh();
  }

  // line: 同じ行に全語（AND）。括弧はUIで付けず、語を1つずつチップ追加。
  private makeLineRow(parent: HTMLElement) {
    const wrap = parent.createEl("div");
    wrap.style.marginTop = "8px";

    const title = wrap.createEl("div", { text: "line（同じ行に含まれる必要がある語 — AND）" });
    title.addClass("setting-item-name");

    const row = wrap.createEl("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";

    const inputEl = row.createEl("input", {
      type: "text",
      placeholder: '例: har  または  "error 500" など。スペース区切りで複数語を一度に追加可能。',
    });
    inputEl.style.flex = "1 1 auto";

    const addBtn = row.createEl("button", { text: "+" });
    addBtn.onclick = () => {
      const val = inputEl.value.trim();
      if (!val) {
        new Notice("値が空です。");
        return;
      }
      // スペース区切り（クォートは1語として扱う）。複数語を一度に追加する場合も各語を別チップとして登録。
      const terms = tokenizeWithQuotes(val).filter(Boolean);
      if (terms.length === 0) {
        new Notice("有効な語がありません。");
        return;
      }
      // 重複排除
      for (const t of terms) {
        if (!this.lineTerms.includes(t)) this.lineTerms.push(t);
      }
      refresh();
    };

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addBtn.onclick?.(null as any);
    });

    const chipsEl = wrap.createEl("div");
    chipsEl.style.display = "flex";
    chipsEl.style.flexWrap = "wrap";
    chipsEl.style.gap = "6px";
    chipsEl.style.marginTop = "6px";

    const refresh = () => {
      chipsEl.empty();
      this.lineTerms.forEach((term, idx) => {
        const chip = chipsEl.createEl("span", { text: term });
        chip.style.border = "1px solid var(--background-modifier-border)";
        chip.style.borderRadius = "12px";
        chip.style.padding = "2px 8px";
        chip.style.display = "inline-flex";
        chip.style.alignItems = "center";
        chip.style.gap = "6px";

        const del = chipsEl.createEl("button", { text: "×" });
        del.style.marginLeft = "6px";
        del.onclick = () => {
          this.lineTerms.splice(idx, 1);
          refresh();
        };
        chip.appendChild(del);
        chipsEl.appendChild(chip);
      });
    };
    refresh();
  }

  // property: name + value(optional)
  private makePropertyRow(parent: HTMLElement) {
    const wrap = parent.createEl("div");
    wrap.style.marginTop = "8px";

    const title = wrap.createEl("div", { text: "property（フロントマター — AND）" });
    title.addClass("setting-item-name");

    const row = wrap.createEl("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";

    const nameEl = row.createEl("input", { type: "text", placeholder: "プロパティ名（例: status）" });
    const valueEl = row.createEl("input", { type: "text", placeholder: "値（例: done または /d(?!one)/i）" });

    nameEl.style.flex = "0 0 160px";
    valueEl.style.flex = "1 1 auto";

    const addBtn = row.createEl("button", { text: "+" });
    addBtn.onclick = () => {
      const name = nameEl.value.trim();
      const raw = valueEl.value.trim();
      if (!name) {
        new Notice("プロパティ名を入力してください。");
        return;
      }
      let v: string | RegExp | null = null;
      if (raw) {
        v = tryParseExplicitRegex(raw) ?? raw;
      } else {
        v = null; // 存在チェック
      }
      this.propertyFilters.push({ name, value: v });
      refresh();
    };

    nameEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addBtn.onclick?.(null as any);
    });
    valueEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") addBtn.onclick?.(null as any);
    });

    const chipsEl = wrap.createEl("div");
    chipsEl.style.display = "flex";
    chipsEl.style.flexWrap = "wrap";
    chipsEl.style.gap = "6px";
    chipsEl.style.marginTop = "6px";

    const refresh = () => {
      chipsEl.empty();
      this.propertyFilters.forEach((pf, idx) => {
        const valStr =
          pf.value === null
            ? "(exists)"
            : pf.value instanceof RegExp
            ? `/${pf.value.source}/${pf.value.flags}`
            : String(pf.value);
        const label = `${pf.name}:${valStr}`;
        const chip = chipsEl.createEl("span", { text: label });
        chip.style.border = "1px solid var(--background-modifier-border)";
        chip.style.borderRadius = "12px";
        chip.style.padding = "2px 8px";
        chip.style.display = "inline-flex";
        chip.style.alignItems = "center";
        chip.style.gap = "6px";

        const del = chipsEl.createEl("button", { text: "×" });
        del.style.marginLeft = "6px";
        del.onclick = () => {
          this.propertyFilters.splice(idx, 1);
          refresh();
        };
        chip.appendChild(del);
        chipsEl.appendChild(chip);
      });
    };
    refresh();
  }

  // tasks: dropdown
  private makeTaskRow(parent: HTMLElement) {
    const wrap = parent.createEl("div");
    wrap.style.marginTop = "8px";

    const row = wrap.createEl("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";

    row.createEl("label", { text: "task（チェックボックス — AND）" });

    const select = row.createEl("select");
    select.createEl("option", { text: "なし", value: "none" });
    select.createEl("option", { text: "any（タスクあり）", value: "any" });
    select.createEl("option", { text: "todo（未完了）", value: "todo" });
    select.createEl("option", { text: "done（完了）", value: "done" });
    select.value = "none";

    select.onchange = () => {
      const v = select.value;
      this.tasks = v === "none" ? null : (v as "any" | "todo" | "done");
    };
  }

  // オプション（モード・ケース・ソート・件数制限）
  private makeOptionsRow(parent: HTMLElement) {
    const row = parent.createEl("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "repeat(auto-fit, minmax(200px, 1fr))";
    row.style.gap = "8px";
    row.style.marginTop = "12px";

    // モード（デフォルト: simple）
    {
      const cell = row.createEl("div");
      const label = cell.createEl("label", { text: "モード" });
      this.modeSelect = cell.createEl("select");
      this.modeSelect.createEl("option", { text: "simple（スペース区切り AND）", value: "simple" });
      this.modeSelect.createEl("option", { text: "fuzzy（Obsidianのファジー）", value: "fuzzy" });
      this.modeSelect.createEl("option", { text: "regex（正規表現）", value: "regex" });
      this.modeSelect.value = "simple";
    }

    // 大文字小文字
    {
      const cell = row.createEl("div");
      const label = cell.createEl("label");
      this.csCheckbox = cell.createEl("input", { type: "checkbox" });
      this.csCheckbox.style.marginRight = "6px";
      label.appendChild(this.csCheckbox);
      label.appendText("大文字小文字を区別する");
    }

    // ソート
    {
      const cell = row.createEl("div");
      const label = cell.createEl("label", { text: "ソート" });
      this.sortSelect = cell.createEl("select");
      this.sortSelect.createEl("option", { text: "更新日時（新しい順）", value: "mtime-desc" });
      this.sortSelect.createEl("option", { text: "更新日時（古い順）", value: "mtime-asc" });
      this.sortSelect.createEl("option", { text: "パス（昇順）", value: "path-asc" });
      this.sortSelect.value = "mtime-desc";
    }

    // 件数制限
    {
      const cell = row.createEl("div");
      cell.createEl("label", { text: "結果の最大件数（空なら制限なし）" });
      this.limitInput = cell.createEl("input", { type: "number", placeholder: "例: 100" });
      this.limitInput.min = "1";
    }
  }

  private submit() {
    const caseSensitive = !!this.csCheckbox.checked;

    // lineTerms（AND）を1本のlookahead正規表現リテラルにまとめる
    const linePatternLiteral =
      this.lineTerms.length > 0 ? buildLineRegexLiteral_AND(this.lineTerms, caseSensitive) : null;

    const p: ParsedQuery = {
      contentQuery: this.contentQueryInputEl.value.trim(),
      filePatterns: [...this.filePatterns],
      pathPatterns: [...this.pathPatterns],
      tagFilters: [...this.tagFilters],
      contentPatterns: [...this.contentPatterns],
      linePatterns: linePatternLiteral ? [linePatternLiteral] : [],
      sectionPatterns: [...this.sectionPatterns],
      blockIdPatterns: [...this.blockIdPatterns],
      tasks: this.tasks,
      propertyFilters: [...this.propertyFilters],
    };

    const options: SearchOptions = {
      mode: (this.modeSelect.value as SearchMode) ?? "simple",
      caseSensitive,
      sort: (this.sortSelect.value as SortMode) ?? "mtime-desc",
      limit: this.limitInput.value.trim() ? Math.max(1, Number(this.limitInput.value.trim())) : null,
    };

    if (
      !p.contentQuery &&
      !p.filePatterns.length &&
      !p.pathPatterns.length &&
      !p.tagFilters.length &&
      !p.contentPatterns.length &&
      !p.linePatterns.length &&
      !p.sectionPatterns.length &&
      !p.blockIdPatterns.length &&
      !p.propertyFilters.length &&
      !p.tasks
    ) {
      new Notice("フィルタが未指定です。少なくとも1つは指定してください。");
      return;
    }

    this.onSubmit(p, options, { lineTerms: [...this.lineTerms] });
    this.close();
  }
}

/**
 * 検索プラグイン本体。
 */
export default class AdvancedNativeSearchPlugin extends Plugin {
  async onload() {
    console.log("Loading Advanced Native-like Search plugin");

    this.addCommand({
      id: "ans-open-native-like-search",
      name: "ANS: ネイティブ風検索を実行（フィルタビルダー）",
      callback: () => {
        new QueryPromptModal(this.app, (parsed, opts, uiState) => this.runNativeLikeSearch(parsed, opts, uiState)).open();
      },
    });
  }

  onunload() {
    console.log("Unloading Advanced Native-like Search plugin");
  }

  /**
   * ネイティブ風検索を実行し、結果をコンソールに出力。
   * - プラグインAPIのみ（prepareFuzzySearch / prepareSimpleSearch / MetadataCache / Vault）を使用。
   * - UIで追加した各フィルタはAND条件。
   * - line は「同じ行に全語」のAND条件で判定し、行ヒット数（ユニーク行）を集計します。
   * - デフォルトモードは Simple。
   */
  private async runNativeLikeSearch(parsed: ParsedQuery, options: SearchOptions, uiState: { lineTerms: string[] }) {
    const t0 = performance.now();
    const files = this.app.vault.getMarkdownFiles();

    if (!files.length) {
      new Notice("Markdownファイルが見つかりません。");
      return;
    }

    const { mode, caseSensitive, sort, limit } = options;

    console.log("%c--- [ANS] ネイティブ風検索（開始） ---", "color: cyan; font-weight: bold;");
    console.log("[ANS] パース済みフィルタ:", parsed);
    console.log("[ANS] オプション:", options);
    console.log("[ANS] UI状態（line terms）:", uiState.lineTerms);
    console.log("[ANS] 対象ファイル数:", files.length);

    // prepare*Search（自由語部分のみに適用）
    let searchFn: ((text: string) => any) | null = null;
    if (parsed.contentQuery) {
      if (mode === "simple") {
        searchFn = prepareSimpleSearch(parsed.contentQuery);
      } else if (mode === "fuzzy") {
        searchFn = prepareFuzzySearch(parsed.contentQuery);
      } else {
        // regexモードは別処理
        searchFn = null;
      }
    }

    // regexモード用
    let regexForContentQuery: RegExp | null = null;
    if (mode === "regex" && parsed.contentQuery) {
      // /pattern/flags 形式ならそのまま、そうでなければ全文を正規表現として解釈（フラグは i 既定）
      regexForContentQuery =
        tryParseExplicitRegex(parsed.contentQuery) ??
        new RegExp(parsed.contentQuery, caseSensitive ? "" : "i");
    }

    const matches: MatchLog[] = [];
    let totalLineHits = 0;
    let matchedFiles = 0;

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const path = file.path;
      const name = file.name;

      // file:, path:（AND）
      if (parsed.filePatterns.length > 0) {
        const ok = parsed.filePatterns.every((pat) => matchPattern(name, pat, caseSensitive));
        if (!ok) continue;
      }
      if (parsed.pathPatterns.length > 0) {
        const ok = parsed.pathPatterns.every((pat) => matchPattern(path, pat, caseSensitive));
        if (!ok) continue;
      }

      // tag:（AND）
      if (parsed.tagFilters.length > 0) {
        const tags = getTagsForFile(this.app, file);
        const ok = parsed.tagFilters.every((tg) => {
          const rx = tryParseExplicitRegex(tg);
          if (rx) {
            for (const t of tags) if (rx.test(t)) return true;
            return false;
          }
          return tags.has(tg);
        });
        if (!ok) continue;
      }

      // property（AND）
      if (parsed.propertyFilters.length > 0) {
        const ok = parsed.propertyFilters.every((pf) =>
          matchProperty(cache, pf.name, pf.value, caseSensitive)
        );
        if (!ok) continue;
      }

      // section（AND）
      if (parsed.sectionPatterns.length > 0) {
        const ok = parsed.sectionPatterns.every((pat) =>
          matchSection(this.app, file, pat, caseSensitive)
        );
        if (!ok) continue;
      }

      // block（AND）
      if (parsed.blockIdPatterns.length > 0) {
        const ok = parsed.blockIdPatterns.every((pat) =>
          matchBlockId(this.app, file, pat, caseSensitive)
        );
        if (!ok) continue;
      }

      // tasks（単一選択）
      if (parsed.tasks) {
        const listItems = cache?.listItems;
        const want = parsed.tasks;
        let ok = false;
        if (Array.isArray(listItems)) {
          if (want === "any") {
            ok = listItems.some((it: any) => typeof it.task === "string" && it.task.length > 0);
          } else if (want === "todo") {
            ok = listItems.some((it: any) => it.task === " ");
          } else if (want === "done") {
            ok = listItems.some((it: any) => it.task === "x");
          }
        }
        if (!ok) continue;
      }

      // 本文取得（content:, line:, 自由語/regex）
      const text = await this.app.vault.cachedRead(file);

      // content（AND）
      if (parsed.contentPatterns.length > 0) {
        const ok = parsed.contentPatterns.every((pat) => contentContains(text, pat, caseSensitive));
        if (!ok) continue;
      }

      // line（同じ行に全語 — AND）
      let lineDetail: MatchLog["line"] = null;
      if (parsed.linePatterns.length > 0) {
        const { hasAnyHit, hitCount, hitLineIndices } = countLineMatches_AND(
          text,
          parsed.linePatterns[0] ?? null,
          caseSensitive
        );
        if (!hasAnyHit) continue;
        totalLineHits += hitCount;
        lineDetail = {
          patternLiteral: parsed.linePatterns[0],
          hitCount,
          hitLineIndices,
        };
      }

      // 自由語（本文検索）
      let searchResult: any = null;
      let regexMatchCount: number | undefined;

      if (parsed.contentQuery) {
        if (mode === "simple" || mode === "fuzzy") {
          if (searchFn) {
            searchResult = searchFn(text); // SearchResult | null
            if (!searchResult) {
              continue;
            }
          }
        } else if (mode === "regex") {
          if (regexForContentQuery) {
            const all = text.match(regexForContentQuery);
            if (!all) continue;
            regexMatchCount = all.length;
          }
        }
      }

      matchedFiles += 1;

      const logEntry: MatchLog = {
        path,
        name,
        stat: { mtime: file.stat.mtime, size: file.stat.size },
        matched: {
          file: parsed.filePatterns.length ? [...parsed.filePatterns] : undefined,
          path: parsed.pathPatterns.length ? [...parsed.pathPatterns] : undefined,
          tags: parsed.tagFilters.length ? [...parsed.tagFilters] : undefined,
          properties: parsed.propertyFilters.length ? [...parsed.propertyFilters] : undefined,
          contentQuery: !!parsed.contentQuery,
          contentPatterns: parsed.contentPatterns.length ? [...parsed.contentPatterns] : undefined,
          sectionPatterns: parsed.sectionPatterns.length ? [...parsed.sectionPatterns] : undefined,
          blockIdPatterns: parsed.blockIdPatterns.length ? [...parsed.blockIdPatterns] : undefined,
          tasks: parsed.tasks ?? undefined,
          lineTerms: uiState.lineTerms.length ? [...uiState.lineTerms] : undefined,
        },
        line: lineDetail,
        searchResult: searchResult ?? undefined,
        regexMatchCount,
      };

      matches.push(logEntry);

      // 件数制限（ファイル単位）
      if (limit && matches.length >= limit) break;
    }

    // ソート（ファイル単位のログの並び替え）
    if (sort === "mtime-desc") {
      matches.sort((a, b) => b.stat.mtime - a.stat.mtime);
    } else if (sort === "mtime-asc") {
      matches.sort((a, b) => a.stat.mtime - b.stat.mtime);
    } else if (sort === "path-asc") {
      matches.sort((a, b) => a.path.localeCompare(b.path));
    }

    const t1 = performance.now();

    console.log("[ANS] マッチしたファイル数:", matchedFiles);
    console.log("[ANS] line: 行ヒット数（ユニーク行）:", totalLineHits);
    console.log("[ANS] 検索時間(ms):", Math.round(t1 - t0));
    console.log("[ANS] 結果サンプル（最大10件）:", matches.slice(0, 10));
    console.log("[ANS] 全結果（ファイル単位の詳細）:", matches);

    new Notice(
      `ANS: 検索完了。ファイル ${matchedFiles} 件、line ヒット ${totalLineHits} 件（DevToolsのコンソールを参照）。`
    );
  }
}