# 検索結果をリッチな表示にするようなプラグイン開発を検討しています。利用できそうなAPIを教えて

検索結果をリッチに表示するプラグインを開発する場合、以下のAPIが利用できます。<cite />

## サジェスト系API

### 1. SuggestModal<T>
モーダルダイアログで検索結果を表示する基本的なAPIです。 [1](#0-0) 

- `getSuggestions(query: string)`: 検索クエリに基づいて候補を生成 [2](#0-1) 
- `renderSuggestion(value: T, el: HTMLElement)`: 各候補のHTML表示をカスタマイズ [3](#0-2) 
- `onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent)`: 候補選択時の処理 [4](#0-3) 
- `limit`: 表示する候補数の制限 [5](#0-4) 
- `emptyStateText`: 結果がない場合のテキスト [6](#0-5) 

### 2. FuzzySuggestModal<T>
ファジー検索機能を持つモーダルです。 [7](#0-6) 

- `getItems()`: 検索対象のアイテムリストを返す [8](#0-7) 
- `getItemText(item: T)`: アイテムから検索用テキストを抽出 [9](#0-8) 
- `renderSuggestion(item: FuzzyMatch<T>, el: HTMLElement)`: マッチ結果を表示 [10](#0-9) 

### 3. EditorSuggest<T>
エディタ内でリアルタイムにサジェストを表示するAPIです。 [11](#0-10) 

- `onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null)`: サジェストを表示するタイミングを判定 [12](#0-11) 
- `getSuggestions(context: EditorSuggestContext)`: 候補を生成 [13](#0-12) 
- `setInstructions(instructions: Instruction[])`: 操作説明を設定 [14](#0-13) 

### 4. AbstractInputSuggest<T>
入力フィールドに対してサジェストを追加するAPIです。 [15](#0-14) 

## 検索結果の表示機能

### renderMatches()
検索マッチ箇所をハイライト表示します。 [16](#0-15) 

### renderResults()
検索結果を整形して表示します。 [17](#0-16) 

## カスタムビュー

### BasesView (v1.10.0以降)
プロパティクエリの結果をカスタム表示できます。 [18](#0-17) 

`registerBasesView(viewId: string, registration: BasesViewRegistration)`でカスタムビューを登録できます。 [19](#0-18) 

## Markdownポストプロセッサ

検索結果をMarkdownとして表示する場合に有用です。 [20](#0-19) 

- `registerMarkdownPostProcessor()`: レンダリング後のDOMを変更 [21](#0-20) 
- `registerMarkdownCodeBlockProcessor()`: コードブロックをカスタム表示 [22](#0-21) 

## 補助機能

- `setIcon(parent: HTMLElement, iconId: IconName)`: アイコンを挿入 [23](#0-22) 
- `renderMath(source: string, display: boolean)`: LaTeX数式をレンダリング [24](#0-23) 
- `htmlToMarkdown()`: HTMLをMarkdownに変換 [25](#0-24) 

## Notes

プラグインの登録は`Plugin`クラスを継承して行います。 [26](#0-25) 検索結果の表示方法によって、モーダル表示なら`SuggestModal`、エディタ内表示なら`EditorSuggest`、カスタムビューなら`BasesView`を選択してください。<cite />

Wiki pages you might want to explore:
- [Obsidian API Overview (obsidianmd/obsidian-api)](/wiki/obsidianmd/obsidian-api#1)

### Citations

**File:** obsidian.d.ts (L294-294)
```typescript
export abstract class AbstractInputSuggest<T> extends PopoverSuggest<T> {
```

**File:** obsidian.d.ts (L821-843)
```typescript
export interface BasesViewRegistration {
    /**
     * @public
     * @since 1.10.0
     */
    name: string;
    /**
     * Icon ID to be used in the Bases view selector.
     * See {@link https://docs.obsidian.md/Plugins/User+interface/Icons} for available icons and how to add your own.
     * @public
     * @since 1.10.0
     */
    icon: IconName;
    /**
     * @public
     * @since 1.10.0
     */
    factory: BasesViewFactory;
    /**
     * @public
     * @since 1.10.0
     */
    options?: () => ViewOption[];
```

**File:** obsidian.d.ts (L2090-2090)
```typescript
export abstract class EditorSuggest<T> extends PopoverSuggest<T> {
```

**File:** obsidian.d.ts (L2113-2113)
```typescript
    setInstructions(instructions: Instruction[]): void;
```

**File:** obsidian.d.ts (L2125-2125)
```typescript
    abstract onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null;
```

**File:** obsidian.d.ts (L2132-2132)
```typescript
    abstract getSuggestions(context: EditorSuggestContext): T[] | Promise<T[]>;
```

**File:** obsidian.d.ts (L2687-2687)
```typescript
export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
```

**File:** obsidian.d.ts (L2698-2698)
```typescript
    renderSuggestion(item: FuzzyMatch<T>, el: HTMLElement): void;
```

**File:** obsidian.d.ts (L2708-2708)
```typescript
    abstract getItems(): T[];
```

**File:** obsidian.d.ts (L2713-2713)
```typescript
    abstract getItemText(item: T): string;
```

**File:** obsidian.d.ts (L2929-2929)
```typescript
export function htmlToMarkdown(html: string | HTMLElement | Document | DocumentFragment): string;
```

**File:** obsidian.d.ts (L3386-3397)
```typescript
export interface MarkdownPostProcessor {
    /**
     * The processor function itself.
     * @public
     */
    (el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<any> | void;
    /**
     * An optional integer sort order. Defaults to 0. Lower number runs before higher numbers.
     * @public
     */
    sortOrder?: number;
}
```

**File:** obsidian.d.ts (L4310-4310)
```typescript
export abstract class Plugin extends Component {
```

**File:** obsidian.d.ts (L4394-4394)
```typescript
    registerMarkdownPostProcessor(postProcessor: MarkdownPostProcessor, sortOrder?: number): MarkdownPostProcessor;
```

**File:** obsidian.d.ts (L4403-4403)
```typescript
    registerMarkdownCodeBlockProcessor(language: string, handler: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<any> | void, sortOrder?: number): MarkdownPostProcessor;
```

**File:** obsidian.d.ts (L4411-4411)
```typescript
    registerBasesView(viewId: string, registration: BasesViewRegistration): boolean;
```

**File:** obsidian.d.ts (L4815-4815)
```typescript
export function renderMatches(el: HTMLElement | DocumentFragment, text: string, matches: SearchMatches | null, offset?: number): void;
```

**File:** obsidian.d.ts (L4822-4822)
```typescript
export function renderMath(source: string, display: boolean): HTMLElement;
```

**File:** obsidian.d.ts (L4827-4827)
```typescript
export function renderResults(el: HTMLElement, text: string, result: SearchResult, offset?: number): void;
```

**File:** obsidian.d.ts (L5032-5032)
```typescript
export function setIcon(parent: HTMLElement, iconId: IconName): void;
```

**File:** obsidian.d.ts (L5397-5397)
```typescript
export abstract class SuggestModal<T> extends Modal implements ISuggestOwner<T> {
```

**File:** obsidian.d.ts (L5402-5402)
```typescript
    limit: number;
```

**File:** obsidian.d.ts (L5407-5407)
```typescript
    emptyStateText: string;
```

**File:** obsidian.d.ts (L5455-5455)
```typescript
    abstract getSuggestions(query: string): T[] | Promise<T[]>;
```

**File:** obsidian.d.ts (L5460-5460)
```typescript
    abstract renderSuggestion(value: T, el: HTMLElement): void;
```

**File:** obsidian.d.ts (L5465-5465)
```typescript
    abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;
```

# ネイティブ検索の機能はどう実現すれば良い？

Obsidianのネイティブ検索機能は、プラグインAPIでは直接公開されていません。<cite />そのため、これらの機能を実装するには、自分で検索ロジックを構築する必要があります。<cite />

## 実装可能な機能と方法

### 基本検索機能

**単語検索・フレーズ検索**には、`prepareFuzzySearch()`または`prepareSimpleSearch()`を使用できます。 [1](#1-0) 

```typescript
// ファジー検索
const fuzzySearch = prepareFuzzySearch(query);
const result = fuzzySearch(text);

// シンプル検索（スペース区切りの単語）
const simpleSearch = prepareSimpleSearch(query);
const result = simpleSearch(text);
```

**OR演算子、除外、グループ化**は、自分でクエリパーサーを実装する必要があります。<cite />

### 検索演算子の実装

**file:、path:、content:**は、`Vault`と`MetadataCache`を組み合わせて実装できます。<cite />

- `app.vault.getMarkdownFiles()`でファイル一覧を取得<cite />
- `file.path`や`file.name`でファイル名・パス検索<cite />
- `app.vault.cachedRead(file)`でファイル内容を取得して検索<cite />

**tag:**は、`MetadataCache`を使用します。<cite />

```typescript
const cache = app.metadataCache.getFileCache(file);
if (cache?.tags) {
    // cache.tags配列からタグを検索
}
```

**line:、block:、section:**は、`CachedMetadata`の構造を利用します。 [2](#1-1) 

- `cache.sections`でセクション情報を取得 [2](#1-1) 
- `cache.blocks`でブロック情報を取得 [3](#1-2) 
- ファイル内容と位置情報を組み合わせて検索<cite />

**task:、task-todo:、task-done:**は、`cache.listItems`を使用します。<cite />

```typescript
const cache = app.metadataCache.getFileCache(file);
if (cache?.listItems) {
    cache.listItems.forEach(item => {
        if (item.task) {
            // item.task === ' ' なら未完了
            // item.task === 'x' なら完了
        }
    });
}
```

### プロパティ検索

**[プロパティ名]、[プロパティ名:値]**は、`cache.frontmatter`を使用します。<cite />

```typescript
const cache = app.metadataCache.getFileCache(file);
if (cache?.frontmatter) {
    const propertyValue = cache.frontmatter[propertyName];
    // プロパティの存在確認や値の比較
}
```

### 正規表現

JavaScriptの`RegExp`を直接使用できます。<cite />

```typescript
const regex = new RegExp(pattern);
const matches = text.match(regex);
```

### その他機能

**大文字/小文字の区別**は、検索関数に渡す前にクエリを正規化します。<cite />

**検索結果のソート**は、`Stat`インターフェースを使用します。 [4](#1-3) 

```typescript
files.sort((a, b) => {
    return a.stat.mtime - b.stat.mtime; // 更新日時でソート
});
```

**検索結果の表示**には、`renderMatches()`と`renderResults()`を使用します。 [5](#1-4) 

**検索クエリの埋め込み**は、`registerMarkdownCodeBlockProcessor()`で`query`コードブロックを処理します。<cite />

```typescript
this.registerMarkdownCodeBlockProcessor('query', (source, el, ctx) => {
    // sourceに検索クエリが入っている
    // 検索を実行して結果をelに表示
});
```

## Notes

Obsidianのネイティブ検索エンジンは内部実装であり、プラグインAPIでは公開されていません。<cite />上記の方法は、APIを組み合わせて同様の機能を再実装する必要があります。<cite />特に複雑なクエリパーサー（OR、グループ化など）は、自分で実装する必要があります。<cite />

`BasesView`を使用すると、プロパティベースのクエリ結果を表示できますが、これはネイティブ検索とは異なるシステムです。 [6](#1-5) 

Wiki pages you might want to explore:
- [App Interface (obsidianmd/obsidian-api)](/wiki/obsidianmd/obsidian-api#2.1)

### Citations

**File:** obsidian.d.ts (L690-736)
```typescript
export abstract class BasesView extends Component {
    /**
     * The type ID of this view
     * @public
     * @since 1.10.0
     */
    abstract type: string;
    /**
     * @public
     * @since 1.10.0
     */
    app: App;

    /**
     * The config object for this view.
     * @public
     * @since 1.10.0
     */
    config: BasesViewConfig;
    /**
     * All available properties from the dataset.
     * @public
     * @since 1.10.0
     */
    allProperties: BasesPropertyId[];
    /**
     * The most recent output from executing the bases query, applying filters, and evaluating formulas.
     * This object will be replaced with a new result set when changes to the vault or Bases config occur,
     * so views should not keep a reference to it. Also note the contained BasesEntry objects will be recreated.
     * @public
     * @since 1.10.0
     */
    data: BasesQueryResult;

    /**
     * @public
     * @since 1.10.0
     */
    protected constructor(controller: QueryController);
    /**
     * Called when there is new data for the query. This view should rerender with the updated data.
     * @public
     * @since 1.10.0
     */
    abstract onDataUpdated(): void;

}
```

**File:** obsidian.d.ts (L850-853)
```typescript
export interface BlockCache extends CacheItem {
    /** @public */
    id: string;
}
```

**File:** obsidian.d.ts (L4613-4629)
```typescript
/**
 * Construct a fuzzy search callback that runs on a target string.
 * Performance may be an issue if you are running the search for more than a few thousand times.
 * If performance is a problem, consider using `prepareSimpleSearch` instead.
 * @param query - the fuzzy query.
 * @return fn - the callback function to apply the search on.
 * @public
 */
export function prepareFuzzySearch(query: string): (text: string) => SearchResult | null;

/**
 * Construct a simple search callback that runs on a target string.
 * @param query - the space-separated words
 * @return fn - the callback function to apply the search on
 * @public
 */
export function prepareSimpleSearch(query: string): (text: string) => SearchResult | null;
```

**File:** obsidian.d.ts (L4815-4827)
```typescript
export function renderMatches(el: HTMLElement | DocumentFragment, text: string, matches: SearchMatches | null, offset?: number): void;

/**
 * Render some LaTeX math using the MathJax engine. Returns an HTMLElement.
 * Requires calling `finishRenderMath` when rendering is all done to flush the MathJax stylesheet.
 * @public
 */
export function renderMath(source: string, display: boolean): HTMLElement;

/**
 * @public
 */
export function renderResults(el: HTMLElement, text: string, result: SearchResult, offset?: number): void;
```

**File:** obsidian.d.ts (L5011-5023)
```typescript
export interface SectionCache extends CacheItem {
    /**
     * The block ID of this section, if defined.
     * @public
     */
    id?: string | undefined;
    /**
     * The type string generated by the parser.
     * Typing is non-exhaustive, more types can be available than are documented here.
     * @public
     */
    type: 'blockquote' | 'callout' | 'code' | 'element' | 'footnoteDefinition' | 'heading' | 'html' | 'list' | 'paragraph' | 'table' | 'text' | 'thematicBreak' | 'yaml' | string;
}
```

**File:** obsidian.d.ts (L5330-5348)
```typescript
export interface Stat {
    /** @public */
    type: 'file' | 'folder';
    /**
     * Time of creation, represented as a unix timestamp.
     * @public
     * */
    ctime: number;
    /**
     * Time of last modification, represented as a unix timestamp.
     * @public
     */
    mtime: number;
    /**
     * Size on disk, as bytes.
     * @public
     */
    size: number;
}
```
