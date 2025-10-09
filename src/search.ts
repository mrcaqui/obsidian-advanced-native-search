// search.ts
import { App, TFile, prepareFuzzySearch, prepareSimpleSearch } from "obsidian";

/**
 * Search mode for the Global Query.
 */
export type SearchMode = "fuzzy" | "simple" | "regex" | "exact";

/**
 * Sort options.
 */
export type SortMode = "mtime-desc" | "mtime-asc" | "path-asc";

/**
 * Target fields for the Global Query.
 * By default all are true (search across the entire vault).
 */
export interface GlobalQueryTargets {
  body: boolean;
  name: boolean;
  path: boolean;
  frontmatter: boolean; // both key name and values
  tags: boolean;
  headings: boolean;
}

/**
 * User-selectable search options.
 * Note:
 * - mode affects only the Global Query.
 * - caseSensitive affects only filter evaluations (file/path/tag/content/line/headings/property).
 */
export interface SearchOptions {
  mode: SearchMode;
  caseSensitive: boolean;
  sort: SortMode;
  limit?: number | null;
  globalQueryTargets: GlobalQueryTargets;
}

/**
 * Parsed query (filters are all AND-combined).
 */
export interface ParsedQuery {
  // Global query (free-form across selected vault fields; prepare*Search/regex/applied to strings)
  globalQuery: string;

  // Dedicated operators (AND-combined)
  filePatterns: string[];     // file:
  pathPatterns: string[];     // path:
  tagFilters: string[];       // tag: (may include leading #)
  contentPatterns: string[];  // content:
  linePatterns: string[];     // line: (same line must contain ALL terms (AND); implemented via a single lookahead regex)
  headingPatterns: string[];  // headings: (was section:)
  // Frontmatter / properties
  propertyFilters: Array<{ name: string; value: string | RegExp | null }>;
}

/**
 * Excerpt info for hit lines.
 */
export interface Excerpt {
  line: number;       // 0-based (use -1 for synthetic lines)
  text: string;       // formatted line text or synthetic description
  sources: string[];  // reasons, e.g., "line", "content:<pattern>", "globalQuery:<mode>", etc.
}

/**
 * Filter-wise hit stats (for accepted files).
 */
export interface FilterHitStats {
  file?: number;
  path?: number;
  tag?: number;
  property?: number;
  headings?: number;
  content?: number;
  line?: number;
  globalQuery?: number;
  // breakdown per Global Query target
  globalQueryBreakdown?: {
    body?: number;
    name?: number;
    path?: number;
    frontmatter?: number;
    tags?: number;
    headings?: number;
  };
}

/**
 * Result entry for logging.
 */
export interface MatchLog {
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
    exactPhrase?: string; // for Exact mode highlighting
  };
  // line hit detail
  line: {
    patternLiteral: string | null;
    hitCount: number;
    hitLineIndices: number[];
  } | null;
  // prepare*Search result for body (if any)
  searchResult?: any;
  // regex mode: total match count across targets (approx)
  regexMatchCount?: number;
  // excerpts (max N lines)
  excerpts?: Excerpt[];
  // filter-wise hits
  filterHits?: FilterHitStats;
}

/**
 * Utility: parse explicit regex literal /pattern/flags into RegExp.
 */
export function tryParseExplicitRegex(pattern: string): RegExp | null {
  const m = pattern.match(/^\/(.+)\/([a-z]*)$/i);
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2]);
  } catch {
    return null;
  }
}

/**
 * Utility: convert glob (* ?) to RegExp.
 */
export function globToRegExp(glob: string, caseSensitive: boolean): RegExp {
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
 * Utility: substring includes with case sensitivity.
 */
function includesWithCase(haystack: string, needle: string, caseSensitive: boolean): boolean {
  if (!caseSensitive) {
    return haystack.toLowerCase().includes(needle.toLowerCase());
  }
  return haystack.includes(needle);
}

/**
 * Case-insensitive includes (for Global Query: Exact and default behavior).
 */
function includesCI(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Count occurrences (case-insensitive).
 */
function countOccurrencesCI(haystack: string, needle: string): number {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let idx = 0, count = 0;
  while (true) {
    const pos = h.indexOf(n, idx);
    if (pos === -1) break;
    count++;
    idx = pos + Math.max(1, n.length);
  }
  return count;
}

/**
 * Match a value against a pattern:
 * - explicit /regex/ -> RegExp
 * - includes * or ? -> glob
 * - otherwise -> substring match
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
 * Collect tags for a file (# stripped, unique).
 * - cache.tags (in-body tags)
 * - frontmatter.tags (string | string[])
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
    // allow comma/space separated
    for (const v of fmTags.split(/[,\s]+/)) push(v);
  }

  return set;
}

/**
 * Frontmatter property match.
 */
function matchProperty(cache: any, name: string, value: string | RegExp | null, caseSensitive: boolean): boolean {
  const fm = cache?.frontmatter;
  if (!fm) return false;

  const v = fm[name];
  if (typeof v === "undefined") return false;

  if (value === null) {
    // existence check only
    return true;
  }

  // value match
  if (value instanceof RegExp) {
    return value.test(String(v));
  }

  // array or scalar (array is ANY match)
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
 * Heading match (from cache.headings).
 */
function matchHeading(app: App, file: TFile, pattern: string, caseSensitive: boolean): boolean {
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
 * Count matches for line: AND regex across lines.
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
 * content: pattern match in text.
 */
function contentContains(text: string, pattern: string, caseSensitive: boolean): boolean {
  const rx = tryParseExplicitRegex(pattern);
  if (rx) return rx.test(text);
  return matchPattern(text, pattern, caseSensitive);
}

/**
 * Format a line for logging.
 */
function formatLineForLog(s: string, maxLen = 240): string {
  const cleaned = s.replace(/\t/g, "  ").replace(/\r/g, "").replace(/\u0000/g, "");
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + "…";
}

/**
 * Extract hit lines:
 * - line: apply single AND regex per line.
 * - content: apply each pattern per line.
 * - Global Query (body only here): simple/fuzzy via searchFn per line, regex via regexForGlobalQuery per line, exact via includesCI per line.
 *
 * Note: non-body Global Query excerpts (name/path/frontmatter/tags/headings) are generated separately and merged.
 */
function extractHitLines(
  text: string,
  parsed: ParsedQuery,
  options: SearchOptions,
  searchFn: ((text: string) => any) | null,
  regexForGlobalQuery: RegExp | null,
  exactPhrase: string | null,
  perFileLimit = 10
): Excerpt[] {
  const { caseSensitive, mode } = options;
  const lines = text.split(/\r?\n/);

  // line index -> reasons(Set)
  const reasons = new Map<number, Set<string>>();

  const addReason = (idx: number, r: string) => {
    if (idx < 0 || idx >= lines.length) return;
    if (!reasons.has(idx)) reasons.set(idx, new Set<string>());
    reasons.get(idx)!.add(r);
  };

  // line: AND
  if (parsed.linePatterns.length > 0) {
    const literal = parsed.linePatterns[0];
    const rx = tryParseExplicitRegex(literal) ?? new RegExp(literal, caseSensitive ? "" : "i");
    for (let i = 0; i < lines.length; i++) {
      if (rx.test(lines[i])) addReason(i, "line");
    }
  }

  // content: AND for file acceptance, but excerpts list OR hits per pattern
  if (parsed.contentPatterns.length > 0) {
    for (const pat of parsed.contentPatterns) {
      for (let i = 0; i < lines.length; i++) {
        if (contentContains(lines[i], pat, caseSensitive)) addReason(i, `content:${pat}`);
      }
    }
  }

  // Global Query on body (simple/fuzzy/regex/exact)
  if (parsed.globalQuery && options.globalQueryTargets.body) {
    if ((mode === "simple" || mode === "fuzzy") && searchFn) {
      for (let i = 0; i < lines.length; i++) {
        if (searchFn(lines[i])) addReason(i, `globalQuery:${mode}`);
      }
    } else if (mode === "regex" && regexForGlobalQuery) {
      // Use non-global regex for per-line test to avoid lastIndex issues.
      for (let i = 0; i < lines.length; i++) {
        if (regexForGlobalQuery.test(lines[i])) addReason(i, "globalQuery:regex");
      }
    } else if (mode === "exact" && exactPhrase) {
      for (let i = 0; i < lines.length; i++) {
        if (includesCI(lines[i], exactPhrase)) addReason(i, "globalQuery:exact");
      }
    }
  }

  const all = Array.from(reasons.entries())
    .sort((a, b) => a[0] - b[0])
    .map<Excerpt>(([idx, set]) => ({
      line: idx,
      text: formatLineForLog(lines[idx]),
      sources: Array.from(set.values()),
    }));

  return all.slice(0, perFileLimit);
}

/**
 * Convert offset to line index (0-based).
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
 * Build heading excerpts:
 * - use position.start.line or fallback from position.start.offset.
 * - sources use "headings:<pattern>".
 */
function buildHeadingExcerpts(
  app: App,
  file: TFile,
  text: string,
  patterns: string[],
  caseSensitive: boolean
): Excerpt[] {
  if (!patterns || patterns.length === 0) return [];
  const cache = app.metadataCache.getFileCache(file);

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
      lineToSources.get(lineIdx)!.add(`headings:${pat}`);
    }
  }

  const excerpts: Excerpt[] = Array.from(lineToSources.entries())
    .sort((a, b) => a[0] - b[0])
    .map<Excerpt>(([idx, srcs]) => ({
      line: idx,
      text: lines[idx] ?? "",
      sources: Array.from(srcs.values()),
    }));

  return excerpts;
}

/**
 * Merge excerpts by line index, union sources. Apply perFileLimit.
 */
function mergeExcerpts(base: Excerpt[] | undefined, add: Excerpt[], perFileLimit = 10): Excerpt[] {
  const map = new Map<number, { text: string; sources: Set<string> }>();

  const push = (arr?: Excerpt[]) => {
    if (!arr) return;
    for (const ex of arr) {
      const cur = map.get(ex.line);
      if (cur) {
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
 * Ensure a RegExp has global flag.
 */
function ensureGlobalRegex(rx: RegExp): RegExp {
  const flags = rx.flags.includes("g") ? rx.flags : rx.flags + "g";
  return new RegExp(rx.source, flags);
}

/**
 * Count regex matches using matchAll on a globalized regex.
 */
function countRegexMatches(text: string, rx: RegExp): number {
  const grx = ensureGlobalRegex(rx);
  let count = 0;
  for (const _ of text.matchAll(grx)) count++;
  return count;
}

/**
 * Test a single string against the Global Query.
 * Returns hit boolean and count (1 for simple/fuzzy/exact; match count for regex).
 */
function testGlobalString(
  s: string,
  searchFn: ((text: string) => any) | null,
  regex: RegExp | null,
  mode: SearchMode,
  exactPhrase?: string | null
): { hit: boolean; count: number } {
  if (!s) return { hit: false, count: 0 };
  if (mode === "regex" && regex) {
    const count = countRegexMatches(s, regex);
    return { hit: count > 0, count };
  } else if ((mode === "simple" || mode === "fuzzy") && searchFn) {
    const r = !!searchFn(s);
    return { hit: r, count: r ? 1 : 0 };
  } else if (mode === "exact" && exactPhrase) {
    const r = includesCI(s, exactPhrase);
    return { hit: r, count: r ? 1 : 0 };
  }
  return { hit: false, count: 0 };
}

/**
 * Build synthetic excerpts for non-body Global Query targets.
 * Adds descriptive lines for name/path/frontmatter/tags/headings hits.
 */
function buildGlobalSyntheticExcerpts(
  text: string,
  name: string,
  path: string,
  cache: any,
  targets: GlobalQueryTargets,
  searchFn: ((text: string) => any) | null,
  regex: RegExp | null,
  mode: SearchMode,
  exactPhrase: string | null
): Excerpt[] {
  const ex: Excerpt[] = [];
  const lines = text.split(/\r?\n/);

  const pushSynthetic = (label: string, value: string, m: SearchMode) => {
    ex.push({
      line: -1,
      text: `[${label}] ${value}`,
      sources: [`globalQuery:${m}:${label.toLowerCase()}`],
    });
  };

  // name
  if (targets.name) {
    const { hit } = testGlobalString(name, searchFn, regex, mode, exactPhrase);
    if (hit) pushSynthetic("name", name, mode);
  }

  // path
  if (targets.path) {
    const { hit } = testGlobalString(path, searchFn, regex, mode, exactPhrase);
    if (hit) pushSynthetic("path", path, mode);
  }

  // frontmatter
  if (targets.frontmatter) {
    const fm = cache?.frontmatter;
    if (fm && typeof fm === "object") {
      for (const key of Object.keys(fm)) {
        const keyRes = testGlobalString(key, searchFn, regex, mode, exactPhrase);
        if (keyRes.hit) pushSynthetic("frontmatter-key", key, mode);

        const val = fm[key];
        const values: string[] = Array.isArray(val)
          ? val.map((x: any) => String(x ?? ""))
          : [String(val ?? "")];

        for (const v of values) {
          const res = testGlobalString(v, searchFn, regex, mode, exactPhrase);
          if (res.hit) pushSynthetic("frontmatter", `${key}: ${v}`, mode);
        }
      }
    }
  }

  // tags
  if (targets.tags) {
    const set = new Set<string>();
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
    const pushTagVal = (x: unknown) => {
      const s = String(x ?? "").trim();
      if (!s) return;
      const cleaned = s.startsWith("#") ? s.slice(1) : s;
      if (cleaned) set.add(cleaned);
    };
    if (Array.isArray(fmTags)) {
      for (const v of fmTags) pushTagVal(v);
    } else if (typeof fmTags === "string") {
      for (const v of fmTags.split(/[,\s]+/)) pushTagVal(v);
    }

    for (const tg of set) {
      const res = testGlobalString(tg, searchFn, regex, mode, exactPhrase);
      if (res.hit) pushSynthetic("tag", tg, mode);
    }
  }

  // headings (use heading text and line excerpt if available)
  if (targets.headings) {
    const headings = (cache?.headings ?? []) as any[];
    for (const h of headings) {
      const headingText: string = String(h?.heading ?? "");
      if (!headingText) continue;
      const res = testGlobalString(headingText, searchFn, regex, mode, exactPhrase);
      if (res.hit) {
        let lineIdx: number | undefined = h?.position?.start?.line;
        if (typeof lineIdx !== "number") {
          const off = h?.position?.start?.offset;
          if (typeof off === "number") {
            lineIdx = offsetToLine(text, off);
          }
        }
        const excerptText =
          typeof lineIdx === "number" ? (lines[lineIdx] ?? headingText) : headingText;
        ex.push({
          line: typeof lineIdx === "number" ? lineIdx : -1,
          text: `[headings] ${excerptText}`,
          sources: [`globalQuery:${mode}:headings`],
        });
      }
    }
  }

  return ex;
}

/**
 * Build a single AND lookahead regex literal for line: terms.
 * Example: ["tool","har"] -> '/^(?=.*tool)(?=.*har).*$/i'
 */
export function buildLineRegexLiteral_AND(terms: string[], caseSensitive: boolean): string {
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const core = terms.map((t) => `(?=.*${escapeRegex(t)})`).join("") + ".*";
  const flags = caseSensitive ? "" : "i";
  return `/^${core}$/` + (flags ? flags : "");
}

/**
 * Execute search across the vault. Returns matches and summary stats.
 * UI表示やNoticeは含めません（plugin.ts側で実行）。
 */
export async function runSearch(
  app: App,
  parsed: ParsedQuery,
  options: SearchOptions,
  uiState: { lineTerms: string[] }
): Promise<{
  matches: MatchLog[];
  summary: { matchedFiles: number; totalLineHits: number; timeMs: number };
}> {
  const t0 = performance.now();
  const files = app.vault.getMarkdownFiles();

  if (!files.length) {
    return { matches: [], summary: { matchedFiles: 0, totalLineHits: 0, timeMs: 0 } };
  }

  const { mode, caseSensitive, sort, limit, globalQueryTargets } = options;

  // prepare*Search for Global Query (returns truthy for matching strings)
  let searchFn: ((text: string) => any) | null = null;
  if (parsed.globalQuery) {
    if (mode === "simple") {
      searchFn = prepareSimpleSearch(parsed.globalQuery);
    } else if (mode === "fuzzy") {
      searchFn = prepareFuzzySearch(parsed.globalQuery);
    } else {
      searchFn = null; // regex/exact handled separately
    }
  }

  // regex for Global Query:
  // - regexForGlobalQuerySearch: used for per-line/boolean tests (non-global to avoid lastIndex issues).
  let regexForGlobalQuerySearch: RegExp | null = null;
  const exactPhrase = mode === "exact" && parsed.globalQuery ? parsed.globalQuery.trim() : null;

  if (mode === "regex" && parsed.globalQuery) {
    const explicit = tryParseExplicitRegex(parsed.globalQuery);
    if (explicit) {
      regexForGlobalQuerySearch = new RegExp(explicit.source, explicit.flags.replace(/g/g, ""));
    } else {
      regexForGlobalQuerySearch = new RegExp(parsed.globalQuery, "i");
    }
  }

  // Pre-sort files by selected criterion for top-N retrieval with early break.
  const sortedFiles = [...files];
  if (sort === "mtime-desc") {
    sortedFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);
  } else if (sort === "mtime-asc") {
    sortedFiles.sort((a, b) => a.stat.mtime - b.stat.mtime);
  } else if (sort === "path-asc") {
    sortedFiles.sort((a, b) => a.path.localeCompare(b.path));
  }

  const matches: MatchLog[] = [];
  let totalLineHits = 0;
  let matchedFiles = 0;
  const maxResults = typeof limit === "number" && limit > 0 ? limit : Infinity;

  for (const file of sortedFiles) {
    const cache = app.metadataCache.getFileCache(file);
    const path = file.path;
    const name = file.name;

    // file: (AND)
    if (parsed.filePatterns.length > 0) {
      const ok = parsed.filePatterns.every((pat) => matchPattern(name, pat, caseSensitive));
      if (!ok) continue;
    }
    // path: (AND)
    if (parsed.pathPatterns.length > 0) {
      const ok = parsed.pathPatterns.every((pat) => matchPattern(path, pat, caseSensitive));
      if (!ok) continue;
    }
    // tag: (AND)
    if (parsed.tagFilters.length > 0) {
      const tags = getTagsForFile(app, file);
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
    // property: (AND)
    if (parsed.propertyFilters.length > 0) {
      const ok = parsed.propertyFilters.every((pf) =>
        matchProperty(cache, pf.name, pf.value, caseSensitive)
      );
      if (!ok) continue;
    }
    // headings: (AND)
    if (parsed.headingPatterns.length > 0) {
      const ok = parsed.headingPatterns.every((pat) =>
        matchHeading(app, file, pat, caseSensitive)
      );
      if (!ok) continue;
    }

    // read body for content/line/Global Query body/headings excerpts
    const text = await app.vault.cachedRead(file);

    // content: (AND)
    if (parsed.contentPatterns.length > 0) {
      const ok = parsed.contentPatterns.every((pat) => contentContains(text, pat, caseSensitive));
      if (!ok) continue;
    }

    // line: (AND on same line)
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

    // Global Query (OR across selected targets) — at least one target must hit
    let gqHit = !parsed.globalQuery; // if not specified, treat as pass-through
    const gqBreakdown: FilterHitStats["globalQueryBreakdown"] = {};
    let regexMatchTotal = 0;

    // body (collect line hits count for breakdown)
    const lines = text.split(/\r?\n/);
    let searchResultBody: any = null;
    if (parsed.globalQuery && globalQueryTargets.body) {
      if ((mode === "simple" || mode === "fuzzy") && searchFn) {
        searchResultBody = searchFn(text);
        if (searchResultBody) {
          gqHit = true;
          let c = 0;
          for (const ln of lines) {
            if (searchFn(ln)) c++;
          }
          gqBreakdown.body = c;
        }
      } else if (mode === "regex" && regexForGlobalQuerySearch) {
        const cnt = countRegexMatches(text, regexForGlobalQuerySearch);
        if (cnt > 0) {
          gqHit = true;
          gqBreakdown.body = cnt;
          regexMatchTotal += cnt;
        }
      } else if (mode === "exact" && exactPhrase) {
        if (includesCI(text, exactPhrase)) {
          gqHit = true;
          let c = 0;
          for (const ln of lines) {
            if (includesCI(ln, exactPhrase)) c++;
          }
          gqBreakdown.body = c;
        }
      }
    }

    // name
    if (parsed.globalQuery && globalQueryTargets.name) {
      const { hit, count } = testGlobalString(name, searchFn, regexForGlobalQuerySearch, mode, exactPhrase);
      if (hit) {
        gqHit = true;
        gqBreakdown.name = (gqBreakdown.name ?? 0) + count;
        if (mode === "regex") regexMatchTotal += count;
      }
    }

    // path
    if (parsed.globalQuery && globalQueryTargets.path) {
      const { hit, count } = testGlobalString(path, searchFn, regexForGlobalQuerySearch, mode, exactPhrase);
      if (hit) {
        gqHit = true;
        gqBreakdown.path = (gqBreakdown.path ?? 0) + count;
        if (mode === "regex") regexMatchTotal += count;
      }
    }

    // frontmatter (keys and values)
    if (parsed.globalQuery && globalQueryTargets.frontmatter) {
      const fm = cache?.frontmatter;
      if (fm && typeof fm === "object") {
        let localCount = 0;
        for (const key of Object.keys(fm)) {
          const keyRes = testGlobalString(key, searchFn, regexForGlobalQuerySearch, mode, exactPhrase);
          if (keyRes.hit) localCount += keyRes.count;

          const val = fm[key];
          const values: string[] = Array.isArray(val)
            ? val.map((x: any) => String(x ?? ""))
            : [String(val ?? "")];

          for (const v of values) {
            const res = testGlobalString(v, searchFn, regexForGlobalQuerySearch, mode, exactPhrase);
            if (res.hit) localCount += res.count;
          }
        }
        if (localCount > 0) {
          gqHit = true;
          gqBreakdown.frontmatter = (gqBreakdown.frontmatter ?? 0) + localCount;
          if (mode === "regex") regexMatchTotal += localCount;
        }
      }
    }

    // tags
    if (parsed.globalQuery && globalQueryTargets.tags) {
      const set = getTagsForFile(app, file);
      let localCount = 0;
      for (const tg of set) {
        const res = testGlobalString(tg, searchFn, regexForGlobalQuerySearch, mode, exactPhrase);
        if (res.hit) localCount += res.count;
      }
      if (localCount > 0) {
        gqHit = true;
        gqBreakdown.tags = (gqBreakdown.tags ?? 0) + localCount;
        if (mode === "regex") regexMatchTotal += localCount;
      }
    }

    // headings (use heading text; excerpts merged separately)
    if (parsed.globalQuery && globalQueryTargets.headings) {
      const headings = (cache?.headings ?? []) as any[];
      let localCount = 0;
      for (const h of headings) {
        const headingText: string = String(h?.heading ?? "");
        if (!headingText) continue;
        const res = testGlobalString(headingText, searchFn, regexForGlobalQuerySearch, mode, exactPhrase);
        if (res.hit) localCount += res.count;
      }
      if (localCount > 0) {
        gqHit = true;
        gqBreakdown.headings = (gqBreakdown.headings ?? 0) + localCount;
        if (mode === "regex") regexMatchTotal += localCount;
      }
    }

    if (!gqHit) continue; // Global Query specified but no target hit

    // Accepted file
    matchedFiles += 1;

    // excerpts: base (line/content/global body), add heading filter excerpts, add synthetic global-target excerpts
    const baseExcerpts = extractHitLines(
      text,
      parsed,
      options,
      searchFn,
      regexForGlobalQuerySearch,
      exactPhrase,
      10
    );

    const headingFilterExcerpts = buildHeadingExcerpts(
      app,
      file,
      text,
      parsed.headingPatterns,
      caseSensitive
    );

    const globalSyntheticExcerpts = buildGlobalSyntheticExcerpts(
      text,
      name,
      path,
      cache,
      globalQueryTargets,
      searchFn,
      regexForGlobalQuerySearch,
      mode,
      exactPhrase
    );

    const mergedExcerpts1 = mergeExcerpts(baseExcerpts, headingFilterExcerpts, 10);
    const mergedExcerpts = mergeExcerpts(mergedExcerpts1, globalSyntheticExcerpts, 10);

    // filter-wise hit stats
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
      const tagSet = getTagsForFile(app, file);
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
    if (parsed.headingPatterns.length > 0) {
      filterHits.headings = parsed.headingPatterns.reduce(
        (acc, pat) => acc + (matchHeading(app, file, pat, caseSensitive) ? 1 : 0),
        0
      );
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

    // Global Query breakdown and total
    if (parsed.globalQuery) {
      filterHits.globalQueryBreakdown = {
        body: gqBreakdown.body ?? 0,
        name: gqBreakdown.name ?? 0,
        path: gqBreakdown.path ?? 0,
        frontmatter: gqBreakdown.frontmatter ?? 0,
        tags: gqBreakdown.tags ?? 0,
        headings: gqBreakdown.headings ?? 0,
      };
      filterHits.globalQuery = Object.values(filterHits.globalQueryBreakdown).reduce((a, b) => a + (b ?? 0), 0);
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
        globalQuery: !!parsed.globalQuery,
        contentPatterns: parsed.contentPatterns.length ? [...parsed.contentPatterns] : undefined,
        headingPatterns: parsed.headingPatterns.length ? [...parsed.headingPatterns] : undefined,
        lineTerms: uiState.lineTerms.length ? [...uiState.lineTerms] : undefined,
        exactPhrase: mode === "exact" && parsed.globalQuery ? parsed.globalQuery : undefined,
      },
      line: lineDetail,
      searchResult: (mode === "simple" || mode === "fuzzy") && parsed.globalQuery && globalQueryTargets.body && searchFn ? searchFn(text) : undefined,
      regexMatchCount: (mode === "regex" && parsed.globalQuery) ? regexMatchTotal : undefined,
      excerpts: mergedExcerpts,
      filterHits,
    };

    matches.push(logEntry);
    if (matches.length >= maxResults) break;
  }

  const t1 = performance.now();

  return {
    matches,
    summary: {
      matchedFiles,
      totalLineHits,
      timeMs: Math.round(t1 - t0),
    },
  };
}