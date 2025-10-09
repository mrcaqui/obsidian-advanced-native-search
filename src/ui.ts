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

  // Global Query input (prepare*Search / regex / exact)
  private globalQueryInputEl!: HTMLInputElement;
  private currentMode: SearchMode = "simple";

  // options
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

  // Modal-level keydown handler for Ctrl/Cmd+Enter submit
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(app: App, onSubmit: (parsed: ParsedQuery, options: SearchOptions, uiState: { lineTerms: string[] }) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;

    // Expand modal width to use available space
    this.modalEl.style.width = "90%";
    this.modalEl.style.maxWidth = "800px";

    contentEl.empty();
    contentEl.style.width = "100%";

    // Top-level title (h1)
    contentEl.createEl("h1", { text: "Advanced Native Search" });

    // =========================
    // Global Query section
    // =========================
    {
      const h2 = contentEl.createEl("h2", { text: "Global Query" });
      h2.style.color = "var(--text-accent)";
      h2.style.marginTop = "24px";

      const desc = contentEl.createEl("div");
      desc.addClass("setting-item-description");
      desc.style.marginTop = "4px";
      desc.setText("Search across selected vault fields (body, file name, path, frontmatter, tags, headings).");

      const note = contentEl.createEl("div");
      note.addClass("setting-item-description");
      note.style.marginTop = "4px";
      note.setText("Note: Global Query is case-insensitive unless explicit regex flags are provided; in regex mode, omitting /.../flags defaults to i.");

      const section = contentEl.createDiv();
      section.style.marginTop = "8px";

      this.makeGlobalQuerySection(section);
    }

    // =========================
    // Filters section
    // =========================
    {
      const h2 = contentEl.createEl("h2", { text: "Filters" });
      h2.style.color = "var(--text-accent)";
      h2.style.marginTop = "24px";

      const desc = contentEl.createEl("div");
      desc.addClass("setting-item-description");
      desc.style.marginTop = "4px";
      desc.setText("Conditions here are AND-combined to narrow down the files.");

      const section = contentEl.createDiv();
      section.style.marginTop = "8px";

      // Case sensitive (filters only)
      {
        const { controlEl } = this.createSettingItem(
          section,
          "Case sensitive",
          "When enabled, filters distinguish uppercase and lowercase. Global Query is unaffected."
        );
        this.csCheckbox = controlEl.createEl("input", { type: "checkbox" });
      }

      // Filters: File
      this.makeAddableFilterRow(
        section,
        "File",
        "Match file names using substring, glob (* or ?), or explicit /regex/. Files must satisfy all added patterns (AND).",
        (v) => this.addChip(this.filePatterns, v),
        () => this.filePatterns,
        "e.g., 2025-09 or *.md"
      );

      // Filters: Path
      this.makeAddableFilterRow(
        section,
        "Path",
        "Match the full vault path using substring, glob (* or ?), or explicit /regex/. Files must satisfy all added patterns (AND).",
        (v) => this.addChip(this.pathPatterns, v),
        () => this.pathPatterns,
        "e.g., notes/project or */daily/*"
      );

      // Filters: Tag
      this.makeAddableFilterRow(
        section,
        "Tag",
        "Require the note's tags to match each added filter (AND). Supports plain tag names and explicit /regex/. Tags are collected from body and frontmatter.",
        (v) => {
          const tag = v.startsWith("#") ? v.slice(1) : v;
          return this.addChip(this.tagFilters, tag);
        },
        () => this.tagFilters,
        "e.g., project or #project"
      );

      // Filters: Content
      this.makeAddableFilterRow(
        section,
        "Content",
        "Require the body to contain each added pattern (AND). Supports substring, glob (* or ?), and explicit /regex/.",
        (v) => this.addChip(this.contentPatterns, v),
        () => this.contentPatterns,
        "e.g., endpoint or /end.*point/i"
      );

      // Filters: Line (AND terms on the same line)
      this.makeLineRow(
        section,
        "Line",
        "Require a single line to contain all added terms (AND). Terms can include quoted phrases.",
        'e.g., har or "error 500"'
      );

      // Filters: Headings
      this.makeAddableFilterRow(
        section,
        "Headings",
        "Require heading text to match each added pattern (AND). Supports substring, glob (* or ?), and explicit /regex/.",
        (v) => this.addChip(this.headingPatterns, v),
        () => this.headingPatterns,
        "e.g., Overview or /Chapter\\d+/"
      );

      // Filters: Property
      this.makePropertyRow(
        section,
        "Property",
        "Filter by frontmatter property name and optional value. With an empty value, checks existence. Value supports exact string or /regex/."
      );
    }

    // =========================
    // Common Options section
    // =========================
    {
      const h2 = contentEl.createEl("h2", { text: "Common Options" });
      h2.style.color = "var(--text-accent)";
      h2.style.marginTop = "24px";

      const desc = contentEl.createEl("div");
      desc.addClass("setting-item-description");
      desc.style.marginTop = "4px";
      desc.setText("Settings applied to the overall search.");

      const section = contentEl.createDiv();
      section.style.marginTop = "8px";

      this.makeFilterOptionsRow(section);
    }

    // Run button
    const buttonRow = contentEl.createEl("div");
    buttonRow.style.marginTop = "16px";
    const runBtn = buttonRow.createEl("button", { text: "Run Search" });
    runBtn.onclick = () => this.submit();

    // Keyboard shortcut: Ctrl/Cmd+Enter (Win/Linux) or Cmd+Enter (macOS) to run search
    this.keydownHandler = (e: KeyboardEvent) => {
      // Avoid triggering during IME composition
      if ((e as any).isComposing) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.submit();
      }
    };
    // Capture to prevent bubbling to input-level Enter handlers
    this.modalEl.addEventListener("keydown", this.keydownHandler, { capture: true });
  }

  onClose() {
    // Remove keydown listener
    if (this.keydownHandler) {
      this.modalEl.removeEventListener("keydown", this.keydownHandler, true);
      this.keydownHandler = null;
    }
    this.contentEl.empty();
  }

  // Common: create a standard setting row with unified layout
  private createSettingItem(parent: HTMLElement, name: string, description: string) {
    // Use custom classes to avoid theme overrides that can center or add extra padding.
    const settingItem = parent.createDiv("qpm-setting-item");
    settingItem.style.display = "flex";
    settingItem.style.flexDirection = "column";
    settingItem.style.padding = "12px 0";
    settingItem.style.borderBottom = "1px solid var(--background-modifier-border)";

    // Consistent two-column layout across all sections (1:1 split).
    const rowEl = settingItem.createDiv("qpm-setting-item-row");
    rowEl.style.display = "grid";
    rowEl.style.gridTemplateColumns = "1fr 1fr"; // Equal widths for left and right columns.
    rowEl.style.alignItems = "start";
    rowEl.style.columnGap = "16px";
    (rowEl.style as any).justifyItems = "stretch";

    // Left column (label + description).
    const infoEl = rowEl.createDiv("qpm-setting-item-info");
    infoEl.style.margin = "0";
    infoEl.style.padding = "0";
    infoEl.style.textAlign = "left";
    infoEl.style.boxSizing = "border-box";
    infoEl.style.maxWidth = "100%";
    infoEl.style.wordBreak = "break-word";
    (infoEl.style as any).overflowWrap = "anywhere";

    const nameEl = infoEl.createEl("div", { text: name, cls: "setting-item-name" });
    nameEl.style.margin = "0 0 4px 0";
    nameEl.style.padding = "0";
    nameEl.style.textAlign = "left";

    // Match the font styling used for other descriptions by applying the same class.
    const descEl = infoEl.createEl("div", { text: description, cls: "setting-item-description" });
    descEl.style.margin = "0";
    descEl.style.padding = "0";
    descEl.style.textAlign = "left";

    // Right column (controls).
    const controlEl = rowEl.createDiv("qpm-setting-item-control");
    controlEl.style.display = "flex";
    controlEl.style.flexDirection = "column"; // vertical stack (input row, chips/footer)
    controlEl.style.alignItems = "stretch";   // stretch children to fill width
    controlEl.style.gap = "8px";
    controlEl.style.width = "100%";           // fill the right grid column
    controlEl.style.boxSizing = "border-box";

    return { settingItem, rowEl, infoEl, controlEl };
  }

  // Global Query section (Query, Mode segmented, Targets)
  private makeGlobalQuerySection(parent: HTMLElement) {
    // Query
    let inputRow: HTMLDivElement;
    {
      const { controlEl } = this.createSettingItem(
        parent,
        "Query",
        "Enter your Global Query. Mode buttons below change how it is interpreted."
      );
      inputRow = controlEl.createDiv();
      inputRow.style.display = "flex";
      inputRow.style.gap = "8px";
      inputRow.style.width = "100%";

      this.globalQueryInputEl = inputRow.createEl("input", {
        type: "text",
        placeholder: "e.g., quick brown",
      });
      // Ensure input grows and doesn't collapse.
      this.globalQueryInputEl.style.flex = "1 1 0";
      this.globalQueryInputEl.style.minWidth = "0";
      this.globalQueryInputEl.style.width = "100%";

      // Segmented Mode buttons just below the Query input
      const segRow = controlEl.createDiv();
      segRow.style.display = "flex";
      segRow.style.alignItems = "center";
      segRow.style.gap = "10px";
      segRow.style.flexWrap = "wrap";

      const btns: Array<{ value: SearchMode; btn: HTMLButtonElement; info: HTMLSpanElement }> = [];

      const makeSegButton = (label: string, value: SearchMode, tooltip: string) => {
        const wrap = segRow.createDiv();
        wrap.style.display = "flex";
        wrap.style.alignItems = "center";
        wrap.style.gap = "6px";

        const btn = wrap.createEl("button", { text: label });
        btn.style.padding = "6px 10px";
        btn.style.border = "1px solid var(--background-modifier-border)";
        btn.style.borderRadius = "6px";
        btn.style.cursor = "pointer";
        btn.setAttr("role", "radio");

        const info = wrap.createEl("span", { text: "i" });
        info.title = tooltip;
        info.style.display = "inline-flex";
        info.style.alignItems = "center";
        info.style.justifyContent = "center";
        info.style.width = "18px";
        info.style.height = "18px";
        info.style.border = "1px solid var(--background-modifier-border)";
        info.style.borderRadius = "50%";
        info.style.fontSize = "12px";
        info.style.color = "var(--text-muted)";
        info.style.cursor = "help";

        btn.onclick = () => {
          this.currentMode = value;
          refreshSegStyles();
          refreshPlaceholder();
        };

        btns.push({ value, btn, info });
      };

      makeSegButton(
        "Simple",
        "simple",
        "Space-separated AND search across selected targets. Case-insensitive. Good for quick queries."
      );
      makeSegButton(
        "Fuzzy",
        "fuzzy",
        "Obsidian fuzzy matching. Characters can be non-adjacent. Case-insensitive. Useful for loose matches."
      );
      makeSegButton(
        "Regex",
        "regex",
        "Treat the query as a regular expression. Defaults to case-insensitive unless flags are provided (e.g., /.../i)."
      );
      makeSegButton(
        "Exact",
        "exact",
        "Exact phrase match (contiguous substring). Case-insensitive. Quotes not required."
      );

      const refreshSegStyles = () => {
        for (const { value, btn } of btns) {
          const selected = value === this.currentMode;
          btn.style.backgroundColor = selected ? "var(--interactive-accent)" : "var(--background-secondary)";
          btn.style.color = selected ? "var(--text-on-accent)" : "var(--text-normal)";
          btn.style.opacity = selected ? "1" : "0.9";
          btn.setAttr("aria-pressed", String(selected));
        }
      };

      const refreshPlaceholder = () => {
        if (!this.globalQueryInputEl) return;
        switch (this.currentMode) {
          case "simple":
            this.globalQueryInputEl.placeholder = "e.g., quick brown (space-separated AND)";
            break;
          case "fuzzy":
            this.globalQueryInputEl.placeholder = "e.g., qb (fuzzy match)";
            break;
          case "regex":
            this.globalQueryInputEl.placeholder = "e.g., /quick\\s+brown/i";
            break;
          case "exact":
            this.globalQueryInputEl.placeholder = "e.g., star wars (contiguous phrase; no quotes needed)";
            break;
        }
      };

      refreshSegStyles();
      refreshPlaceholder();
    }

    // Targets — place checkboxes inside the right column (controlEl)
    {
      const { controlEl } = this.createSettingItem(
        parent,
        "Targets",
        "Select the vault fields to search across."
      );

      const grid = controlEl.createDiv("targets-grid");
      grid.style.display = "grid";
      grid.style.gridTemplateColumns = "repeat(auto-fit, minmax(160px, 1fr))";
      grid.style.gap = "6px";
      grid.style.width = "100%";

      const makeCheckbox = (labelText: string): HTMLInputElement => {
        const container = grid.createEl("label");
        container.style.display = "flex";
        container.style.alignItems = "center";
        container.style.gap = "6px";
        container.style.justifyContent = "flex-start";
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
  }

  // Utility: add chip to array and refresh all chip views. Returns true if added.
  private addChip(arr: string[], v: string): boolean {
    const val = v.trim();
    if (!val) {
      new Notice("Value is empty.");
      return false;
    }
    arr.push(val);
    this.requestChipRefresh?.();
    return true;
  }

  // Shared chip refresh hook (chain all refreshers)
  private requestChipRefresh: (() => void) | null = null;

  // Addable filter row (2-column layout; chips below input inside controlEl)
  private makeAddableFilterRow(
    parent: HTMLElement,
    label: string,
    description: string,
    onAdd: (value: string) => boolean,
    getList: () => string[],
    placeholder: string
  ) {
    const { settingItem, controlEl } = this.createSettingItem(parent, label, description);

    // 1) Input row (right column)
    const inputRow = controlEl.createDiv();
    inputRow.style.display = "flex";
    inputRow.style.gap = "8px";
    inputRow.style.width = "100%";
    inputRow.style.boxSizing = "border-box";

    const inputEl = inputRow.createEl("input", { type: "text", placeholder });
    inputEl.style.flex = "1 1 0";
    inputEl.style.minWidth = "0";
    inputEl.style.width = "100%";

    const addBtn = inputRow.createEl("button", { text: "+" });

    const handleAdd = () => {
      const raw = inputEl.value;
      const val = raw.trim();
      if (!val) {
        new Notice("Value is empty.");
        return;
      }
      const ok = onAdd(val);
      if (ok) {
        inputEl.value = "";
        inputEl.focus();
      }
    };
    addBtn.onclick = handleAdd;
    inputEl.addEventListener("keydown", (e) => {
      // Ignore Ctrl/Cmd+Enter (handled by modal-level shortcut) and IME composition
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !(e as any).isComposing) {
        handleAdd();
      }
    });

    // 2) Chips container directly beneath input
    const chipsEl = controlEl.createDiv("qpm-setting-item-chips-container");
    chipsEl.style.display = "flex";
    chipsEl.style.flexWrap = "wrap";
    chipsEl.style.gap = "6px";
    chipsEl.style.justifyContent = "flex-end"; // keep chips aligned to the right as before
    chipsEl.style.width = "100%";

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

    return { settingItem, inputEl, addBtn, chipsEl };
  }

  // Line: same line must contain ALL terms — chips under input inside controlEl
  private makeLineRow(
    parent: HTMLElement,
    label: string,
    description: string,
    placeholder: string
  ) {
    const { settingItem, controlEl } = this.createSettingItem(parent, label, description);

    const inputRow = controlEl.createDiv();
    inputRow.style.display = "flex";
    inputRow.style.gap = "8px";
    inputRow.style.width = "100%";

    const inputEl = inputRow.createEl("input", {
      type: "text",
      placeholder,
    }) as HTMLInputElement;
    inputEl.style.flex = "1 1 0";
    inputEl.style.minWidth = "0";
    inputEl.style.width = "100%";

    const addBtn = inputRow.createEl("button", { text: "+" });

    const chipsEl = controlEl.createDiv("qpm-setting-item-chips-container");
    chipsEl.style.display = "flex";
    chipsEl.style.flexWrap = "wrap";
    chipsEl.style.gap = "6px";
    chipsEl.style.justifyContent = "flex-end";
    chipsEl.style.width = "100%";

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

    const handleAdd = () => {
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
      const before = this.lineTerms.length;
      for (const t of terms) {
        if (!this.lineTerms.includes(t)) this.lineTerms.push(t);
      }
      refresh();
      if (this.lineTerms.length > before) {
        inputEl.value = "";
        inputEl.focus();
      }
    };

    addBtn.onclick = handleAdd;
    inputEl.addEventListener("keydown", (e) => {
      // Ignore Ctrl/Cmd+Enter (handled by modal-level shortcut) and IME composition
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !(e as any).isComposing) {
        handleAdd();
      }
    });

    const prev = this.requestChipRefresh;
    this.requestChipRefresh = () => {
      prev?.();
      refresh();
    };
    refresh();

    return { settingItem, inputEl, addBtn, chipsEl };
  }

  // Property: name + value (optional) — chips under inputs inside controlEl
  private makePropertyRow(parent: HTMLElement, label: string, description: string) {
    const { settingItem, controlEl } = this.createSettingItem(parent, label, description);

    const inputsRow = controlEl.createDiv();
    inputsRow.style.display = "flex";
    inputsRow.style.gap = "8px";
    inputsRow.style.width = "100%";

    const nameEl = inputsRow.createEl("input", { type: "text", placeholder: "Property name (e.g., status)" }) as HTMLInputElement;
    nameEl.style.flex = "1 1 40%";
    nameEl.style.minWidth = "0";

    const valueEl = inputsRow.createEl("input", { type: "text", placeholder: "Value (e.g., done or /d(?!one)/i)" }) as HTMLInputElement;
    valueEl.style.flex = "1 1 60%";
    valueEl.style.minWidth = "0";

    const addBtn = inputsRow.createEl("button", { text: "+" });

    const chipsEl = controlEl.createDiv("qpm-setting-item-chips-container");
    chipsEl.style.display = "flex";
    chipsEl.style.flexWrap = "wrap";
    chipsEl.style.gap = "6px";
    chipsEl.style.justifyContent = "flex-end";
    chipsEl.style.width = "100%";

    const refresh = () => {
      chipsEl.empty();
      this.propertyFilters.forEach((pf, idx) => {
        const valStr =
          pf.value === null
            ? "(exists)"
            : pf.value instanceof RegExp
            ? `/${pf.value.source}/${pf.value.flags}`
            : String(pf.value);
        const labelText = `${pf.name}:${valStr}`;
        const chip = chipsEl.createEl("span", { text: labelText });
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

    const handleAdd = () => {
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
      // Clear inputs and focus name for faster subsequent additions
      nameEl.value = "";
      valueEl.value = "";
      nameEl.focus();
    };

    addBtn.onclick = handleAdd;
    nameEl.addEventListener("keydown", (e) => {
      // Ignore Ctrl/Cmd+Enter (handled by modal-level shortcut) and IME composition
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !(e as any).isComposing) {
        handleAdd();
      }
    });
    valueEl.addEventListener("keydown", (e) => {
      // Ignore Ctrl/Cmd+Enter (handled by modal-level shortcut) and IME composition
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !(e as any).isComposing) {
        handleAdd();
      }
    });

    const prev = this.requestChipRefresh;
    this.requestChipRefresh = () => {
      prev?.();
      refresh();
    };
    refresh();
  }

  // Common Options: Sort, Max results — independent setting-items
  private makeFilterOptionsRow(parent: HTMLElement) {
    // Sort
    {
      const { controlEl } = this.createSettingItem(
        parent,
        "Sort",
        "Choose the ordering of the search results."
      );
      const inputRow = controlEl.createDiv();
      inputRow.style.display = "flex";
      inputRow.style.gap = "8px";
      inputRow.style.width = "100%";

      this.sortSelect = inputRow.createEl("select");
      this.sortSelect.createEl("option", { text: "Modified time (newest first)", value: "mtime-desc" });
      this.sortSelect.createEl("option", { text: "Modified time (oldest first)", value: "mtime-asc" });
      this.sortSelect.createEl("option", { text: "Path (ascending)", value: "path-asc" });
      this.sortSelect.value = "mtime-desc";
      this.sortSelect.style.flex = "1 1 0";
      this.sortSelect.style.minWidth = "0";
      this.sortSelect.style.width = "100%";
    }

    // Max results
    {
      const { controlEl } = this.createSettingItem(
        parent,
        "Max results",
        "Maximum number of results to display. Leave empty for no limit."
      );
      const inputRow = controlEl.createDiv();
      inputRow.style.display = "flex";
      inputRow.style.gap = "8px";
      inputRow.style.width = "100%";

      this.limitInput = inputRow.createEl("input", { type: "number", placeholder: "e.g., 100" });
      this.limitInput.min = "1";
      this.limitInput.style.flex = "1 1 0";
      this.limitInput.style.minWidth = "0";
      this.limitInput.style.width = "100%";
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
      mode: this.currentMode,
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