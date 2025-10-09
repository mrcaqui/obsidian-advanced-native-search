// ui.ts
import { App, Modal, Notice } from "obsidian";
import {
  ParsedQuery,
  SearchOptions,
  SearchMode,
  SortMode,
  tryParseExplicitRegex,
  globToRegExp,
  buildLineRegexLiteral_AND,
  MatchLog,
} from "./search";

/**
 * Tokenizer: keep phrases in double quotes, strip quotes.
 * Example: hello "quick brown" tag:#x -> ["hello", "quick brown", "tag:#x"]
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

/* =========================
   Query Prompt Modal (Filter Builder)
   ========================= */

export class QueryPromptModal extends Modal {
  private onSubmit: (parsed: ParsedQuery, options: SearchOptions, uiState: { lineTerms: string[] }) => void;

  // internal state (all AND)
  private filePatterns: string[] = [];
  private pathPatterns: string[] = [];
  private tagFilters: string[] = [];
  private contentPatterns: string[] = [];
  private lineTerms: string[] = [];
  private headingPatterns: string[] = [];
  private propertyFilters: Array<{ name: string; value: string | RegExp | null }> = [];

  // Global Query input (prepare*Search / regex)
  private globalQueryInputEl!: HTMLInputElement;

  // options
  private modeSelect!: HTMLSelectElement;      // affects Global Query only
  private csCheckbox!: HTMLInputElement;       // affects filters only
  private sortSelect!: HTMLSelectElement;
  private limitInput!: HTMLInputElement;

  // Global Query targets
  private gqTargetCheckboxes: {
    body: HTMLInputElement;
    name: HTMLInputElement;
    path: HTMLInputElement;
    frontmatter: HTMLInputElement;
    tags: HTMLInputElement;
    headings: HTMLInputElement;
  } | null = null;

  constructor(app: App, onSubmit: (parsed: ParsedQuery, options: SearchOptions, uiState: { lineTerms: string[] }) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h3", { text: "Advanced Native-like Search (Filter Builder)" });

    const info = contentEl.createEl("div");
    info.addClass("setting-item-description");
    info.setText("Enter text for each option and click '+' to add filters. Added filters are AND-combined.");

    // Global Query section (mode applies here)
    this.makeGlobalQuerySection(contentEl);

    // Divider: Filters (case sensitivity applies here)
    const divider = contentEl.createEl("hr");
    divider.style.marginTop = "12px";

    // Filters: file
    this.makeAddableFilterRow(
      contentEl,
      "file (File name — AND)",
      "e.g., 2025-09 or *.md",
      (v) => this.addChip(this.filePatterns, v),
      () => this.filePatterns
    );

    // Filters: path
    this.makeAddableFilterRow(
      contentEl,
      "path (Path — AND)",
      "e.g., notes/project or */daily/*",
      (v) => this.addChip(this.pathPatterns, v),
      () => this.pathPatterns
    );

    // Filters: tag
    this.makeAddableFilterRow(
      contentEl,
      "tag (Tag — AND)",
      "e.g., project or #project",
      (v) => {
        const tag = v.startsWith("#") ? v.slice(1) : v;
        this.addChip(this.tagFilters, tag);
      },
      () => this.tagFilters
    );

    // Filters: content
    this.makeAddableFilterRow(
      contentEl,
      "content (Body contains — AND)",
      "e.g., endpoint or /end.*point/i",
      (v) => this.addChip(this.contentPatterns, v),
      () => this.contentPatterns
    );

    // Filters: line (same line must contain ALL terms — AND)
    this.makeLineRow(contentEl);

    // Filters: headings (was section)
    this.makeAddableFilterRow(
      contentEl,
      "headings (Heading text — AND)",
      "e.g., Overview or /Chapter\\d+/",
      (v) => this.addChip(this.headingPatterns, v),
      () => this.headingPatterns
    );

    // Filters: property (frontmatter)
    this.makePropertyRow(contentEl);

    // Filter options (case sensitivity, sort, limit)
    this.makeFilterOptionsRow(contentEl);

    // Run
    const buttonRow = contentEl.createEl("div");
    buttonRow.style.marginTop = "12px";
    const runBtn = buttonRow.createEl("button", { text: "Run Search" });
    runBtn.onclick = () => this.submit();
  }

  onClose() {
    this.contentEl.empty();
  }

  // Global Query section (mode and targets)
  private makeGlobalQuerySection(parent: HTMLElement) {
    const wrap = parent.createEl("div");
    wrap.style.marginTop = "8px";

    const title = wrap.createEl("div", { text: "Global Query (applies across selected vault fields)" });
    title.addClass("setting-item-name");

    // Input
    this.globalQueryInputEl = this.makeTextRow(
      wrap,
      "Query (fuzzy/simple/regex)",
      "e.g., quick brown",
      null
    );

    // Mode (affects Global Query)
    const modeRow = wrap.createEl("div");
    modeRow.style.display = "flex";
    modeRow.style.alignItems = "center";
    modeRow.style.gap = "8px";
    modeRow.style.marginTop = "8px";

    modeRow.createEl("label", { text: "Mode (Global Query only)" });
    this.modeSelect = modeRow.createEl("select");
    this.modeSelect.createEl("option", { text: "simple (space-separated AND)", value: "simple" });
    this.modeSelect.createEl("option", { text: "fuzzy (Obsidian fuzzy)", value: "fuzzy" });
    this.modeSelect.createEl("option", { text: "regex (regular expression)", value: "regex" });
    this.modeSelect.value = "simple";

    // Clarification note for case sensitivity and regex behavior.
    const note = wrap.createEl("div");
    note.addClass("setting-item-description");
    note.style.marginTop = "6px";
    note.setText(
      "Note: Case sensitivity checkbox applies to filters only. Global Query ignores case sensitivity except for explicit regex flags. In regex mode, if you do not specify /.../flags, the default is case-insensitive (i)."
    );

    // Targets (vault-wide)
    const targetsTitle = wrap.createEl("div", { text: "Global Query targets (vault-wide)" });
    targetsTitle.addClass("setting-item-name");
    targetsTitle.style.marginTop = "8px";

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
      cb.checked = true; // default ON
      container.createEl("span", { text: labelText });
      return cb;
    };

    const body = makeCheckbox("Body");
    const name = makeCheckbox("File name");
    const path = makeCheckbox("Path");
    const fm = makeCheckbox("Frontmatter (keys and values)");
    const tags = makeCheckbox("Tags");
    const headings = makeCheckbox("Headings");

    this.gqTargetCheckboxes = {
      body,
      name,
      path,
      frontmatter: fm,
      tags,
      headings,
    };
  }

  // Utility: simple one-line text row
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

  // Utility: add chip to array and refresh
  private addChip(arr: string[], v: string) {
    const val = v.trim();
    if (!val) {
      new Notice("Value is empty.");
      return;
    }
    arr.push(val);
    this.requestChipRefresh?.();
  }

  // Shared chip refresh hook
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

        const del = chip.createEl("button", { text: "×" });
        del.style.marginLeft = "6px";
        del.onclick = () => {
          list.splice(idx, 1);
          refresh();
        };
      });
    };

    const prev = this.requestChipRefresh;
    this.requestChipRefresh = () => {
      prev?.();
      refresh();
    };
    refresh();
  }

  // line: same line must contain ALL terms (AND). Terms added as chips; internally combined via lookahead regex.
  private makeLineRow(parent: HTMLElement) {
    const wrap = parent.createEl("div");
    wrap.style.marginTop = "8px";

    const title = wrap.createEl("div", { text: "line (terms that must appear on the same line — AND)" });
    title.addClass("setting-item-name");

    const row = wrap.createEl("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";

    const inputEl = row.createEl("input", {
      type: "text",
      placeholder: 'e.g., har or "error 500". Space-separated input adds multiple terms at once.',
    });
    inputEl.style.flex = "1 1 auto";

    const addBtn = row.createEl("button", { text: "+" });
    addBtn.onclick = () => {
      const val = inputEl.value.trim();
      if (!val) {
        new Notice("Value is empty.");
        return;
      }
      const terms = tokenizeWithQuotes(val).filter(Boolean);
      if (terms.length === 0) {
        new Notice("No valid terms.");
        return;
      }
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

        const del = chip.createEl("button", { text: "×" });
        del.style.marginLeft = "6px";
        del.onclick = () => {
          this.lineTerms.splice(idx, 1);
          refresh();
        };
      });
    };
    refresh();
  }

  // property: name + value(optional)
  private makePropertyRow(parent: HTMLElement) {
    const wrap = parent.createEl("div");
    wrap.style.marginTop = "8px";

    const title = wrap.createEl("div", { text: "property (Frontmatter — AND)" });
    title.addClass("setting-item-name");

    const row = wrap.createEl("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";

    const nameEl = row.createEl("input", { type: "text", placeholder: "Property name (e.g., status)" });
    const valueEl = row.createEl("input", { type: "text", placeholder: "Value (e.g., done or /d(?!one)/i)" });

    nameEl.style.flex = "0 0 160px";
    valueEl.style.flex = "1 1 auto";

    const addBtn = row.createEl("button", { text: "+" });
    addBtn.onclick = () => {
      const name = nameEl.value.trim();
      const raw = valueEl.value.trim();
      if (!name) {
        new Notice("Enter a property name.");
        return;
      }
      let v: string | RegExp | null = null;
      if (raw) {
        v = tryParseExplicitRegex(raw) ?? raw;
      } else {
        v = null; // existence check
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

        const del = chip.createEl("button", { text: "×" });
        del.style.marginLeft = "6px";
        del.onclick = () => {
          this.propertyFilters.splice(idx, 1);
          refresh();
        };
      });
    };
    refresh();
  }

  // Filter options: case sensitivity, sort, limit
  private makeFilterOptionsRow(parent: HTMLElement) {
    const row = parent.createEl("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "repeat(auto-fit, minmax(220px, 1fr))";
    row.style.gap = "8px";
    row.style.marginTop = "12px";

    // Case sensitivity (filters only)
    {
      const cell = row.createEl("div");
      const label = cell.createEl("label");
      this.csCheckbox = cell.createEl("input", { type: "checkbox" });
      this.csCheckbox.style.marginRight = "6px";
      label.appendChild(this.csCheckbox);
      label.appendText("Case sensitive (filters only)");
    }

    // Sort
    {
      const cell = row.createEl("div");
      const label = cell.createEl("label", { text: "Sort" });
      this.sortSelect = cell.createEl("select");
      this.sortSelect.createEl("option", { text: "Modified time (newest first)", value: "mtime-desc" });
      this.sortSelect.createEl("option", { text: "Modified time (oldest first)", value: "mtime-asc" });
      this.sortSelect.createEl("option", { text: "Path (ascending)", value: "path-asc" });
      this.sortSelect.value = "mtime-desc";
    }

    // Limit
    {
      const cell = row.createEl("div");
      cell.createEl("label", { text: "Max results (leave empty for no limit)" });
      this.limitInput = cell.createEl("input", { type: "number", placeholder: "e.g., 100" });
      this.limitInput.min = "1";
    }
  }

  private submit() {
    const caseSensitive = !!this.csCheckbox.checked;

    // lineTerms -> single lookahead regex literal
    const linePatternLiteral =
      this.lineTerms.length > 0 ? buildLineRegexLiteral_AND(this.lineTerms, caseSensitive) : null;

    const p: ParsedQuery = {
      globalQuery: this.globalQueryInputEl.value.trim(),
      filePatterns: [...this.filePatterns],
      pathPatterns: [...this.pathPatterns],
      tagFilters: [...this.tagFilters],
      contentPatterns: [...this.contentPatterns],
      linePatterns: linePatternLiteral ? [linePatternLiteral] : [],
      headingPatterns: [...this.headingPatterns],
      propertyFilters: [...this.propertyFilters],
    };

    const options: SearchOptions = {
      mode: (this.modeSelect.value as SearchMode) ?? "simple",
      caseSensitive, // filters only
      sort: (this.sortSelect.value as SortMode) ?? "mtime-desc",
      limit: this.limitInput.value.trim() ? Math.max(1, Number(this.limitInput.value.trim())) : null,
      globalQueryTargets: {
        body: !!this.gqTargetCheckboxes?.body.checked,
        name: !!this.gqTargetCheckboxes?.name.checked,
        path: !!this.gqTargetCheckboxes?.path.checked,
        frontmatter: !!this.gqTargetCheckboxes?.frontmatter.checked,
        tags: !!this.gqTargetCheckboxes?.tags.checked,
        headings: !!this.gqTargetCheckboxes?.headings.checked,
      },
    };

    if (
      !p.globalQuery &&
      !p.filePatterns.length &&
      !p.pathPatterns.length &&
      !p.tagFilters.length &&
      !p.contentPatterns.length &&
      !p.linePatterns.length &&
      !p.headingPatterns.length &&
      !p.propertyFilters.length
    ) {
      new Notice("No filters specified. Please add at least one.");
      return;
    }

    this.onSubmit(p, options, { lineTerms: [...this.lineTerms] });
    this.close();
  }
}

/* =========================
   Results Modal UI (Unified)
   ========================= */

/**
 * Escape HTML special characters.
 */
function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/**
 * Collect highlight ranges for a plain substring term.
 */
function collectRangesPlain(text: string, term: string, caseSensitive: boolean, out: Array<[number, number]>) {
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

/**
 * Collect highlight ranges for a regex. Ensures global flag.
 */
function collectRangesRegex(text: string, rx: RegExp, out: Array<[number, number]>) {
  const flags = rx.flags.includes("g") ? rx.flags : rx.flags + "g";
  const grx = new RegExp(rx.source, flags);
  for (const m of text.matchAll(grx)) {
    const start = m.index ?? 0;
    const end = start + (m[0]?.length ?? 0);
    if (end > start) out.push([start, end]);
  }
}

/**
 * Collect highlight ranges for a glob pattern by converting to regex.
 */
function collectRangesGlob(text: string, glob: string, caseSensitive: boolean, out: Array<[number, number]>) {
  const base = globToRegExp(glob, caseSensitive);
  const flags = base.flags.includes("g") ? base.flags : base.flags + "g";
  const grx = new RegExp(base.source, flags);
  for (const m of text.matchAll(grx)) {
    const start = m.index ?? 0;
    const end = start + (m[0]?.length ?? 0);
    if (end > start) out.push([start, end]);
  }
}

/**
 * Merge overlapping or adjacent ranges.
 */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
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

/**
 * Build highlighted HTML given text and a set of pattern specs.
 */
function buildHighlightedHTML(
  text: string,
  opts: {
    lineTerms?: string[];
    contentPatterns?: string[];
    caseSensitive: boolean;
  }
): string {
  const ranges: Array<[number, number]> = [];

  // contentPatterns: can be regex literal, glob, or plain
  for (const pat of opts.contentPatterns ?? []) {
    const rx = tryParseExplicitRegex(pat);
    if (rx) {
      collectRangesRegex(text, rx, ranges);
    } else if (pat.includes("*") || pat.includes("?")) {
      collectRangesGlob(text, pat, opts.caseSensitive, ranges);
    } else {
      collectRangesPlain(text, pat, opts.caseSensitive, ranges);
    }
  }

  // lineTerms: plain substrings
  for (const term of opts.lineTerms ?? []) {
    collectRangesPlain(text, term, opts.caseSensitive, ranges);
  }

  const merged = mergeRanges(ranges);
  if (merged.length === 0) return escapeHTML(text);

  // Build HTML by slicing
  let html = "";
  let last = 0;
  for (const [s, e] of merged) {
    if (s > last) html += escapeHTML(text.slice(last, s));
    html += "<mark>" + escapeHTML(text.slice(s, e)) + "</mark>";
    last = e;
  }
  if (last < text.length) html += escapeHTML(text.slice(last));
  return html;
}

/**
 * Compute highlight inputs from excerpt.sources and matched fields.
 */
function computeHighlightedHTML(excerpt: { text: string; sources: string[] }, matched: MatchLog["matched"], caseSensitive: boolean): string {
  const contentSources = excerpt.sources.filter((s) => s.startsWith("content:"));
  const contentPatterns = contentSources.map((s) => s.slice("content:".length)).filter(Boolean);
  const lineTerms = matched?.lineTerms ?? [];
  return buildHighlightedHTML(excerpt.text, {
    lineTerms,
    contentPatterns,
    caseSensitive,
  });
}

/**
 * Results modal that groups by file, shows excerpts as cards, highlights hits,
 * and allows clicking to open at the hit line.
 */
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

    const title = contentEl.createEl("div", { text: "Search results" });
    title.addClass("setting-item-name");
    title.style.marginBottom = "8px";

    const container = contentEl.createEl("div");
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "12px";
    container.style.maxHeight = "70vh";
    container.style.overflow = "auto";

    for (const r of this.results) {
      const group = container.createEl("div");
      group.style.border = "1px solid var(--background-modifier-border)";
      group.style.borderRadius = "8px";
      group.style.padding = "8px";

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

        const meta = card.createEl("div");
        meta.style.display = "flex";
        meta.style.alignItems = "center";
        meta.style.gap = "8px";
        meta.style.color = "var(--text-muted)";
        meta.style.fontSize = "0.9em";
        meta.createEl("span", { text: ex.line >= 0 ? `Line ${ex.line}` : "Synthetic" });
        meta.createEl("span", { text: `• ${ex.sources.join(", ")}` });

        const body = card.createEl("div");
        body.style.marginTop = "6px";
        body.style.lineHeight = "1.5";
        body.style.wordBreak = "break-word";
        body.innerHTML = computeHighlightedHTML({ text: ex.text, sources: ex.sources }, r.matched, this.caseSensitive);

        card.onclick = async () => {
          await this.openFileAtLine(r.path, ex.line);
        };
      }
    }
  }

  onClose() {
    this.contentEl.empty();
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
}