統合結論

- 最有力候補: Tabulator（MIT/完全無料、Vite 対応）。同一カラム内で「否定（NOT）」と「肯定（含む）」を混在させ、AND/OR の切り替えも含めて直感的 UI または少ないコードで実装可能。複数ソート、列の D&D/リサイズ/表示切替、基本文字列フィルタ、仮想スクロールも無料で網羅。
- 次点: TanStack Table v8（MIT/無料・ヘッドレス）。filterFn で同等ロジックは容易だが、チェックボックス UI や列 D&D などの完成 UI は自作が必要。
- 参考: AG Grid Community は強力だが、UI での複合テキスト条件は基本 2 条件まで。3 件以上やリッチな無料 UI（列ツールパネル等）は自作が増えやすく、要件達成までの工数が相対的に高い。

1. ユーザ要件（確定版）

- コスト/ライセンス: 完全無料（MIT 等）、商用可
- 開発環境: Vite でスムーズに動作（ESM 対応）
- 最重要: 同一カラムに対して「NOT と含む」を混在させ、AND/OR を柔軟に切り替えて適用できること
  例: NOT bob、NOT alice、Mary、good → bob/alice は含まない かつ Mary/good は含む
- 強く望む機能
  - 複数カラムソート
  - 列のドラッグ入れ替え、幅リサイズ、表示/非表示の UI
  - 基本文字列フィルタ（Contains/Starts/Ends）
  - （任意）Fuzzy 検索
- 備考: グループ化は必須ではない（あれば尚可）

2. Tabulator での実装方針

- ねらい: 1 列のヘッダーに「含む語（Include）」と「除外語（Exclude）」の入力欄＋ AND/OR トグルを用意。判定関数で包括・除外の論理を評価。
- UI 構成（headerFilter でカスタム UI）
  - 含む語（カンマ区切り）
  - 除外語（カンマ区切り）
  - Include 結合モード: AND/OR
  - Exclude 結合モード: ANY（いずれか含めば除外）/ALL（全て含めば除外）
  - Apply/Reset ボタン（ライブフィルタは無効化）
- 判定ロジック（headerFilterFunc）
  - includeResult = includes が空なら true。AND なら every、OR なら some
  - excludeHit = excludes が空なら false。ANY なら some、ALL なら every
  - 表示可否 = includeResult && !excludeHit
- そのほか実装オプション
  - 列 D&D: movableColumns: true
  - 列リサイズ: resizableColumns: true
  - 列表示/非表示: headerMenu でトグル
  - 複数ソート: columnHeaderSortMulti: true
  - Fuzzy: Fuse.js 等と外部検索ボックスで合成可能
  - 状態保存: table.getFilters()/setFilter() で復元

最小コード例（Vite + Vanilla JS の要点のみ）
import 'tabulator-tables/dist/css/tabulator.min.css';
import { TabulatorFull as Tabulator } from 'tabulator-tables';

const data = [
{ id: '1', text: 'PROJECT UPDATE', personEmail: 'matt@example.com' },
{ id: '2', text: 'Hello from Bob', personEmail: 'bob@example.com' },
{ id: '3', text: 'Good news from Mary', personEmail: 'mary.good@example.com' },
{ id: '4', text: 'Alice says good', personEmail: 'alice@example.com' },
];

const tokenize = s => String(s || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

function includeExcludeFilter(headerValue, cellValue) {
const v = String(cellValue ?? '').toLowerCase();
const hv = headerValue || {};
const includes = Array.isArray(hv.includes) ? hv.includes : tokenize(hv.includes);
const excludes = Array.isArray(hv.excludes) ? hv.excludes : tokenize(hv.excludes);
const includeOp = hv.includeOp === 'OR' ? 'OR' : 'AND';
const excludeOp = hv.excludeOp === 'ALL' ? 'ALL' : 'ANY';

const includeResult =
includes.length === 0
? true
: includeOp === 'AND'
? includes.every(t => v.includes(t))
: includes.some(t => v.includes(t));

const excludeHit =
excludes.length === 0
? false
: excludeOp === 'ANY'
? excludes.some(t => v.includes(t))
: excludes.every(t => v.includes(t));

return includeResult && !excludeHit;
}

function includeExcludeHeaderFilter(cell, onRendered, success) {
const el = document.createElement('div'); el.style.padding = '6px'; el.style.minWidth = '240px';
const inc = document.createElement('input'); inc.placeholder = '含む語: Mary, good'; inc.style.width = '100%';
const exc = document.createElement('input'); exc.placeholder = '除外語: bob, alice'; exc.style.width = '100%'; exc.style.marginTop = '6px';
const includeMode = document.createElement('select'); includeMode.innerHTML = '<option value="AND">AND</option><option value="OR">OR</option>'; includeMode.style.marginTop = '6px'; includeMode.style.width = '49%';
const excludeMode = document.createElement('select'); excludeMode.innerHTML = '<option value="ANY">ANY</option><option value="ALL">ALL</option>'; excludeMode.style.marginTop = '6px'; excludeMode.style.marginLeft = '2%'; excludeMode.style.width = '49%';

const row2 = document.createElement('div'); row2.style.display = 'flex'; row2.appendChild(includeMode); row2.appendChild(excludeMode);
const apply = document.createElement('button'); apply.textContent = 'Apply'; apply.style.marginTop = '6px';
apply.onclick = () => success({ includes: tokenize(inc.value), excludes: tokenize(exc.value), includeOp: includeMode.value, excludeOp: excludeMode.value });
const reset = document.createElement('button'); reset.textContent = 'Reset'; reset.style.margin = '6px 0 0 6px';
reset.onclick = () => { inc.value=''; exc.value=''; includeMode.value='AND'; excludeMode.value='ANY'; success({ includes: [], excludes: [], includeOp: 'AND', excludeOp: 'ANY' }); };

el.appendChild(inc); el.appendChild(exc); el.appendChild(row2); el.appendChild(apply); el.appendChild(reset);
onRendered(() => inc.focus());
return el;
}

new Tabulator('#grid', {
data,
layout: 'fitColumns',
columnHeaderSortMulti: true,
movableColumns: true,
resizableColumns: true,
columns: [
{ title: 'Text', field: 'text', headerFilter: 'input' },
{ title: 'Email', field: 'personEmail', headerFilter: includeExcludeHeaderFilter, headerFilterFunc: includeExcludeFilter, headerFilterLiveFilter: false },
],
});

使い方例

- Email 列のフィルタで「含む語: Mary, good」「除外語: bob, alice」「Include: AND」「Exclude: ANY」を指定 → 「bob/alice を含まず、かつ Mary と good を含む」行のみ表示。Include を OR にすれば「Mary または good を含む」に切替。

3. 他ライブラリを除外した理由

- AG Grid Community
  - 長所: 高性能・機能豊富。Text/Set Filter は Community でも使用可。プログラム的な filterModel で複雑条件は表現可能。
  - 向かない点: 標準の Text Filter UI は基本 2 条件まで。3 件以上の混在条件や、チェックボックス主体のリッチな無料 UI は自作（カスタムフィルターコンポーネント）が前提。列ツールパネル/フィルターパネル等は Enterprise。無料で直感的 UI まで含めて要件充足するには実装工数が増えやすい。
- TanStack Table v8
  - 長所: MIT/無料・型安全・柔軟。filterFn で任意の論理（NOT/含む/AND/OR）を容易に実装可能。
  - 向かない点: ヘッドレスのため、ヘッダーフィルタ UI、チェックボックスリスト、列 D&D など完成 UI は自作。仮想スクロールも別ライブラリ（@tanstack/react-virtual）が必要。工数が増える。
- Handsontable
  - 商用で完全無料ではない（ライセンスが商用無料要件に不適合）。
- DataTables（jQuery）
  - jQuery 依存でモダンな Vite/ESM 指向に不向き。複雑フィルタや列 D&D は拡張や自作が必要になりがち。
- Grid.js
  - 軽量だがグリッド機能が限定的。高度な複合フィルタや列操作 UI を自前で補う必要が大きい。

この方針により、完全無料・Vite 対応を前提に、最重要の「NOT と含むの混在＋ AND/OR 切替」を最小の実装コストで達成できます。
