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
 * 本文クエリの対象フィールド。
 * デフォルトではすべて true（Vault内のあらゆる文字列を横断）。
 */
interface ContentQueryTargets {
  body: boolean;
  name: boolean;
  path: boolean;
  frontmatter: boolean; // キー名と値の両方を対象
  tags: boolean;
  headings: boolean;
  blocks: boolean;
  tasks: boolean;
}

/**
 * ユーザーが指定する検索オプション。
 */
interface SearchOptions {
  mode: SearchMode;
  caseSensitive: boolean;
  sort: SortMode;
  limit?: number | null;
  contentQueryTargets: ContentQueryTargets;
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
 * - * ? を含む場合はグロブ
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
 * ヒット行の抜粋情報。
 */
interface Excerpt {
  line: number;        // 0-based（疑似行は -1 を許容）
  text: string;        // 行テキスト（整形済み）または擬似説明
  sources: string[];   // どの条件でヒットしたか（"line", "content:<pattern>", "contentQuery:<mode>" など）
}

/**
 * 1行をログ用に整形（長すぎる行を切る、タブや制御文字を整える）。
 */
function formatLineForLog(s: string, maxLen = 240): string {
  const cleaned = s.replace(/\t/g, "  ").replace(/\r/g, "").replace(/\u0000/g, "");
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + "…";
}

/**
 * 抜粋を抽出する。
 * - line: AND用の1本の正規表現を行ごとに適用。
 * - content: 各パターンを行ごとに適用。
 * - 本文クエリ: simple/fuzzyは searchFn を行ごとに、regexは regexForContentQuery を行ごとに適用。
 *
 * 注意: 本文クエリの「本文以外」フィールドに対する抜粋は runNativeLikeSearch 内で別途生成し、mergeExcerpts で統合します。
 */
function extractHitLines(
  text: string,
  parsed: ParsedQuery,
  options: SearchOptions,
  searchFn: ((text: string) => any) | null,
  regexForContentQuery: RegExp | null,
  perFileLimit = 10
): Excerpt[] {
  const { caseSensitive, mode } = options;
  const lines = text.split(/\r?\n/);

  // 行番号 -> 理由(Set) を集計
  const reasons = new Map<number, Set<string>>();

  const addReason = (idx: number, r: string) => {
    if (idx < 0 || idx >= lines.length) return;
    if (!reasons.has(idx)) reasons.set(idx, new Set<string>());
    reasons.get(idx)!.add(r);
  };

  // line:（同じ行に全語 — AND）
  if (parsed.linePatterns.length > 0) {
    const literal = parsed.linePatterns[0];
    const rx = tryParseExplicitRegex(literal) ?? new RegExp(literal, caseSensitive ? "" : "i");
    for (let i = 0; i < lines.length; i++) {
      if (rx.test(lines[i])) addReason(i, "line");
    }
  }

  // content:（本文に含まれる語句 — AND（ファイル採用条件）だが、抜粋は OR で列挙）
  if (parsed.contentPatterns.length > 0) {
    for (const pat of parsed.contentPatterns) {
      for (let i = 0; i < lines.length; i++) {
        if (contentContains(lines[i], pat, caseSensitive)) addReason(i, `content:${pat}`);
      }
    }
  }

  // 本文クエリ（自由語）: simple/fuzzy/regex — 本文（body）のみここで行単位抽出
  if (parsed.contentQuery && options.contentQueryTargets.body) {
    if ((mode === "simple" || mode === "fuzzy") && searchFn) {
      for (let i = 0; i < lines.length; i++) {
        if (searchFn(lines[i])) addReason(i, `contentQuery:${mode}`);
      }
    } else if (mode === "regex" && regexForContentQuery) {
      for (let i = 0; i < lines.length; i++) {
        if (regexForContentQuery.test(lines[i])) addReason(i, "contentQuery:regex");
      }
    }
  }

  // Map -> Excerpt[]
  const all = Array.from(reasons.entries())
    .sort((a, b) => a[0] - b[0])
    .map<Excerpt>(([idx, set]) => ({
      line: idx,
      text: formatLineForLog(lines[idx]),
      sources: Array.from(set.values()),
    }));

  // ログしすぎを防止
  return all.slice(0, perFileLimit);
}

/**
 * 文字オフセットから行番号(0-based)を推定（fallback用）。
 */
function offsetToLine(text: string, offset: number): number {
  if (offset <= 0) return 0;
  let line = 0;
  const len = Math.min(offset, text.length);
  for (let i = 0; i < len; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * section: 見出しヒットの抜粋を生成。
 * - cache.headings の position.start.line（なければ position.start.offset から推定）を使用。
 * - sources には "section:<pattern>" を付ける。
 */
function buildSectionExcerpts(
  app: App,
  file: TFile,
  text: string,
  patterns: string[],
  caseSensitive: boolean
): Excerpt[] {
  if (!patterns || patterns.length === 0) return [];
  const cache = app.metadataCache.getFileCache(file);

  // 修正: undefined を許容しないよう空配列にフォールバックし、型を配列に確定
  const headings = (cache?.headings ?? []) as any[];
  if (headings.length === 0) return [];

  const lines = text.split(/\r?\n/);
  const lineToSources = new Map<number, Set<string>>();

  for (const h of headings) {
    const headingText: string = String(h?.heading ?? "");
    if (!headingText) continue;

    for (const pat of patterns) {
      const rx = tryParseExplicitRegex(pat);
      const ok = rx ? rx.test(headingText) : matchPattern(headingText, pat, caseSensitive);
      if (!ok) continue;

      let lineIdx: number | undefined = h?.position?.start?.line;
      if (typeof lineIdx !== "number") {
        const off = h?.position?.start?.offset;
        if (typeof off === "number") {
          lineIdx = offsetToLine(text, off);
        }
      }
      if (typeof lineIdx !== "number") continue;

      if (!lineToSources.has(lineIdx)) lineToSources.set(lineIdx, new Set<string>());
      lineToSources.get(lineIdx)!.add(`section:${pat}`);
    }
  }

  const excerpts: Excerpt[] = Array.from(lineToSources.entries())
    .sort((a, b) => a[0] - b[0])
    .map<Excerpt>(([idx, srcs]) => ({
      line: idx,
      text: formatLineForLog(lines[idx] ?? ""),
      sources: Array.from(srcs.values()),
    }));

  return excerpts;
}

/**
 * 抜粋のマージ（行番号で統合、sources を結合）。perFileLimit を適用。
 */
function mergeExcerpts(base: Excerpt[] | undefined, add: Excerpt[], perFileLimit = 10): Excerpt[] {
  const map = new Map<number, { text: string; sources: Set<string> }>();

  const push = (arr?: Excerpt[]) => {
    if (!arr) return;
    for (const ex of arr) {
      const cur = map.get(ex.line);
      if (cur) {
        // 既存テキストが空なら新しい方を採用
        if (!cur.text && ex.text) cur.text = ex.text;
        for (const s of ex.sources) cur.sources.add(s);
      } else {
        map.set(ex.line, { text: ex.text, sources: new Set(ex.sources) });
      }
    }
  };

  push(base);
  push(add);

  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map<Excerpt>(([line, v]) => ({
      line,
      text: v.text,
      sources: Array.from(v.sources.values()),
    }))
    .slice(0, perFileLimit);
}

/**
 * フィルタ別ヒット数（採用ファイル向け）の集計用型。
 */
interface FilterHitStats {
  file?: number;
  path?: number;
  tag?: number;
  property?: number;
  section?: number;
  block?: number;
  task?: number;
  content?: number;
  line?: number;
  contentQuery?: number;
  // 追加: 本文クエリ対象別の内訳
  contentQueryBreakdown?: {
    body?: number;
    name?: number;
    path?: number;
    frontmatter?: number;
    tags?: number;
    headings?: number;
    blocks?: number;
    tasks?: number;
  };
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
  // prepare*Searchの結果（本文＝body向け）
  searchResult?: any;
  // regexモード時のマッチ数（本文クエリの総数; 対象全体）
  regexMatchCount?: number;
  // 抜粋行（ログ表示用、最大 N 行）
  excerpts?: Excerpt[];
  // 追加: フィルタ別ヒット数
  filterHits?: FilterHitStats;
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

  // 本文クエリ対象
  private cqTargetCheckboxes: {
    body: HTMLInputElement;
    name: HTMLInputElement;
    path: HTMLInputElement;
    frontmatter: HTMLInputElement;
    tags: HTMLInputElement;
    headings: HTMLInputElement;
    blocks: HTMLInputElement;
    tasks: HTMLInputElement;
  } | null = null;

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

    // 本文クエリの対象（Vault横断）
    this.makeContentQueryTargetsRow(contentEl);

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

  // 本文クエリ対象（Vault横断）
  private makeContentQueryTargetsRow(parent: HTMLElement) {
    const wrap = parent.createEl("div");
    wrap.style.marginTop = "8px";

    const title = wrap.createEl("div", { text: "本文クエリの対象（Vault横断）" });
    title.addClass("setting-item-name");

    const grid = wrap.createEl("div");
    grid.style.display = "grid";
    grid.style.gridTemplateColumns = "repeat(auto-fit, minmax(180px, 1fr))";
    grid.style.gap = "6px";
    grid.style.marginTop = "6px";

    const makeCheckbox = (labelText: string): HTMLInputElement => {
      const container = grid.createEl("label");
      container.style.display = "flex";
      container.style.alignItems = "center";
      container.style.gap = "6px";
      const cb = container.createEl("input", { type: "checkbox" });
      cb.checked = true; // 既定でオン
      const span = container.createEl("span", { text: labelText });
      return cb;
    };

    const body = makeCheckbox("本文（Body）");
    const name = makeCheckbox("ファイル名（Name）");
    const path = makeCheckbox("パス（Path）");
    const fm = makeCheckbox("フロントマター（キー・値）");
    const tags = makeCheckbox("タグ（Tags）");
    const headings = makeCheckbox("見出し（Headings）");
    const blocks = makeCheckbox("ブロックID（Blocks）");
    const tasks = makeCheckbox("タスク行（Tasks）");

    this.cqTargetCheckboxes = {
      body,
      name,
      path,
      frontmatter: fm,
      tags,
      headings,
      blocks,
      tasks,
    };
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

  // オプション（モード・ケース・件数制限・ソート）
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
      contentQueryTargets: {
        body: !!this.cqTargetCheckboxes?.body.checked,
        name: !!this.cqTargetCheckboxes?.name.checked,
        path: !!this.cqTargetCheckboxes?.path.checked,
        frontmatter: !!this.cqTargetCheckboxes?.frontmatter.checked,
        tags: !!this.cqTargetCheckboxes?.tags.checked,
        headings: !!this.cqTargetCheckboxes?.headings.checked,
        blocks: !!this.cqTargetCheckboxes?.blocks.checked,
        tasks: !!this.cqTargetCheckboxes?.tasks.checked,
      },
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
   * - 追加: 採用ファイルについてフィルタ別のヒット件数内訳を出力。
   * - 追加: 本文クエリを Vault 内の複数領域（本文・ファイル名・パス・FM・タグ・見出し・ブロックID・タスク行）に対して OR で適用。
   * - 追加: 本文以外の領域ヒットを excerpts に擬似行として反映。
   */
  private async runNativeLikeSearch(parsed: ParsedQuery, options: SearchOptions, uiState: { lineTerms: string[] }) {
    const t0 = performance.now();
    const files = this.app.vault.getMarkdownFiles();

    if (!files.length) {
      new Notice("Markdownファイルが見つかりません。");
      return;
    }

    const { mode, caseSensitive, sort, limit, contentQueryTargets } = options;

    console.log("%c--- [ANS] ネイティブ風検索（開始） ---", "color: cyan; font-weight: bold;");
    console.log("[ANS] パース済みフィルタ:", parsed);
    console.log("[ANS] 本文クエリ対象:", contentQueryTargets);
    console.log("[ANS] 対象ファイル数（Vault内のMarkdownファイル; app.vault.getMarkdownFiles() の結果）:", files.length);

    // prepare*Search（自由語部分のみに適用; 文字列に対して真偽）
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

    // regexモード用（本文クエリ: 非明示リテラルのとき caseSensitive を反映）
    let regexForContentQuery: RegExp | null = null;
    if (mode === "regex" && parsed.contentQuery) {
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

      // 本文取得（content:, line:, 自由語/regex、タスク抜粋などに使用）
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

      // 本文クエリ（Vault横断 OR）— 少なくとも1領域でヒットが必要
      let cqHit = !parsed.contentQuery; // 未指定ならスキップ相当で true
      let cqHitsTotal = 0;
      const cqBreakdown: FilterHitStats["contentQueryBreakdown"] = {};
      let regexMatchTotal = 0;

      // 抜粋（本文以外の領域ヒット分）
      const cqExtraExcerpts: Excerpt[] = [];
      const lines = text.split(/\r?\n/);

      const testString = (s: string): { hit: boolean; count: number } => {
        if (!s) return { hit: false, count: 0 };
        if (mode === "regex" && regexForContentQuery) {
          const all = s.match(regexForContentQuery);
          return { hit: !!all && all.length > 0, count: all?.length ?? 0 };
        } else if ((mode === "simple" || mode === "fuzzy") && searchFn) {
          const r = !!searchFn(s);
          return { hit: r, count: r ? 1 : 0 };
        }
        return { hit: false, count: 0 };
      };

      if (parsed.contentQuery) {
        // body（本文全体）: 既存の searchResult は維持
        let searchResult: any = null;
        if (contentQueryTargets.body) {
          if ((mode === "simple" || mode === "fuzzy") && searchFn) {
            searchResult = searchFn(text); // SearchResult | null
            if (searchResult) {
              cqHit = true;
              // 行単位でヒット数を数える（内訳）
              let c = 0;
              for (const ln of lines) {
                if (searchFn(ln)) c++;
              }
              cqBreakdown.body = c;
              cqHitsTotal += c;
            }
          } else if (mode === "regex" && regexForContentQuery) {
            const all = text.match(regexForContentQuery);
            if (all && all.length > 0) {
              cqHit = true;
              cqBreakdown.body = all.length;
              cqHitsTotal += all.length;
              regexMatchTotal += all.length;
            }
          }
        }

        // name
        if (contentQueryTargets.name) {
          const { hit, count } = testString(name);
          if (hit) {
            cqHit = true;
            cqBreakdown.name = (cqBreakdown.name ?? 0) + count;
            cqHitsTotal += count;
            cqExtraExcerpts.push({
              line: -1,
              text: `[name] ${name}`,
              sources: [`contentQuery:${mode}:name`],
            });
          }
        }

        // path
        if (contentQueryTargets.path) {
          const { hit, count } = testString(path);
          if (hit) {
            cqHit = true;
            cqBreakdown.path = (cqBreakdown.path ?? 0) + count;
            cqHitsTotal += count;
            cqExtraExcerpts.push({
              line: -1,
              text: `[path] ${path}`,
              sources: [`contentQuery:${mode}:path`],
            });
          }
        }

        // frontmatter（キー・値）
        if (contentQueryTargets.frontmatter) {
          const fm = cache?.frontmatter;
          if (fm && typeof fm === "object") {
            for (const key of Object.keys(fm)) {
              const keyRes = testString(key);
              const val = fm[key];
              const values: string[] = Array.isArray(val)
                ? val.map((x: any) => String(x ?? ""))
                : [String(val ?? "")];

              let localCount = 0;
              if (keyRes.hit) {
                localCount += keyRes.count;
                cqExtraExcerpts.push({
                  line: -1,
                  text: `[frontmatter-key] ${key}`,
                  sources: [`contentQuery:${mode}:frontmatter`],
                });
              }
              for (const v of values) {
                const { hit, count } = testString(v);
                if (hit) {
                  localCount += count;
                  cqExtraExcerpts.push({
                    line: -1,
                    text: `[frontmatter] ${key}: ${v}`,
                    sources: [`contentQuery:${mode}:frontmatter`],
                  });
                }
              }
              if (localCount > 0) {
                cqHit = true;
                cqBreakdown.frontmatter = (cqBreakdown.frontmatter ?? 0) + localCount;
                cqHitsTotal += localCount;
                regexMatchTotal += localCount;
              }
            }
          }
        }

        // tags
        if (contentQueryTargets.tags) {
          const set = getTagsForFile(this.app, file);
          let localCount = 0;
          for (const tg of set) {
            const { hit, count } = testString(tg);
            if (hit) {
              localCount += count;
              cqExtraExcerpts.push({
                line: -1,
                text: `[tag] ${tg}`,
                sources: [`contentQuery:${mode}:tags`],
              });
            }
          }
          if (localCount > 0) {
            cqHit = true;
            cqBreakdown.tags = (cqBreakdown.tags ?? 0) + localCount;
            cqHitsTotal += localCount;
            regexMatchTotal += localCount;
          }
        }

        // headings（position.start.line があれば行テキストを抜粋）
        if (contentQueryTargets.headings) {
          const headings = (cache?.headings ?? []) as any[];
          let localCount = 0;
          for (const h of headings) {
            const headingText: string = String(h?.heading ?? "");
            if (!headingText) continue;
            const { hit, count } = testString(headingText);
            if (hit) {
              localCount += count;
              let lineIdx: number | undefined = h?.position?.start?.line;
              if (typeof lineIdx !== "number") {
                const off = h?.position?.start?.offset;
                if (typeof off === "number") {
                  lineIdx = offsetToLine(text, off);
                }
              }
              const excerptText =
                typeof lineIdx === "number" ? formatLineForLog(lines[lineIdx] ?? headingText) : headingText;
              cqExtraExcerpts.push({
                line: typeof lineIdx === "number" ? lineIdx : -1,
                text: `[heading] ${excerptText}`,
                sources: [`contentQuery:${mode}:headings`],
              });
            }
          }
          if (localCount > 0) {
            cqHit = true;
            cqBreakdown.headings = (cqBreakdown.headings ?? 0) + localCount;
            cqHitsTotal += localCount;
            regexMatchTotal += localCount;
          }
        }

        // blocks（ID）
        if (contentQueryTargets.blocks) {
          const blocks = cache?.blocks;
          let localCount = 0;
          if (blocks && typeof blocks === "object") {
            for (const id of Object.keys(blocks)) {
              const { hit, count } = testString(id);
              if (hit) {
                localCount += count;
                cqExtraExcerpts.push({
                  line: -1,
                  text: `[block] ^${id}`,
                  sources: [`contentQuery:${mode}:blocks`],
                });
              }
            }
          }
          if (localCount > 0) {
            cqHit = true;
            cqBreakdown.blocks = (cqBreakdown.blocks ?? 0) + localCount;
            cqHitsTotal += localCount;
            regexMatchTotal += localCount;
          }
        }

        // tasks（listItems の行テキスト）
        if (contentQueryTargets.tasks) {
          const listItems = cache?.listItems;
          let localCount = 0;
          if (Array.isArray(listItems)) {
            for (const it of listItems) {
              let lineIdx: number | undefined = it?.position?.start?.line;
              if (typeof lineIdx !== "number") {
                const off = it?.position?.start?.offset;
                if (typeof off === "number") {
                  lineIdx = offsetToLine(text, off);
                }
              }
              const lineText = typeof lineIdx === "number" ? String(lines[lineIdx] ?? "") : "";
              if (!lineText) continue;
              const { hit, count } = testString(lineText);
              if (hit) {
                localCount += count;
                cqExtraExcerpts.push({
                  line: typeof lineIdx === "number" ? lineIdx : -1,
                  text: `[task] ${formatLineForLog(lineText)}`,
                  sources: [`contentQuery:${mode}:tasks`],
                });
              }
            }
          }
          if (localCount > 0) {
            cqHit = true;
            cqBreakdown.tasks = (cqBreakdown.tasks ?? 0) + localCount;
            cqHitsTotal += localCount;
            regexMatchTotal += localCount;
          }
        }

        // 既存の searchResult をローカルに保持（本文用）
        // 下で logEntry に格納
        // ヒットしなければ continue
        if (!cqHit) {
          continue;
        }

        // 以降で使用するため searchResult と regexMatchTotal を準備
        // simple/fuzzy の body searchResult は既に上で評価済み
        // regex は合算値を持つ
      }

      // ここまで通過したらファイル採用
      matchedFiles += 1;

      // 抜粋行（ログ用、最大10行など）
      const baseExcerpts = extractHitLines(
        text,
        parsed,
        options,
        searchFn,
        regexForContentQuery,
        10 // 1ファイルあたり最大行数。必要に応じて変更可。
      );

      // 追加: section ヒット見出しの抜粋を生成してマージ
      const sectionExcerpts = buildSectionExcerpts(
        this.app,
        file,
        text,
        parsed.sectionPatterns,
        caseSensitive
      );

      // 追加: 本文以外（name/path/FM/tags/headings/blocks/tasks）の本文クエリ擬似抜粋をマージ
      const mergedExcerpts1 = mergeExcerpts(baseExcerpts, sectionExcerpts, 10);
      const mergedExcerpts = mergeExcerpts(mergedExcerpts1, cqExtraExcerpts, 10);

      // フィルタ別ヒット数（採用ファイルのみ）
      const filterHits: FilterHitStats = {};

      if (parsed.filePatterns.length > 0) {
        filterHits.file = parsed.filePatterns.reduce(
          (acc, pat) => acc + (matchPattern(name, pat, caseSensitive) ? 1 : 0),
          0
        );
      }
      if (parsed.pathPatterns.length > 0) {
        filterHits.path = parsed.pathPatterns.reduce(
          (acc, pat) => acc + (matchPattern(path, pat, caseSensitive) ? 1 : 0),
          0
        );
      }
      if (parsed.tagFilters.length > 0) {
        const tagSet = getTagsForFile(this.app, file);
        filterHits.tag = parsed.tagFilters.reduce((acc, tg) => {
          const rx = tryParseExplicitRegex(tg);
          if (rx) {
            for (const t of tagSet) if (rx.test(t)) return acc + 1;
            return acc;
          } else {
            return acc + (tagSet.has(tg) ? 1 : 0);
          }
        }, 0);
      }
      if (parsed.propertyFilters.length > 0) {
        filterHits.property = parsed.propertyFilters.reduce(
          (acc, pf) => acc + (matchProperty(cache, pf.name, pf.value, caseSensitive) ? 1 : 0),
          0
        );
      }
      if (parsed.sectionPatterns.length > 0) {
        filterHits.section = parsed.sectionPatterns.reduce(
          (acc, pat) => acc + (matchSection(this.app, file, pat, caseSensitive) ? 1 : 0),
          0
        );
      }
      if (parsed.blockIdPatterns.length > 0) {
        filterHits.block = parsed.blockIdPatterns.reduce(
          (acc, pat) => acc + (matchBlockId(this.app, file, pat, caseSensitive) ? 1 : 0),
          0
        );
      }
      if (parsed.tasks) {
        const listItems = cache?.listItems;
        let count = 0;
        if (Array.isArray(listItems)) {
          if (parsed.tasks === "any") {
            count = listItems.filter((it: any) => typeof it.task === "string" && it.task.length > 0).length;
          } else if (parsed.tasks === "todo") {
            count = listItems.filter((it: any) => it.task === " ").length;
          } else if (parsed.tasks === "done") {
            count = listItems.filter((it: any) => it.task === "x").length;
          }
        }
        filterHits.task = count;
      }
      if (parsed.contentPatterns.length > 0) {
        filterHits.content = parsed.contentPatterns.reduce(
          (acc, pat) => acc + (contentContains(text, pat, caseSensitive) ? 1 : 0),
          0
        );
      }
      if (parsed.linePatterns.length > 0) {
        filterHits.line = lineDetail?.hitCount ?? 0;
      }

      // 本文クエリの内訳と総数
      if (parsed.contentQuery) {
        filterHits.contentQueryBreakdown = { ...(filterHits.contentQueryBreakdown ?? {}) };
        for (const k of Object.keys(contentQueryTargets) as Array<keyof ContentQueryTargets>) {
          const val = (k === "body" || k === "name" || k === "path" || k === "frontmatter" || k === "tags" || k === "headings" || k === "blocks" || k === "tasks")
            ? (k === "body" ? (filterHits.contentQueryBreakdown.body ?? 0) :
               k === "name" ? (filterHits.contentQueryBreakdown.name ?? 0) :
               k === "path" ? (filterHits.contentQueryBreakdown.path ?? 0) :
               k === "frontmatter" ? (filterHits.contentQueryBreakdown.frontmatter ?? 0) :
               k === "tags" ? (filterHits.contentQueryBreakdown.tags ?? 0) :
               k === "headings" ? (filterHits.contentQueryBreakdown.headings ?? 0) :
               k === "blocks" ? (filterHits.contentQueryBreakdown.blocks ?? 0) :
               (filterHits.contentQueryBreakdown.tasks ?? 0))
            : 0;
          // 後段で上書きするため初期化だけ
          (filterHits.contentQueryBreakdown as any)[k] = val;
        }
        // 既に集計済みの cqBreakdown を反映
        filterHits.contentQueryBreakdown = {
          body: cqBreakdown.body ?? 0,
          name: cqBreakdown.name ?? 0,
          path: cqBreakdown.path ?? 0,
          frontmatter: cqBreakdown.frontmatter ?? 0,
          tags: cqBreakdown.tags ?? 0,
          headings: cqBreakdown.headings ?? 0,
          blocks: cqBreakdown.blocks ?? 0,
          tasks: cqBreakdown.tasks ?? 0,
        };
        filterHits.contentQuery = Object.values(filterHits.contentQueryBreakdown).reduce((a, b) => a + (b ?? 0), 0);
      }

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
        // body に対する searchResult（simple/fuzzy のみ）
        searchResult: (mode === "simple" || mode === "fuzzy") && parsed.contentQuery && contentQueryTargets.body && searchFn ? searchFn(text) : undefined,
        // regex の総マッチ数（Vault横断合算）
        regexMatchCount: (mode === "regex" && parsed.contentQuery) ? regexMatchTotal : undefined,
        excerpts: mergedExcerpts,
        filterHits,
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

    if (parsed.filePatterns.length > 0) {
      console.groupCollapsed(
        `%c[ANS] フィルタ別内訳: file — 基準: ファイル名が各パターンに一致（AND）`,
        "color:#9cf; font-weight:600;"
      );
      console.log("使用パターン:", parsed.filePatterns);
      for (const m of matches) {
        console.log(`${m.path}: fileパターン一致数=${m.filterHits?.file ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.pathPatterns.length > 0) {
      console.groupCollapsed(
        `%c[ANS] フィルタ別内訳: path — 基準: パスが各パターンに一致（AND）`,
        "color:#9cf; font-weight:600;"
      );
      console.log("使用パターン:", parsed.pathPatterns);
      for (const m of matches) {
        console.log(`${m.path}: pathパターン一致数=${m.filterHits?.path ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.tagFilters.length > 0) {
      console.groupCollapsed(
        `%c[ANS] フィルタ別内訳: tag — 基準: タグ集合に各フィルタがマッチ（AND）`,
        "color:#9cf; font-weight:600;"
      );
      console.log("使用フィルタ:", parsed.tagFilters);
      for (const m of matches) {
        console.log(`${m.path}: タグフィルタ一致数=${m.filterHits?.tag ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.propertyFilters.length > 0) {
      console.groupCollapsed(
        `%c[ANS] フィルタ別内訳: property — 基準: フロントマターの指定プロパティが一致（AND）`,
        "color:#9cf; font-weight:600;"
      );
      console.log("使用フィルタ:", parsed.propertyFilters);
      for (const m of matches) {
        console.log(`${m.path}: プロパティフィルタ一致数=${m.filterHits?.property ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.sectionPatterns.length > 0) {
      console.groupCollapsed(
        `%c[ANS] フィルタ別内訳: section — 基準: 見出しテキストが各パターンに一致（AND）`,
        "color:#9cf; font-weight:600;"
      );
      console.log("使用パターン:", parsed.sectionPatterns);
      for (const m of matches) {
        console.log(`${m.path}: sectionパターン一致数=${m.filterHits?.section ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.blockIdPatterns.length > 0) {
      console.groupCollapsed(
        `%c[ANS] フィルタ別内訳: block — 基準: ブロックIDが各パターンに一致（AND）`,
        "color:#9cf; font-weight:600;"
      );
      console.log("使用パターン:", parsed.blockIdPatterns);
      for (const m of matches) {
        console.log(`${m.path}: blockパターン一致数=${m.filterHits?.block ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.tasks) {
      console.groupCollapsed(
        `%c[ANS] フィルタ別内訳: task — 基準: ${parsed.tasks} 条件に一致するタスク件数`,
        "color:#9cf; font-weight:600;"
      );
      for (const m of matches) {
        console.log(`${m.path}: タスク一致件数=${m.filterHits?.task ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.contentPatterns.length > 0) {
      console.groupCollapsed(
        `%c[ANS] フィルタ別内訳: content — 基準: 本文が各パターンに一致（AND）`,
        "color:#9cf; font-weight:600;"
      );
      console.log("使用パターン:", parsed.contentPatterns);
      for (const m of matches) {
        console.log(`${m.path}: contentパターン一致数=${m.filterHits?.content ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.linePatterns.length > 0) {
      console.groupCollapsed(
        `%c[ANS] フィルタ別内訳: line — 基準: 同一行に全語（AND）。ヒット行数（ユニーク）`,
        "color:#9cf; font-weight:600;"
      );
      for (const m of matches) {
        console.log(`${m.path}: lineヒット行数=${m.filterHits?.line ?? 0}`);
      }
      console.groupEnd();
    }

    if (parsed.contentQuery) {
      console.groupCollapsed(
        `%c[ANS] フィルタ別内訳: contentQuery — 基準: 指定のモードで Vault 内の複数領域（本文・名前・パス・FM・タグ・見出し・ブロックID・タスク行）に一致した合計`,
        "color:#9cf; font-weight:600;"
      );
      for (const m of matches) {
        console.log(`${m.path}: contentQuery合計=${m.filterHits?.contentQuery ?? 0}`);
        console.log("内訳:", m.filterHits?.contentQueryBreakdown);
      }
      console.groupEnd();
    }

    new Notice(
      `ANS: 検索完了。ファイル ${matchedFiles} 件、line ヒット ${totalLineHits} 件（DevToolsのコンソールを参照）。`
    );
  }
}