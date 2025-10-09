// ui.ts
import { App, Modal, Notice } from "obsidian";
import {
  ParsedQuery,
  SearchOptions,
  SearchMode,
  SortMode,
  tryParseExplicitRegex,
  buildLineRegexLiteral_AND,
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