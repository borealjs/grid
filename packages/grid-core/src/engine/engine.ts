// The grid engine: draws a model into a host element and loads what is on screen.
//
// - One native scroll container. Its content box is sized to the virtual table (capped at
//   MAX_SCROLL_PX); a sticky viewport inside it holds everything that is drawn.
// - Body rows and cells live in fixed pools recycled as a ring buffer (slot = index % poolSize), so a
//   scroll step only rewrites rows/columns that entered the window. Rows may have different heights.
// - Row and column headers are span layers: keyed segments that can cover many items and several
//   header bands (multi-level pivot headers, subtotal labels). Their labels stay in view while the span scrolls.
// - Positions are relative to a rebasing anchor, so CSS pixel values stay small at any index.
// - Above MAX_SCROLL_PX the scrollbar maps proportionally (dragging is coarse), while wheel and
//   keyboard input move by exact pixel deltas in virtual space.
// - Cells and labels arrive in blocks through a prioritized, deduplicated, abortable LRU cache.
//
// What is drawn comes from a model (see model/types.ts): a table (model/table.ts) or a pivot (model/pivot.ts).
// This is the low-level layer under the public Grid (grid.ts); its API may change in any release.

import type { Axis } from '../axes/axis.js';
import { defaultFormat } from '../format.js';
import { DEFAULT_MESSAGES } from '../messages.js';
import {
  EMPTY_QUERY, columnFilterToPublic, describeCondition, filterKeyFields, filterParamOf, filterToPublic, parseViewKeyId, sameFilterKey,
  sameSortKey, sortParamOf, sortToPublic, viewKeyId, type Condition, type SortDir, type SortSpec, type ViewKey,
} from '../query.js';
import type {
  CellClassResult, CellContext, CellEvent, CellPosition, ColumnDef, ColumnDescription, ColumnFilterItem, ColumnResizeInfo, ControlledParts, CopyInfo, EmptyContext,
  ErrorContext, FilterItem, FilterTarget, GridStats, HeaderContext, Messages, Progress, Query, Renderer, RowId, RowSelection, Selection, SelectionInfo,
  SelectionMode, SelectionRange, SortItem, SortTarget, Theme, ViewChangeInfo, ViewWork,
} from '../types.js';
import type { Grid } from '../grid.js';
import { alignDown, alignUp, clamp, errorMessage, prefixSums, trimOldest } from '../util.js';
import type { AxisName, ColumnInfo, GridModel, Segment } from '../model/types.js';
import { BlockCache, type WishItem } from './block-cache.js';
import {
  LABEL_BLOCK, blockKey, cellKey, classifyRuns, colStripKey, labelKey, lookupCell, parseLabelKey, rowStripKey,
  type CellBlock, type LabelBlock, type Rect,
} from './blocks.js';
import {
  COPY_CACHE_MAX, MAX_COPY_CELLS, batchRects, buildCopy, coalesceRects, forEachNeededCell, planCopy, writeClipboardNow, type CopyPlan,
} from './clipboard.js';
import { closest, div, isEditable, isInteractive, makeFilterButton, makeSortButton, paintAriaSort, paintFilterButton, paintSortButton, type SortState } from './dom.js';
import { FilterDialog, type BareCondition } from './filter-dialog.js';
import { MergeLayer } from './merge-layer.js';
import { MergeIndex, mergePieces, type MergePiece } from './merges.js';
import { Notices } from './notices.js';
import { SelectionLayer, type SelectionBox } from './selection-layer.js';
import { cellCount, cellRange, inRanges, isActiveOnly, pieceAt, rangeOf, type SelectionState } from './selection.js';
import { SpanLayer } from './span-layer.js';

export { LABEL_BLOCK };

const MAX_SCROLL_PX = 10_000_000; // below every browser's max element size (Firefox ~17.8M, Chrome ~33.5M)
const REBASE_PX = 200_000;
const JUMP_FETCH_DELAY_MS = 70;
const RETRY_DELAY_MS = 1000;
/** A sort or filter running longer than this shows what it is doing, with a Cancel button. */
const WORK_NOTICE_DELAY_MS = 400;
/** Shortest run of consecutive source items that is worth a whole block (shorter runs use strips). */
const RUN_MIN_ROWS = 8;
const RUN_MIN_COLS = 4;
/** The fetch window is widened to multiples of these, so requests go out per chunk crossed, not per step. */
const CHUNK_ROWS = 32;
const CHUNK_COLS = 16;
/** Sort orders / filters whose caches are kept (switching back to one is instant). */
const MAX_VIEWS = 4;
const MAX_SORT_KEYS = 4;
/** Copy requests in flight at once. */
const COPY_CONCURRENCY = 3;

// Shortcuts use the platform's primary modifier: ⌘ on Apple platforms, Ctrl elsewhere. (On a Mac,
// Ctrl+click is the context menu and Ctrl+arrows switch desktops, so Ctrl must not double as ⌘.)
const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent || '');

// ------------------------------------------------------------------ options

/** The query as request signatures plus the public query, sent with every data request. */
export interface FetchContext {
  query: Query;
  sort: string;
  filter: string;
  colfilter: string;
  signal?: AbortSignal;
}

/** Cells of one rect, row-major (optionally with merged cells, source coordinates). */
export type BlockPayload = unknown[] | { cells: unknown[]; merges?: unknown[] };
/** Cells of several rects, one row-major array each. */
export type GatherPayload = unknown[][] | { cells: unknown[][]; merges?: unknown[] };

type Rule<T> = boolean | ((target: T) => boolean | undefined);

export interface EngineOptions {
  model: GridModel;
  fetchBlock(request: FetchContext & { r0: number; c0: number; nr: number; nc: number }): Promise<BlockPayload>;
  /** Several rects per request (strips and single cells of collapsed groups, copies). */
  fetchGather?(request: FetchContext & { rects: Rect[] }): Promise<GatherPayload>;
  fetchLabels(request: FetchContext & { axis: AxisName; level: number; from: number; n: number }): Promise<string[]>;
  /** The query the model was built for. */
  initial?: { sort?: SortSpec[]; filter?: Condition[]; columnFilter?: Condition[] };
  /** The public Grid (given to cell renderers as ctx.grid). */
  api?: Grid;
  theme?: Theme;
  ariaLabel?: string;
  messages?: Partial<Messages>;
  sortable?: Rule<SortTarget>;
  filterable?: Rule<FilterTarget>;
  resizable?: boolean;
  multiSort?: boolean;
  expandable?: boolean;
  selection?: SelectionMode;
  copy?: boolean;
  keyboard?: boolean;
  notices?: boolean;
  minColWidth?: number;
  blockRows?: number;
  blockCols?: number;
  overscanRows?: number;
  overscanCols?: number;
  maxGatherRects?: number;
  maxGatherCells?: number;
  controlled?: ControlledParts;
  isMac?: boolean;
  format?(value: unknown, ctx: CellContext | null): string;
  cellClass?(value: unknown, ctx: CellContext | null): CellClassResult;
  renderCell?: Renderer<CellContext<any>>;
  renderHeader?: Renderer<HeaderContext>;
  renderEmpty?: Renderer<EmptyContext>;
  /** The data record at a row source position (cell renderers' ctx.row). */
  rowAt?(position: number): unknown;
  /** Descriptions of columns from … from + n - 1 (getColumns), for models with describedColumns. */
  fetchColumns?(request: FetchContext & { from: number; n: number }): Promise<ColumnDescription[]>;
  /** Id of the row at a source position, when its record is loaded (getRowId). */
  rowId?(position: number): RowId | undefined;
  /** Source position of a row id under a query: -1 when it is not in that view, null when it cannot be told. */
  findRow?(id: RowId, query: Query): number | null | Promise<number | null>;
  /** Row checkboxes in the row-number column. */
  rowSelection?: boolean;
  selectedRows?: RowSelection;
  /** Whether an event callback is set (the Grid passes stable wrappers for all of them). */
  hasHandler?(name: 'onCellClick' | 'onCellDoubleClick' | 'onCellContextMenu'): boolean;
  /** New column order, compact: source indexes and inclusive [first, last] runs. */
  onColumnOrderChange?(order: (number | [number, number])[]): void;
  onRowSelectionChange?(selection: RowSelection): void;
  onCellClick?(e: CellEvent): void;
  onCellDoubleClick?(e: CellEvent): void;
  onCellContextMenu?(e: CellEvent): void;
  onSortChange?(sort: SortItem[]): void;
  onFilterChange?(filter: FilterItem[]): void;
  onColumnFilterChange?(columnFilter: ColumnFilterItem[]): void;
  onSelectionChange?(info: SelectionInfo): void;
  onCopy?(info: CopyInfo): void;
  onColumnResize?(info: ColumnResizeInfo): void;
  onViewChange?(info: ViewChangeInfo): void;
  onError?(error: unknown, context: ErrorContext): void;
}

const DEFAULTS = {
  blockRows: 100,
  blockCols: 20,
  overscanRows: 6,
  overscanCols: 2,
  minColWidth: 48,
  sortable: true as Rule<SortTarget>,
  filterable: true as Rule<FilterTarget>,
  resizable: true,
  multiSort: true,
  expandable: true,
  selection: 'multi' as SelectionMode,
  copy: true,
  keyboard: true,
  theme: 'auto' as Theme,
};

export type ResolvedEngineOptions = EngineOptions & typeof DEFAULTS;

// ------------------------------------------------------------------ internal state shapes

interface CellSlot {
  el: HTMLDivElement;
  text: Text;
  box: HTMLDivElement | null;
  /** Renderer cleanup; null = renderer returned none (box is emptied); undefined = nothing drawn. */
  cleanup: (() => void) | null | undefined;
  extra: string;
  /** Visible column it shows (-1 = none / repaint). */
  c: number;
  base: string;
  cls: string;
  filled: boolean;
  /** Placeholder (value loading). */
  ph: boolean;
  covered: number;
  selected: boolean | undefined;
}

/**
 * A band of pinned columns drawn at a fixed x: the leading columns on the left, the trailing ones on the
 * right. It has its own cells, merged cells, selection and header, and scrolls only vertically.
 */
interface PinPane {
  right: boolean;
  body: HTMLDivElement;
  layer: HTMLDivElement;
  mergeEl: HTMLDivElement;
  merges: MergeLayer;
  selEl: HTMLDivElement;
  sel: SelectionLayer;
  head: HTMLDivElement;
  headLayer: HTMLDivElement;
  spans: SpanLayer;
  slots: RowSlot[];
  /** Columns in the pane, and the first one's visible index (0 on the left, count - n on the right). */
  count: number;
  first: number;
  /** cols.offsetOf(first): a column's x in the pane is its offset minus this. */
  base: number;
  /** Width, and (right pane) x in the body where the pane starts, as last drawn. */
  w: number;
  x: number;
  sig: string;
  /** The pane's columns' sources and exactness, and its N × count coverage by merged cells. */
  src: Float64Array;
  exact: Uint8Array;
  cover: Uint8Array;
}

interface RowSlot {
  el: HTMLDivElement;
  cells: CellSlot[];
  r: number;
  h: number;
  cls: string;
}

/** The drawn window (with overscan) and the visible part. */
export interface DrawnWindow {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
  firstRow: number;
  lastRow: number;
  firstCol: number;
  lastCol: number;
}

/** One sort order + filter: its own cache, so switching back to it is instant. */
interface DataView {
  sig: string;
  cache: BlockCache;
  /** Values loaded only for copies ("rs:cs" -> value). */
  copyCache: Map<string, unknown>;
}

/** The sort / filter being applied. */
interface Work {
  what: ViewWork;
  ctrl: AbortController;
  started: number;
  progress: Progress | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface CornerControl {
  btn: HTMLElement | null;
  cell: HTMLElement;
  key: ViewKey | null;
  filterBtn: HTMLElement | null;
  fkey: ViewKey | null;
}

type QueryPart = 'sort' | 'filter' | 'columnFilter';
type SelectMode = 'set' | 'add' | 'extend';

/** Selection in source coordinates, so it survives collapse / expand. */
interface SelectionSnapshot {
  active: [number, number];
  anchor: [number, number];
  focus: [number, number];
  ranges: [number, number, number, number][];
}

export interface EngineStats {
  renders: number;
  renderMsEma: number;
  renderMsMax: number;
  rowWrites: number;
  cellWrites: number;
}

/** One step of row checking, with its query's signature (internal). */
type CheckStep = ({ id: RowId; at?: number; atSig?: string } | { from: number; to: number; query: Query }) & { checked: boolean; sig?: string };

const querySig = (q: Query): string => JSON.stringify([q.sort, q.filter]);
const MAX_POSITIONS = 20_000;

const ARROWS: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

// ------------------------------------------------------------------ engine

export class GridEngine {
  readonly o: ResolvedEngineOptions;
  readonly msg: Messages;
  readonly model: GridModel;
  rows: Axis;
  cols: GridModel['cols'];
  /** Data is addressed by source index (position in the fully expanded data), which does not change when groups collapse. */
  readonly rowSource: (r: number) => number;
  readonly colSource: (c: number) => number;
  readonly rowBandOff: Float64Array;
  readonly tierOff: Float64Array;
  readonly rowHeaderWidth: number;
  readonly headerHeight: number;

  // Scroll position (virtual pixels) and the last direction of travel.
  vx = 0;
  vy = 0;
  dirX = 0;
  dirY = 0;
  rendered = { vx: NaN, vy: NaN };
  // Rebasing anchors: drawn elements are positioned relative to these offsets.
  anchorRow: number | null = null;
  anchorRowPx = 0;
  anchorCol: number | null = null;
  anchorColPx = 0;
  rowSlots: RowSlot[] = [];
  /** Pool size: rows × cells drawn. */
  N = 0;
  M = 0;
  readonly stats: EngineStats = { renders: 0, renderMsEma: 0, renderMsMax: 0, rowWrites: 0, cellWrites: 0 };
  readonly isMac: boolean;
  readonly canGather: boolean;
  /** Merged body cells: set from code with setMerges(), or delivered by the data source with the data. */
  readonly merges = new MergeIndex();

  // The query, internal format, highest priority first; each also as its request signature.
  sortSpec: SortSpec[] = [];
  sortParam = '';
  filterSpec: Condition[] = [];
  filterParam = '';
  /** Conditions on column dimensions: a pivot sends them to the data source; a table hides columns itself. */
  colFilterSpec: Condition[] = [];
  colFilterParam = '';
  /** The same query in the public format (what data requests carry). */
  query: Query;
  /** Why the last sort / filter was refused ('' if it was not). */
  lastRefusal = '';
  lastCancelled = false;

  sel: SelectionState;
  cache!: BlockCache;
  colLabels: BlockCache<LabelBlock> | null = null;

  // DOM.
  host!: HTMLElement;
  scroller!: HTMLDivElement;
  content!: HTMLDivElement;
  viewport!: HTMLDivElement;
  body!: HTMLDivElement;
  bodyLayer!: HTMLDivElement;
  mergeLayerEl!: HTMLDivElement;
  mergeLayer!: MergeLayer;
  selLayerEl!: HTMLDivElement;
  selLayer!: SelectionLayer;
  rowHead!: HTMLDivElement;
  rowHeadLayer!: HTMLDivElement;
  colHead!: HTMLDivElement;
  colHeadLayer!: HTMLDivElement;
  /** Pinned columns: the leading ones in the left pane, the trailing ones in the right pane. */
  pinL!: PinPane;
  pinR!: PinPane;
  corner!: HTMLDivElement;
  emptyEl!: HTMLDivElement;
  rowSpans!: SpanLayer;
  colSpans!: SpanLayer;
  emptyCleanup: (() => void) | null = null;

  // Geometry.
  clientW = 0;
  clientH = 0;
  bodyW = 0;
  bodyH = 0;
  maxVX = 0;
  maxVY = 0;
  ratioX = 1;
  ratioY = 1;

  #raf = 0;
  #fetchTimer: ReturnType<typeof setTimeout> | 0 = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #expectTop: number | null = null;
  #expectLeft: number | null = null;
  #lastWantSig = '';
  #lastFirstRow = 0;
  #lastFirstCol = 0;
  #win: DrawnWindow | null = null;
  #labelNeeds = new Set<string>();
  #ro!: ResizeObserver;
  #notices!: Notices;
  // Per-frame scratch arrays (sized with the pools).
  #xs = new Float64Array(0);
  #ws = new Float64Array(0);
  #colSrc = new Float64Array(0);
  #colExact = new Uint8Array(0);
  #rowSrc = new Float64Array(0);
  #rowExact = new Uint8Array(0);
  #cover = new Uint8Array(0);
  /** Window columns with the pinned ones marked not exact, so the body's merged cells start after them. */
  #bodyExact = new Uint8Array(0);
  #kinds: string[] = [];
  #infos: (ColumnInfo | null)[] = [];
  /** Merges whose top-left cell is not loaded yet ("rs:cs"). */
  #mergeAnchors = new Set<string>();
  /** Column descriptions arrived: redraw every cell once they are stored. */
  #describedPending = false;
  /** Source columns the user resized (widths from descriptions do not replace them). */
  #userWidths = new Set<number>();
  /** The active row's id, noted when the selection moved there (so it survives data changes). */
  #activeRow: { r: number; id: RowId } | null = null;
  #followSeq = 0;
  /** Checked rows: steps in order, the last one covering a row decides (see RowSelection). */
  #checks: CheckStep[] = [];
  /** Positions of rows under other queries (for checks made in another sort / filter): sig -> id -> position. */
  #positions = new Map<string, Map<RowId, number | null | 'pending'>>();
  /** A checked row could not be placed in this view (no ids, or the source cannot find rows). */
  #checksUnknown = false;
  #checksNoticeShown = false;
  /** The user (or code) chose a selection; until then a sort does not need to keep it on a row. */
  #userSelected = false;
  /** Why the selection moved by itself, reported once with the next onSelectionChange. */
  #moveReason: SelectionInfo['moved'];
  #lastCheck = -1;
  #cornerCheck: HTMLInputElement | null = null;
  #suppressHeadClick = false;
  #pieces: MergePiece[] = [];
  /** View signature -> its caches (LRU). */
  #views = new Map<string, DataView>();
  /** Server column filter -> cache of column labels (shared by every sort / filter). */
  #colLabelCaches = new Map<string, BlockCache<LabelBlock>>();
  #view: DataView | null = null;
  #sortSeq = 0;
  #filter: FilterDialog | null = null;
  #work: Work | null = null;
  #emptyShown = false;
  #emptySig = '';
  #cornerSort: CornerControl[] = [];
  #idSeq = 0;
  #uid = `vg${Math.random().toString(36).slice(2, 8)}`;
  #activeId = '';
  #defaultInfo: ColumnInfo | null = null;

  constructor(host: HTMLElement, options: EngineOptions) {
    const o = (this.o = { ...DEFAULTS, ...options } as ResolvedEngineOptions);
    if (!o.model || typeof o.fetchBlock !== 'function' || typeof o.fetchLabels !== 'function') {
      throw new TypeError('GridEngine needs a model plus fetchBlock and fetchLabels functions');
    }
    this.msg = { ...DEFAULT_MESSAGES, ...o.messages };
    const model = (this.model = o.model);
    // Described columns: the model reads what is loaded; titles and descriptions come in the same blocks.
    if (model.describedColumns) {
      model.describe = (src) => {
        const b = this.colLabels?.get(labelKey('cols', 0, src)) as (LabelBlock & { metas?: ColumnDescription[] }) | undefined;
        return b?.metas?.[src - b.from] ?? (b ? {} : undefined);
      };
    }
    this.rows = model.rows;
    this.cols = model.cols;
    this.rowSource = model.rowSource ?? ((r) => r);
    this.colSource = model.colSource ?? ((c) => c);
    this.rowBandOff = prefixSums(model.rowBands.map((b) => b.width));
    this.tierOff = prefixSums(model.colTiers.map((t) => t.height));
    this.rowHeaderWidth = this.rowBandOff[this.rowBandOff.length - 1];
    this.headerHeight = this.tierOff[this.tierOff.length - 1];
    this.isMac = o.isMac ?? IS_MAC;
    this.canGather = typeof o.fetchGather === 'function';
    // Initial view (already reflected in the model by whoever built it).
    if (o.initial) {
      this.sortSpec = o.initial.sort ?? [];
      this.filterSpec = o.initial.filter ?? [];
      this.colFilterSpec = o.initial.columnFilter ?? [];
      this.sortParam = sortParamOf(this.sortSpec);
      this.filterParam = filterParamOf(this.filterSpec);
      this.colFilterParam = filterParamOf(this.colFilterSpec);
    }
    this.query = this.#publicQuery();
    // Column header labels do not depend on how rows are sorted or filtered, so they live in a cache shared
    // by all row views (row labels can: pivot groups are reordered, so they stay per view). A server-side
    // column filter does change them, so there is one such cache per column filter.
    this.#useColLabels();
    this.#useView();

    const origin = { r: 0, c: 0 };
    this.sel = { active: origin, anchor: origin, focus: origin, ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }] };

    this.#buildDom(host);
    this.#ro = new ResizeObserver(() => this.#measure());
    this.#ro.observe(this.scroller);
    this.#measure();
  }

  // ---------------------------------------------------------------- scrolling and layout

  /** Scroll so that the given virtual pixel offsets are at the top-left of the body. */
  scrollToVirtual(x: number, y: number): void {
    this.vx = clamp(x, 0, this.maxVX);
    this.vy = clamp(y, 0, this.maxVY);
    const sl = this.vx / this.ratioX;
    const st = this.vy / this.ratioY;
    this.#expectLeft = sl;
    this.#expectTop = st;
    if (Math.abs(this.scroller.scrollLeft - sl) >= 0.5) this.scroller.scrollLeft = sl;
    if (Math.abs(this.scroller.scrollTop - st) >= 0.5) this.scroller.scrollTop = st;
    this.#render();
  }

  scrollToCell(row: number, col: number): void {
    const r = clamp(Math.floor(row), 0, Math.max(0, this.rows.count - 1));
    const c = clamp(Math.floor(col), 0, Math.max(0, this.cols.count - 1));
    this.scrollToVirtual(this.cols.offsetOf(c), this.rows.offsetOf(r));
  }

  setColumnWidth(col: number, width: number): void {
    if (typeof this.cols.setSize !== 'function') return;
    this.#userWidths.add(this.colSource(col));
    const w = Math.max(this.o.minColWidth, Math.round(width));
    if (w === this.cols.sizeOf(col)) return;
    this.cols.setSize(col, w);
    this.#updateContentSize();
    this.#ensurePools();
    this.anchorCol = null; // reposition every cell
    this.rendered.vx = NaN;
    this.scrollToVirtual(this.vx, this.vy);
  }

  /**
   * Replace the merges set from code. Each is { r0, c0, nr, nc, label? } (or [r0, c0, nr, nc, label?])
   * in source coordinates (for a flat table: row/column indexes). Shows the top-left cell's value
   * unless `label` is given. Code merges win over server merges where they overlap.
   */
  setMerges(list: readonly unknown[] | null | undefined): void {
    this.merges.setCode(list);
    this.invalidate();
  }

  /**
   * Expand or collapse one group. The group's header stays where it is on screen; if the viewport
   * started inside the group, the group's first item lands at the top.
   */
  toggleGroup(axis: AxisName, level: number, group: number): void {
    const { model } = this;
    if (typeof model.toggleGroup !== 'function' || typeof model.groupStart !== 'function') return;
    const isRows = axis === 'rows';
    const ax = () => (isRows ? this.rows : this.cols);
    const start = model.groupStart(axis, level, group);
    if (start < 0) return;
    const keep = (isRows ? this.vy : this.vx) - ax().offsetOf(start);
    const snap = this.#captureSelection();
    model.toggleGroup(axis, level, group);
    this.#structureChanged();
    this.#restoreSelection(snap);
    const target = ax().offsetOf(model.groupStart(axis, level, group)) + Math.min(keep, 0);
    if (isRows) this.scrollToVirtual(this.vx, target);
    else this.scrollToVirtual(target, this.vy);
  }

  /**
   * Run a structural change on one axis (for example "show rows down to Country") and keep the item at
   * the top-left of the viewport in place; if it got folded into a collapsed group, show that group.
   */
  restructure(axis: AxisName, mutate: () => void): void {
    const isRows = axis === 'rows';
    const ax = () => (isRows ? this.rows : this.cols);
    const first = this.#win ? (isRows ? this.#win.firstRow : this.#win.firstCol) : 0;
    const src = this.model.anchorOf ? this.model.anchorOf(axis, first) : (isRows ? this.rowSource : this.colSource)(first);
    const within = (isRows ? this.vy : this.vx) - ax().offsetOf(first);
    const snap = this.#captureSelection();
    mutate();
    this.#structureChanged();
    this.#restoreSelection(snap);
    const [idx, exact] = this.model.visibleOf ? this.model.visibleOf(axis, src) : [src, true];
    const target = ax().offsetOf(idx) + (exact ? within : 0);
    if (isRows) this.scrollToVirtual(this.vx, target);
    else this.scrollToVirtual(target, this.vy);
  }

  // ---------------------------------------------------------------- query and events

  #keyOf = (col: number) => this.model.keyOf?.(col);

  #publicQuery(sortList = this.sortSpec, filterList = this.filterSpec, colFilterList = this.colFilterSpec): Query {
    return {
      sort: sortToPublic(sortList, this.#keyOf),
      filter: filterToPublic(filterList, this.#keyOf),
      columnFilter: columnFilterToPublic(colFilterList),
    };
  }

  /** Sort / filter / column filter in the public format. */
  getQuery(): Query {
    return this.#publicQuery();
  }

  #emit(kind: QueryPart, list: SortSpec[] | Condition[]): void {
    if (kind === 'sort') this.o.onSortChange?.(sortToPublic(list as SortSpec[], this.#keyOf));
    else if (kind === 'filter') this.o.onFilterChange?.(filterToPublic(list as Condition[], this.#keyOf));
    else this.o.onColumnFilterChange?.(columnFilterToPublic(list as Condition[]));
  }

  /**
   * A change the user asked for (header click, filter dialog, shortcut). Controlled state only reports
   * it (the owner applies it with setSort / setFilter / setColumnDimFilter); otherwise it is applied
   * and reported once it worked.
   */
  #userChange(kind: QueryPart, list: SortSpec[] | Condition[]): Promise<boolean> {
    if (this.o.controlled?.[kind]) {
      this.#emit(kind, list);
      return Promise.resolve(false);
    }
    const run = kind === 'sort' ? this.setSort(list as SortSpec[]) : kind === 'filter' ? this.setFilter(list as Condition[]) : this.setColumnDimFilter(list as Condition[]);
    return run.then((ok) => {
      if (ok) this.#emit(kind, kind === 'sort' ? this.sortSpec : kind === 'filter' ? this.filterSpec : this.colFilterSpec);
      return ok;
    });
  }

  /**
   * Drop every cached cell and label and load what is on screen again (the data changed). `snap` is the
   * active row from rowSnapshot(), taken before the data source dropped its own cache.
   */
  async refresh(snap: { id: RowId; c: number } | null = this.rowSnapshot()): Promise<void> {
    for (const v of this.#views.values()) v.cache.abortAll();
    for (const c of this.#colLabelCaches.values()) c.abortAll();
    this.#views.clear();
    this.#colLabelCaches.clear();
    this.#view = null;
    if (this.model.reload) {
      try {
        await this.model.reload({ query: this.query, sort: this.sortParam, filter: this.filterParam, colfilter: this.#serverColFilter });
      } catch (err) {
        this.o.onError?.(err, { kind: 'layout' });
      }
      this.rows = this.model.rows;
      this.cols = this.model.cols;
    }
    this.colLabels = null;
    this.#useColLabels();
    this.#useView();
    this.#positions.clear(); // the data changed: positions found earlier may be stale
    this.#structureChanged();
    this.#followRow(snap, true);
    this.repaint();
  }

  /** Redraw every cell and header (after format / render functions changed). The data stays. */
  repaint(): void {
    for (const slot of this.#allSlots()) for (const cell of slot.cells) cell.c = -1;
    this.colSpans.resetCustom();
    this.rowSpans.resetCustom();
    for (const pane of this.#panes()) pane.spans.resetCustom();
    this.anchorCol = null;
    this.rendered.vx = NaN;
    this.invalidate();
  }

  // ---------------------------------------------------------------- sorting and filtering

  /**
   * Sort by the given keys (highest priority first). The data source does the sorting; the grid switches
   * to that order's cache and keeps the scroll position. Resolves to true when the sort was applied.
   */
  setSort(spec: readonly SortSpec[] | null | undefined): Promise<boolean> {
    const list = (spec ?? []).slice(0, MAX_SORT_KEYS).map((x): SortSpec => ({ key: { ...x.key }, dir: x.dir === 'd' ? 'd' : 'a' }));
    return this.#applyView(list, this.filterSpec, 'sort');
  }

  /** Filter rows (conditions are ANDed; one per column or row dimension). */
  setFilter(conditions: readonly Condition[] | null | undefined): Promise<boolean> {
    const list = (conditions ?? []).map((c) => ({ ...c }));
    return this.#applyView(this.sortSpec, list, 'filter');
  }

  /** Filter the columns by their dimensions (a pivot's Measure / Year / …; a table's column groups). */
  setColumnDimFilter(conditions: readonly Condition[] | null | undefined): Promise<boolean> {
    const list = (conditions ?? []).map((c) => ({ ...c }));
    return this.#applyView(this.sortSpec, this.filterSpec, 'columns', list);
  }

  /** Set (or with null, clear) the condition for one column / row dimension / column dimension. */
  setColumnFilter(key: ViewKey, condition: BareCondition | null): Promise<boolean> {
    if (key.cdim !== undefined) {
      const rest = this.colFilterSpec.filter((f) => f.dim !== key.cdim);
      return this.#userChange('columnFilter', condition ? [...rest, { ...condition, dim: key.cdim }] : rest);
    }
    const rest = this.filterSpec.filter((f) => !sameFilterKey(f, key));
    return this.#userChange('filter', condition ? [...rest, { ...condition, ...filterKeyFields(key) }] : rest);
  }

  #currentCondition(key: ViewKey): Condition | undefined {
    return key.cdim !== undefined ? this.colFilterSpec.find((f) => f.dim === key.cdim) : this.filterSpec.find((f) => sameFilterKey(f, key));
  }

  /** Whether a filter is set on a key (column, row dimension or column dimension). */
  #hasFilter(key: ViewKey): boolean {
    return this.#currentCondition(key) !== undefined;
  }

  /** Opens the filter dialog for a key, under `anchor` (a header button) or at the top of the grid. */
  async openFilter(key: ViewKey, anchor?: Element | null): Promise<void> {
    this.closeFilter();
    if (!this.model.filterOptions) return;
    let description;
    try {
      description = await this.model.filterOptions(key, (axis, level, idx) => this.#labelFromCache(axis, level, idx));
    } catch (err) {
      this.o.onViewChange?.({ ok: false, what: 'filter', reason: `Could not load filter options: ${errorMessage(err)}` });
      return;
    }
    if (!description) return;
    const current = this.#currentCondition(key);
    const isColumns = key.cdim !== undefined;
    const focusGrid = () => this.scroller.focus({ preventScroll: true });
    this.#filter = new FilterDialog({
      host: this.host,
      messages: this.msg,
      description,
      current,
      currentPublic: current && !isColumns ? filterToPublic([current], this.#keyOf)[0] : null,
      blocked: isColumns ? '' : this.#limitReason(this.sortSpec, [{ op: '' }]),
      controlled: !!this.o.controlled?.[isColumns ? 'columnFilter' : 'filter'],
      anchor,
      fallbackAnchor: { left: this.rowHeaderWidth, bottom: this.headerHeight },
      apply: (condition) => this.setColumnFilter(key, condition),
      outcome: () => ({ refusal: this.lastRefusal, cancelled: this.lastCancelled }),
      cancel: () => this.cancelView(),
      close: () => {
        this.closeFilter();
        focusGrid();
      },
      dismiss: () => this.closeFilter(),
    });
  }

  closeFilter(): void {
    this.#filter?.destroy();
    this.#filter = null;
  }

  /** "City 1: Lisbon, Oslo; Amount 1 ≥ 20000" (uses header labels already loaded). */
  filterSummary(): string {
    const describe = (f: Condition, key: ViewKey, fallback: string) => `${this.#keyName(key) ?? fallback} ${describeCondition(f)}`;
    return [
      ...this.colFilterSpec.map((f) => describe(f, { cdim: f.dim }, `Column level ${f.dim! + 1}`)),
      ...this.filterSpec.map((f) => describe(f, f.dim !== undefined ? { dim: f.dim } : { col: f.c }, f.dim !== undefined ? `Level ${f.dim + 1}` : `Column ${f.c! + 1}`)),
    ].join('; ');
  }

  /** "Amount 1 ▼, Status 1 ▲" (uses header labels already loaded). */
  sortSummary(): string {
    return this.sortSpec
      .map((s) => `${this.#keyName(s.key) ?? (s.key.dim !== undefined ? `Level ${s.key.dim + 1}` : `Column ${s.key.col! + 1}`)} ${s.dir === 'a' ? '▲' : '▼'}`)
      .join(', ');
  }

  #keyName(key: ViewKey): string | undefined {
    return this.model.sortKeyName?.(key, (axis, level, idx) => this.#labelFromCache(axis, level, idx));
  }

  async #applyView(sortList: SortSpec[], filterList: Condition[], what: ViewWork, colFilterList = this.colFilterSpec): Promise<boolean> {
    const colFilterParam = filterParamOf(colFilterList);
    let dropped = 0;
    if (colFilterParam !== this.colFilterParam && this.model.serverColFilter) {
      // A server-side column filter renumbers the columns, so sorts on value columns no longer point at
      // the same column: drop them (row-dimension sorts stay).
      const kept = sortList.filter((x) => x.key.col === undefined);
      dropped = sortList.length - kept.length;
      sortList = kept;
      // Tables with described columns: filters on columns point at old column numbers too.
      if (this.model.describedColumns) filterList = filterList.filter((f) => f.c === undefined);
    }
    const sortParam = sortParamOf(sortList);
    const filterParam = filterParamOf(filterList);
    if (sortParam === this.sortParam && filterParam === this.filterParam && colFilterParam === this.colFilterParam) return true;
    const refuse = (reason: string) => {
      this.lastRefusal = reason;
      this.o.onViewChange?.({ ok: false, what, reason });
      // The filter dialog shows its own errors; anything else gets a notice in the grid.
      if (!this.#filter) this.notify(reason, true);
      return false;
    };
    this.lastRefusal = '';
    this.lastCancelled = false;
    const follow = this.rowSnapshot();
    const limitReason = this.#limitReason(sortList, filterList);
    if (limitReason) return refuse(limitReason);
    const token = ++this.#sortSeq;
    // A newer sort or filter replaces one still running: stop that one.
    this.#endWork();
    const work: Work = { what, ctrl: new AbortController(), started: performance.now(), progress: null, timer: undefined };
    this.#work = work;
    work.timer = setTimeout(() => this.#showWork(work), WORK_NOTICE_DELAY_MS);
    const onProgress = (progress: Progress) => {
      if (this.#work !== work) return;
      work.progress = progress;
      this.#showWork(work);
      this.o.onViewChange?.({ pending: true, what, progress });
    };
    this.o.onViewChange?.({ pending: true, what });
    try {
      // The model fetches what changes: the row count (filter) and, for a pivot, the reordered layout.
      await this.model.applyView?.({
        sort: sortParam,
        filter: filterParam,
        colfilter: colFilterParam,
        query: this.#publicQuery(sortList, filterList, colFilterList),
        signal: work.ctrl.signal,
        onProgress,
      });
    } catch (err) {
      const cancelled = work.ctrl.signal.aborted;
      if (this.#work === work) this.#endWork();
      if (token !== this.#sortSeq) return false;
      if (cancelled) {
        this.lastCancelled = true;
        this.o.onViewChange?.({ ok: false, what, cancelled: true });
        return false;
      }
      return refuse(this.msg.failed(what === 'sort' ? 'sort' : 'filter', errorMessage(err)));
    }
    if (this.#work === work) this.#endWork();
    if (token !== this.#sortSeq) return false; // a newer request won
    this.sortSpec = sortList;
    this.sortParam = sortParam;
    this.filterSpec = filterList;
    this.filterParam = filterParam;
    this.colFilterSpec = colFilterList;
    this.colFilterParam = colFilterParam;
    this.query = this.#publicQuery();
    if (dropped) this.#emit('sort', sortList);
    this.rows = this.model.rows;
    this.cols = this.model.cols;
    this.#useColLabels();
    this.#useView();
    this.#structureChanged();
    this.#followRow(follow, false);
    this.#renderCornerSort();
    this.scrollToVirtual(this.vx, this.vy);
    this.o.onViewChange?.({
      ok: true, what, rows: this.rows.count, cols: this.cols.count, totalRows: this.model.totalRows,
      sort: this.sortSummary(), filter: this.filterSummary(), droppedSorts: dropped,
    });
    return true;
  }

  /** Why the data source cannot take this sort / filter (its row limits), or ''. */
  #limitReason(sortList: readonly SortSpec[], filterList: readonly Condition[]): string {
    const total = this.model.totalRows ?? this.rows.count;
    const { sortLimit, filterLimit } = this.model;
    if (sortList.length > 1 && sortLimit && total > sortLimit) return this.msg.sortLimit(sortLimit, total);
    if (filterList.length && filterLimit && total > filterLimit) return this.msg.filterLimit(filterLimit, total);
    return '';
  }

  /** Whether the sortable / filterable option allows this key (a boolean, or a function of the column or level). */
  #allowed(option: 'sortable' | 'filterable', key: ViewKey | null | undefined): key is ViewKey {
    if (!key) return false;
    const rule = this.o[option] as Rule<FilterTarget>;
    if (typeof rule !== 'function') return rule !== false;
    const target: FilterTarget = key.col !== undefined
      ? { axis: 'cols', column: key.col, key: this.model.keyOf?.(key.col) }
      : key.dim !== undefined ? { axis: 'rows', level: key.dim } : { axis: 'cols', level: key.cdim! };
    return rule(target) !== false;
  }

  /** Stop the sort or filter that is being applied (the data source gets an aborted signal). */
  cancelView(): boolean {
    if (!this.#work) return false;
    this.#work.ctrl.abort();
    return true;
  }

  /** "Filtering… Checking rows · 42% · 7 s" in the filter dialog, or in a notice with a Cancel button. */
  #showWork(work: Work): void {
    if (this.#work !== work) return;
    const seconds = (performance.now() - work.started) / 1000;
    const text = this.msg.working(work.what, work.progress, seconds);
    const status = this.#filter?.workStatus;
    if (status) status.textContent = text;
    else this.#notices.showWork(text);
    // Keep the seconds counting even when the data source reports no progress.
    clearTimeout(work.timer);
    work.timer = setTimeout(() => this.#showWork(work), 1000);
  }

  #endWork(): void {
    const work = this.#work;
    if (!work) return;
    clearTimeout(work.timer);
    work.ctrl.abort();
    this.#work = null;
    this.#notices.hideWork();
  }

  /** A short message at the bottom of the grid (refused or failed sorts and filters). notices: false turns it off. */
  notify(text: string, isError = false): void {
    this.#notices.notify(text, isError);
  }

  /**
   * Click on a sort control. Plain: sort by this key alone, cycling ascending → descending → none.
   * Additive (Shift): add the key as the lowest priority, or cycle it in place (→ removed after descending).
   */
  toggleSort(key: ViewKey, additive = false): Promise<boolean> {
    if (!this.#allowed('sortable', key)) return Promise.resolve(false);
    if (!this.o.multiSort) additive = false;
    const i = this.sortSpec.findIndex((s) => sameSortKey(s.key, key));
    const nextDir = (dir: SortDir | null): SortDir | null => (dir === 'a' ? 'd' : dir === 'd' ? null : 'a');
    let spec: SortSpec[];
    if (additive) {
      if (i < 0) spec = [...this.sortSpec, { key, dir: 'a' }];
      else {
        const dir = nextDir(this.sortSpec[i].dir);
        spec = dir ? this.sortSpec.map((s, j) => (j === i ? { key, dir } : s)) : this.sortSpec.filter((_, j) => j !== i);
      }
    } else {
      const dir = nextDir(i >= 0 ? this.sortSpec[i].dir : null);
      spec = dir ? [{ key, dir }] : [];
    }
    return this.#userChange('sort', spec.slice(0, MAX_SORT_KEYS));
  }

  #labelFromCache(axis: AxisName, level: number, idx: number): string | undefined {
    const key = labelKey(axis, level, idx);
    const b = (axis === 'cols' ? this.colLabels?.get(key) : this.cache.get(key)) as LabelBlock | undefined;
    return b ? b.names[idx - b.from] : undefined;
  }

  /** Sort state of a key for display, or null when it is not sorted. */
  #sortStateOf(key: ViewKey): SortState | null {
    const i = this.sortSpec.findIndex((s) => sameSortKey(s.key, key));
    if (i < 0) return null;
    return { dir: this.sortSpec[i].dir, priority: this.sortSpec.length > 1 ? i + 1 : 0 };
  }

  #renderCornerSort(): void {
    for (const { btn, cell, key, filterBtn, fkey } of this.#cornerSort) {
      if (filterBtn && fkey) paintFilterButton(filterBtn, this.#hasFilter(fkey));
      if (!btn || !key) continue;
      const state = this.#sortStateOf(key);
      paintSortButton(btn, state);
      paintAriaSort(cell, state);
    }
  }

  // ---------------------------------------------------------------- caches

  /** The server-side column filter (empty for models that filter columns themselves). */
  get #serverColFilter(): string {
    return this.model.serverColFilter ? this.colFilterParam : '';
  }

  /** Descriptions for source columns from … arrived: forget what was built without them, apply widths. */
  #columnsDescribed(from: number, metas: ColumnDescription[]): void {
    this.model.columnsDescribed?.(from, metas.length);
    const cols = this.cols as { setSourceSizes?(entries: [number, number][]): void };
    const sizes: [number, number][] = [];
    metas.forEach((m, i) => {
      const src = from + i;
      if (typeof m.width === 'number' && m.width > 0 && !this.#userWidths.has(src)) sizes.push([src, Math.max(this.o.minColWidth, Math.round(m.width))]);
    });
    if (sizes.length && cols.setSourceSizes) {
      cols.setSourceSizes(sizes);
      this.#updateContentSize();
      this.#ensurePools();
    }
    this.#describedPending = true;
  }

  /** After a failed request: try again in a moment (the wish list is sent again). */
  #retrySoon(): void {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      this.#lastWantSig = '';
      this.invalidate();
    }, RETRY_DELAY_MS);
  }

  #useColLabels(): void {
    const sig = this.#serverColFilter;
    let cache = this.#colLabelCaches.get(sig);
    if (!cache) {
      cache = new BlockCache<LabelBlock>({
        maxEntries: 2000,
        // Column descriptions change formats, alignment and widths: redraw the cells, not just the headers.
        onLoad: () => {
          if (this.#describedPending) {
            this.#describedPending = false;
            this.repaint();
          } else this.invalidate();
        },
      });
      this.#colLabelCaches.set(sig, cache);
      trimOldest(this.#colLabelCaches, MAX_VIEWS);
    }
    if (this.colLabels && this.colLabels !== cache) this.colLabels.abortAll();
    cache.onError = (err) => {
      this.o.onError?.(err, { kind: 'labels' });
      this.#retrySoon();
    };
    this.colLabels = cache;
  }

  /** Switch to the cache of the current sort + filter (created on first use; at most MAX_VIEWS kept). */
  #useView(): void {
    const sig = `${this.sortParam}#${this.filterParam}#${this.#serverColFilter}`;
    if (this.#view && this.#view.sig !== sig) this.#view.cache.abortAll(); // stop fetching for the old view
    let v = this.#views.get(sig);
    if (v) this.#views.delete(sig);
    else v = { sig, cache: this.#makeCache(this.sortParam, this.filterParam, this.#serverColFilter, this.query), copyCache: new Map() };
    this.#views.set(sig, v);
    trimOldest(this.#views, MAX_VIEWS, (old) => old.cache.abortAll());
    this.#view = v;
    this.cache = v.cache;
    this.#lastWantSig = '';
  }

  #makeCache(sort: string, filter: string, colfilter: string, query: Query): BlockCache {
    const o = this.o;
    const fetchGather = o.fetchGather;
    return new BlockCache({
      maxGatherRects: o.maxGatherRects ?? 400,
      maxGatherCells: o.maxGatherCells ?? 20_000,
      gather: fetchGather
        ? (rects, signal) => fetchGather({ rects, signal, query, sort, filter, colfilter }).then((res) => {
          if (Array.isArray(res)) return res;
          if (!sort && !filter) this.merges.addServer(res.merges);
          return res.cells;
        })
        : undefined,
      onLoad: () => this.invalidate(),
      onError: (err) => {
        this.o.onError?.(err, { kind: 'cells' });
        this.#retrySoon();
      },
    });
  }

  #structureChanged(): void {
    this.scroller.setAttribute('aria-rowcount', String(this.rows.count + this.model.colTiers.length));
    this.scroller.setAttribute('aria-colcount', String(this.cols.count + this.model.rowBands.length));
    this.#updateContentSize();
    this.#ensurePools();
    // Visible indexes shifted: reposition and refill everything (data comes from the cache).
    this.anchorRow = null;
    this.anchorCol = null;
    this.rendered.vx = NaN;
    this.#lastWantSig = '';
  }

  /** Re-render on the next frame (for example after data arrived). */
  invalidate(): void {
    if (this.#raf) return;
    this.#raf = requestAnimationFrame(() => {
      this.#raf = 0;
      this.#render(true);
    });
  }

  /** The drawn window, or null before the first frame. */
  get view(): DrawnWindow | null {
    return this.#win;
  }

  /** Render and cache counters; resets the slowest-frame counter. */
  takeStats(): GridStats {
    const c = this.cache;
    const s: GridStats = { ...this.stats, cache: { ...c.stats, cached: c.entries.size, inflight: c.inflight.size, queued: c.queue.length } };
    this.stats.renderMsMax = 0;
    return s;
  }

  destroy(): void {
    this.#endWork();
    for (const slot of this.#allSlots()) for (const cell of slot.cells) if (cell.cleanup !== undefined) this.#runCleanup(cell);
    this.colSpans.destroy();
    for (const pane of this.#panes()) pane.spans.destroy();
    this.rowSpans.destroy();
    this.emptyCleanup?.();
    this.#ro.disconnect();
    this.#notices.destroy();
    cancelAnimationFrame(this.#raf);
    clearTimeout(this.#fetchTimer);
    clearTimeout(this.#retryTimer);
    this.cache.abortAll();
    this.colLabels?.abortAll();
    this.closeFilter();
    this.scroller.removeEventListener('scroll', this.#onScroll);
    this.scroller.removeEventListener('wheel', this.#onWheel);
    this.scroller.removeEventListener('keydown', this.#onKeyDown);
    for (const head of [this.colHead, this.pinL.head, this.pinR.head]) {
      head.removeEventListener('pointerdown', this.#onHeadPointerDown);
      head.removeEventListener('click', this.#onHeadClick);
    }
    this.rowHead.removeEventListener('click', this.#onHeadClick);
    for (const body of [this.body, this.pinL.body, this.pinR.body]) {
      body.removeEventListener('pointerdown', this.#onBodyPointerDown);
      body.removeEventListener('click', this.#onBodyClick);
      body.removeEventListener('dblclick', this.#onBodyDblClick);
      body.removeEventListener('contextmenu', this.#onBodyContextMenu);
    }
    this.corner.removeEventListener('click', this.#onCornerClick);
    this.host.textContent = '';
    this.host.classList.remove('vg', 'vg-auto', 'vg-light', 'vg-dark', 'vg-nosel', 'vg-pivot', 'vg-table');
  }

  // ---------------------------------------------------------------- DOM and layout

  #buildDom(host: HTMLElement): void {
    const { model } = this;
    this.host = host;
    host.textContent = '';
    host.classList.add('vg', `vg-${this.o.theme}`);
    if (model.hostClass) host.classList.add(model.hostClass);
    if (this.o.selection === 'none') host.classList.add('vg-nosel');
    host.style.setProperty('--vg-head-h', `${this.headerHeight}px`);
    host.style.setProperty('--vg-rh-w', `${this.rowHeaderWidth}px`);

    this.scroller = div('vg-scroller', host);
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute('role', 'grid');
    if (this.o.ariaLabel) this.scroller.setAttribute('aria-label', this.o.ariaLabel);
    this.scroller.setAttribute('aria-rowcount', String(this.rows.count + model.colTiers.length));
    this.scroller.setAttribute('aria-colcount', String(this.cols.count + model.rowBands.length));
    this.content = div('vg-content', this.scroller);
    this.viewport = div('vg-viewport', this.content);
    this.body = div('vg-body', this.viewport);
    this.bodyLayer = div('vg-layer', this.body);
    this.mergeLayerEl = div('vg-layer vg-merges', this.body);
    this.mergeLayer = new MergeLayer(this.mergeLayerEl);
    this.selLayerEl = div('vg-layer vg-sel-layer', this.body);
    this.selLayer = new SelectionLayer(this.selLayerEl);
    // Drawn after the body and the column headers, so they cover the columns scrolled beneath them.
    this.pinL = this.#pinPane(false);
    this.pinR = this.#pinPane(true);
    this.rowHead = div('vg-rowhead', this.viewport);
    this.rowHeadLayer = div('vg-layer', this.rowHead);
    this.colHead = div('vg-colhead', this.viewport);
    this.colHeadLayer = div('vg-layer', this.colHead);
    for (const pane of this.#panes()) {
      pane.head = div(`vg-colhead vg-pinhead${pane.right ? ' vg-pinright' : ''}`, this.viewport);
      pane.head.hidden = true;
      pane.headLayer = div('vg-layer', pane.head);
    }
    // Headers are absolutely positioned spans, not a table: each header layer is one ARIA row (a header's
    // required parent), so the grid's children are all rows.
    this.rowHeadLayer.setAttribute('role', 'row');
    this.colHeadLayer.setAttribute('role', 'row');
    this.colHeadLayer.setAttribute('aria-rowindex', '1');
    for (const pane of this.#panes()) {
      pane.headLayer.setAttribute('role', 'row');
      pane.headLayer.setAttribute('aria-rowindex', '1');
    }
    this.corner = div('vg-corner', this.viewport);
    this.emptyEl = div('vg-empty', host); // outside the grid element: only rows are allowed inside it
    this.emptyEl.hidden = true;
    // A live region, not role=status: a status is not an allowed child of a grid.
    this.emptyEl.setAttribute('aria-live', 'polite');
    this.#emptySig = '';
    this.#notices = new Notices(host, () => this.o.notices !== false, this.msg.cancel, () => this.cancelView());
    this.rowSpans = new SpanLayer(this.rowHeadLayer, true, false, false, 'rows');
    this.colSpans = new SpanLayer(this.colHeadLayer, false, true, true, 'cols');
    this.rowSpans.renderHeader = (el, ctx) => this.o.renderHeader?.(el, ctx);
    this.colSpans.renderHeader = (el, ctx) => this.o.renderHeader?.(el, ctx);
    this.rowSpans.checkLabel = this.msg.selectRow;
    const hasRenderer = () => typeof this.o.renderHeader === 'function';
    this.rowSpans.hasRenderer = this.colSpans.hasRenderer = hasRenderer;
    for (const pane of this.#panes()) {
      pane.spans = new SpanLayer(pane.headLayer, false, true, true, 'cols');
      pane.spans.renderHeader = (el, ctx) => this.o.renderHeader?.(el, ctx);
      pane.spans.hasRenderer = hasRenderer;
    }
    this.#buildCorner();
    // The corner (dimension names, select-all checkbox) is one header row.
    this.corner.setAttribute('role', 'row');
    for (const cn of this.corner.children) if (!cn.hasAttribute('role')) cn.setAttribute('role', 'columnheader');

    this.scroller.addEventListener('scroll', this.#onScroll, { passive: true });
    this.scroller.addEventListener('wheel', this.#onWheel, { passive: false });
    this.scroller.addEventListener('keydown', this.#onKeyDown);
    for (const head of [this.colHead, this.pinL.head, this.pinR.head]) {
      head.addEventListener('pointerdown', this.#onHeadPointerDown);
      head.addEventListener('click', this.#onHeadClick);
    }
    this.rowHead.addEventListener('click', this.#onHeadClick);
    for (const body of [this.body, this.pinL.body, this.pinR.body]) {
      body.addEventListener('pointerdown', this.#onBodyPointerDown);
      body.addEventListener('click', this.#onBodyClick);
      body.addEventListener('dblclick', this.#onBodyDblClick);
      body.addEventListener('contextmenu', this.#onBodyContextMenu);
    }
    this.corner.addEventListener('click', this.#onCornerClick);
    this.corner.title = this.msg.selectAll;
  }

  /** Corner: column dimension names on the upper tiers, row dimension names on the last tier. */
  #buildCorner(): void {
    const { model } = this;
    const { colTiers, rowBands } = model;
    const T = colTiers.length;
    const addFilterButton = (cell: HTMLElement, key: ViewKey) => {
      cell.classList.add('vg-filterable');
      const btn = makeFilterButton();
      btn.dataset.filterKey = viewKeyId(key);
      cell.appendChild(btn);
      return btn;
    };
    for (let t = 0; t < T - 1; t++) {
      const d = div('vg-cn vg-cn-tier', this.corner);
      d.style.top = `${this.tierOff[t]}px`;
      d.style.height = `${colTiers[t].height}px`;
      d.style.lineHeight = `${colTiers[t].height}px`;
      d.textContent = colTiers[t].name ?? '';
      const tierKey = model.colTierFilter?.(t);
      if (this.#allowed('filterable', tierKey)) {
        this.#cornerSort.push({ btn: null, cell: d, key: null, filterBtn: addFilterButton(d, tierKey), fkey: tierKey });
      }
    }
    rowBands.forEach((band, b) => {
      const d = div('vg-cn', this.corner);
      d.style.top = `${this.tierOff[T - 1]}px`;
      d.style.left = `${this.rowBandOff[b]}px`;
      d.style.width = `${band.width}px`;
      d.style.height = `${colTiers[T - 1].height}px`;
      d.style.lineHeight = `${colTiers[T - 1].height}px`;
      d.textContent = band.name ?? '';
      if (b === 0 && this.o.rowSelection) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'vg-check';
        box.tabIndex = -1;
        box.setAttribute('aria-label', this.msg.selectAllRows);
        d.insertBefore(box, d.firstChild);
        d.classList.add('vg-cn-check');
        this.#cornerCheck = box;
      }
      const sortKey = model.rowBandSort?.(b);
      const key = this.#allowed('sortable', sortKey) ? sortKey : null;
      const filterKey = model.rowBandFilter?.(b);
      const fkey = this.#allowed('filterable', filterKey) ? filterKey : null;
      const filterBtn = fkey ? addFilterButton(d, fkey) : null;
      if (key) {
        d.classList.add('vg-sortable');
        d.setAttribute('role', 'columnheader');
        const btn = makeSortButton();
        btn.dataset.sortKey = viewKeyId(key);
        d.appendChild(btn);
        this.#cornerSort.push({ btn, cell: d, key, filterBtn, fkey });
      } else if (filterBtn) {
        // Filterable but not sortable (e.g. a flat table's "#": choose column groups).
        this.#cornerSort.push({ btn: null, cell: d, key: null, filterBtn, fkey });
      }
    });
    this.#renderCornerSort();
  }

  #measure(): void {
    this.clientW = this.scroller.clientWidth;
    this.clientH = this.scroller.clientHeight;
    this.bodyW = Math.max(0, this.clientW - this.rowHeaderWidth);
    this.bodyH = Math.max(0, this.clientH - this.headerHeight);
    this.viewport.style.width = `${this.clientW}px`;
    this.viewport.style.height = `${this.clientH}px`;
    this.#updateContentSize();
    this.#ensurePools();
    this.rendered.vx = NaN;
    this.scrollToVirtual(this.vx, this.vy);
  }

  #updateContentSize(): void {
    const totalW = this.cols.total;
    const totalH = this.rows.total;
    const fullW = this.rowHeaderWidth + totalW;
    const fullH = this.headerHeight + totalH;
    const contentW = Math.max(Math.min(fullW, MAX_SCROLL_PX), this.clientW);
    const contentH = Math.max(Math.min(fullH, MAX_SCROLL_PX), this.clientH);
    this.content.style.width = `${contentW}px`;
    this.content.style.height = `${contentH}px`;
    this.maxVX = Math.max(0, totalW - this.bodyW);
    this.maxVY = Math.max(0, totalH - this.bodyH);
    const maxSL = contentW - this.clientW;
    const maxST = contentH - this.clientH;
    this.ratioX = maxSL > 0 && fullW > MAX_SCROLL_PX ? this.maxVX / maxSL : 1;
    this.ratioY = maxST > 0 && fullH > MAX_SCROLL_PX ? this.maxVY / maxST : 1;
  }

  #ensurePools(): void {
    const { overscanRows, overscanCols } = this.o;
    // Pools are sized for the smallest item, so they always cover the viewport whatever sizes scroll in.
    const N = Math.min(this.rows.count, Math.ceil(this.bodyH / Math.max(1, this.rows.minSize)) + 1 + 2 * overscanRows);
    const M = Math.min(this.cols.count, Math.ceil(this.bodyW / Math.max(1, this.cols.minSize)) + 1 + 2 * overscanCols);
    if (N === this.N && M === this.M) return;
    this.N = N;
    this.M = M;
    this.#xs = new Float64Array(M);
    this.#ws = new Float64Array(M);
    this.#colSrc = new Float64Array(M);
    this.#colExact = new Uint8Array(M);
    this.#bodyExact = new Uint8Array(M);
    this.#rowSrc = new Float64Array(N);
    this.#rowExact = new Uint8Array(N);
    this.#cover = new Uint8Array(N * M);
    this.#kinds = new Array<string>(M).fill('');
    this.#infos = new Array<ColumnInfo | null>(M).fill(null);
    for (const slot of this.rowSlots) for (const cell of slot.cells) if (cell.cleanup !== undefined) this.#clearCustom(cell);

    // Every cell owns one Text node for its whole life; updates set `.data`, so scrolling never
    // creates or removes nodes.
    const frag = document.createDocumentFragment();
    this.rowSlots = [];
    for (let i = 0; i < N; i++) {
      const el = div('vg-row');
      el.setAttribute('role', 'row');
      const cells: CellSlot[] = [];
      for (let j = 0; j < M; j++) {
        const cellEl = div('vg-cell', el);
        cellEl.setAttribute('role', 'gridcell');
        cells.push({
          el: cellEl, text: cellEl.appendChild(document.createTextNode('')), box: null, cleanup: undefined, extra: '', c: -1,
          base: 'vg-cell', cls: 'vg-cell', filled: false, ph: false, covered: 0, selected: undefined,
        });
      }
      frag.appendChild(el);
      this.rowSlots.push({ el, cells, r: -1, h: NaN, cls: 'vg-row' });
    }
    this.bodyLayer.replaceChildren(frag);
    this.anchorRow = null;
    this.anchorCol = null;
    this.rendered.vx = NaN;
    this.#ensurePinPool(true);
  }

  /** A pinned pane's elements (the header is added after the column header, so it is drawn over it). */
  #pinPane(right: boolean): PinPane {
    const body = div(`vg-body vg-pinbody${right ? ' vg-pinright' : ''}`, this.viewport);
    body.hidden = true;
    const layer = div('vg-layer', body);
    const mergeEl = div('vg-layer vg-merges', body);
    const selEl = div('vg-layer vg-sel-layer', body);
    return {
      right, body, layer, mergeEl, merges: new MergeLayer(mergeEl), selEl, sel: new SelectionLayer(selEl),
      head: body, headLayer: body, spans: null as unknown as SpanLayer, slots: [], count: 0, first: 0, base: 0, w: 0, x: 0, sig: '',
      src: new Float64Array(0), exact: new Uint8Array(0), cover: new Uint8Array(0),
    };
  }

  #panes(): [PinPane, PinPane] {
    return [this.pinL, this.pinR];
  }

  #allSlots(): RowSlot[] {
    return [...this.rowSlots, ...this.pinL.slots, ...this.pinR.slots];
  }

  /** The pinned pane showing visible column c, if any. */
  #paneOf(c: number): PinPane | null {
    if (c < this.pinL.count) return this.pinL;
    if (this.pinR.count && c >= this.pinR.first) return this.pinR;
    return null;
  }

  /** Columns scrolling between the panes: [first, last]. */
  #middle(): [number, number] {
    return [this.pinL.count, this.cols.count - this.pinR.count - 1];
  }

  /** Pinned panes' cells: N rows × (pinned count) cells each, rebuilt when either changes. */
  #ensurePinPool(force = false): void {
    const n = this.cols.count;
    const L = Math.min(this.model.pinnedCols?.() ?? 0, n);
    const R = Math.min(this.model.pinnedColsRight?.() ?? 0, n - L);
    for (const pane of this.#panes()) {
      const P = pane.right ? R : L;
      pane.first = pane.right ? n - R : 0;
      if (!force && P === pane.count && pane.slots.length === this.N) continue;
      for (const slot of pane.slots) for (const cell of slot.cells) if (cell.cleanup !== undefined) this.#clearCustom(cell);
      pane.count = P;
      pane.sig = '';
      pane.slots = [];
      pane.src = new Float64Array(P);
      pane.exact = new Uint8Array(P);
      pane.cover = new Uint8Array(this.N * P);
      const frag = document.createDocumentFragment();
      if (P > 0) {
        for (let i = 0; i < this.N; i++) {
          const el = div('vg-row');
          el.setAttribute('role', 'row');
          const cells: CellSlot[] = [];
          for (let j = 0; j < P; j++) {
            const cellEl = div('vg-cell', el);
            cellEl.setAttribute('role', 'gridcell');
            cells.push({
              el: cellEl, text: cellEl.appendChild(document.createTextNode('')), box: null, cleanup: undefined, extra: '', c: -1,
              base: 'vg-cell', cls: 'vg-cell', filled: false, ph: false, covered: 0, selected: undefined,
            });
          }
          frag.appendChild(el);
          pane.slots.push({ el, cells, r: -1, h: NaN, cls: 'vg-row' });
        }
      }
      pane.layer.replaceChildren(frag);
      pane.body.hidden = P === 0;
      pane.head.hidden = P === 0;
    }
  }

  // ---------------------------------------------------------------- input

  #onScroll = (): void => {
    const st = this.scroller.scrollTop;
    const sl = this.scroller.scrollLeft;
    // Unscaled axes map 1:1. Scaled axes keep the exact virtual offset we set ourselves (wheel/keys)
    // and only fall back to proportional mapping when the scrollbar moved for another reason (drag, touch).
    if (this.ratioY === 1 || this.#expectTop === null || Math.abs(st - this.#expectTop) > 1.5) {
      this.vy = clamp(st * this.ratioY, 0, this.maxVY);
    }
    if (this.ratioX === 1 || this.#expectLeft === null || Math.abs(sl - this.#expectLeft) > 1.5) {
      this.vx = clamp(sl * this.ratioX, 0, this.maxVX);
    }
    this.#expectTop = null;
    this.#expectLeft = null;
    this.#render();
  };

  #onWheel = (e: WheelEvent): void => {
    if ((this.ratioX === 1 && this.ratioY === 1) || e.ctrlKey) return; // native scrolling is exact here
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= this.rows.minSize;
      dy *= this.rows.minSize;
    } else if (e.deltaMode === 2) {
      dx *= this.bodyW;
      dy *= this.bodyH;
    }
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    e.preventDefault();
    this.scrollToVirtual(this.vx + dx, this.vy + dy);
  };

  /** The platform's primary modifier is held: ⌘ on Apple platforms, Ctrl elsewhere. */
  #isMod(e: KeyboardEvent | MouseEvent): boolean {
    return this.isMac ? e.metaKey : e.ctrlKey;
  }

  // Keyboard model (the grid is one tab stop; Tab moves focus out, as in the WAI-ARIA grid pattern).
  // "Mod" is ⌘ on Apple platforms and Ctrl elsewhere.
  //   arrows               move the active cell (a merged cell counts as one cell)
  //   Shift+arrows         extend the selection          Mod+arrows  jump to the first/last row/column
  //   Home / End           first / last column           Mod+Home/End  first / last cell
  //   PageUp / PageDown    move by one screen (Shift extends)
  //   Enter / Shift+Enter  next / previous cell; inside a multi-cell selection it cycles within it
  //   Mod+A                select all                    Escape  reduce the selection to the active cell
  //   Mod+C                copy the selection (tab-separated text + HTML table)
  //   Alt+S / Alt+Shift+S  sort by the active cell's column / add it as another sort key (cycles ▲ ▼ off)
  //   Alt+F                filter the active cell's column (opens the filter dialog)
  //   Alt+Shift+← / →      collapse / expand the row group at the active cell
  //   Alt+Shift+↑ / ↓      collapse / expand the column group at the active cell
  #onKeyDown = (e: KeyboardEvent): void => {
    if (!this.o.keyboard) return;
    if (e.target !== this.scroller && isEditable(e.target)) return; // typing in an input inside a cell
    const mod = this.#isMod(e);
    const shift = e.shiftKey;
    if (mod && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      if (!this.o.copy || this.o.selection === 'none') return;
      e.preventDefault();
      void this.copySelection();
      return;
    }
    const arrow = ARROWS[e.key];
    if (arrow && e.altKey && shift) {
      e.preventDefault();
      if (this.o.expandable) this.#toggleGroupAtActive(arrow[1] !== 0 ? 'rows' : 'cols', e.key === 'ArrowRight' || e.key === 'ArrowDown');
      return;
    }
    if (e.altKey && e.code === 'KeyF') {
      e.preventDefault();
      const key = this.model.colFilterKey?.(this.sel.active.c);
      if (this.#allowed('filterable', key)) void this.openFilter(key);
      return;
    }
    if (e.altKey && e.code === 'KeyS') {
      e.preventDefault();
      const c = this.sel.active.c;
      const key = this.model.colSortKey ? this.model.colSortKey(c) : { col: this.colSource(c) };
      if (key) void this.toggleSort(key, shift);
      return;
    }
    if (e.altKey) return;
    if (e.key === 'ContextMenu' || (shift && e.key === 'F10')) {
      const fn = this.#handler('onCellContextMenu');
      if (fn && this.rows.count && this.cols.count) {
        e.preventDefault();
        fn(this.#cellEvent(this.sel.active, e));
      }
      return;
    }
    if (e.key === ' ' && !mod && this.#checksOn()) {
      e.preventDefault();
      this.toggleRow(this.sel.active.r, shift);
      return;
    }
    const last = { r: this.rows.count - 1, c: this.cols.count - 1 };
    const from = shift ? this.sel.focus : this.sel.active;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        this.#move(arrow[0], arrow[1], shift, mod);
        break;
      case 'PageDown':
      case 'PageUp':
        this.#page(e.key === 'PageDown' ? 1 : -1, shift);
        break;
      case 'Home':
        this.#goTo(mod ? { r: 0, c: 0 } : { r: from.r, c: 0 }, shift);
        break;
      case 'End':
        this.#goTo(mod ? last : { r: from.r, c: last.c }, shift);
        break;
      case 'Enter':
        this.#cycle(shift ? -1 : 1);
        break;
      case 'Escape':
        this.#select(this.sel.active, 'set');
        break;
      case 'a':
      case 'A':
        if (!mod || this.o.selection !== 'multi') return;
        this.selectAll();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  #cellAt(x: number, y: number, rect: DOMRect): CellPosition {
    const lx = clamp(x - rect.left, 0, Math.max(0, this.bodyW - 1));
    const py = clamp(y - rect.top, 0, Math.max(0, this.bodyH - 1)) + this.vy;
    // Over the pinned columns: they do not scroll sideways.
    const { pinL: L, pinR: R } = this;
    const pin = this.#pinWidth();
    let c: number;
    if (lx < pin) c = Math.min(this.cols.indexAt(lx), L.count - 1);
    else if (R.count && lx >= this.#rightX()) c = clamp(this.cols.indexAt(lx - this.#rightX() + this.cols.offsetOf(R.first)), R.first, this.cols.count - 1);
    else c = this.cols.indexAt(lx + this.vx);
    return { r: this.rows.indexAt(py), c };
  }

  /** Width of the left pinned columns (0 without any). */
  #pinWidth(): number {
    return this.pinL.count ? this.cols.offsetOf(this.pinL.count) : 0;
  }

  /** Width of the right pinned columns (0 without any). */
  #pinWidthRight(): number {
    const R = this.pinR;
    return R.count ? this.cols.total - this.cols.offsetOf(R.first) : 0;
  }

  /** Body x where the right pane starts: at the right edge, or after the last column when they all fit. */
  #rightX(): number {
    return Math.max(this.#pinWidth(), Math.min(this.bodyW, this.cols.total) - this.#pinWidthRight());
  }

  // ---------------------------------------------------------------- cell events

  #handler(name: 'onCellClick' | 'onCellDoubleClick' | 'onCellContextMenu'): ((e: CellEvent) => void) | undefined {
    const fn = this.o[name];
    if (!fn || (this.o.hasHandler && !this.o.hasHandler(name))) return undefined;
    return fn;
  }

  /** What a cell event callback gets: the cell's context, its column key and the DOM event. */
  #cellEvent({ r, c }: CellPosition, event: MouseEvent | KeyboardEvent): CellEvent {
    const rs = this.rowSource(r);
    const cs = this.colSource(c);
    const value = this.cellValue(r, c);
    const ctx = this.#cellCtx(r, c, rs, cs, value, this.#infoOf(cs).column) as CellEvent;
    ctx.text = this.cellText(r, c) ?? '';
    ctx.key = this.model.keyOf?.(cs);
    ctx.event = event;
    return ctx;
  }

  #bodyEvent(name: 'onCellClick' | 'onCellDoubleClick' | 'onCellContextMenu', e: MouseEvent): void {
    const fn = this.#handler(name);
    if (!fn || this.rows.count === 0 || this.cols.count === 0 || isInteractive(e.target)) return;
    const cell = this.#clampCell(this.#cellAt(e.clientX, e.clientY, this.body.getBoundingClientRect()));
    // A right click outside the selection selects the cell first (as in spreadsheets).
    if (name === 'onCellContextMenu' && !inRanges(this.sel.ranges, cell.r, cell.c)) this.#select(cell, 'set');
    fn(this.#cellEvent(cell, e));
  }

  #onBodyClick = (e: MouseEvent): void => this.#bodyEvent('onCellClick', e);

  #onBodyDblClick = (e: MouseEvent): void => this.#bodyEvent('onCellDoubleClick', e);

  #onBodyContextMenu = (e: MouseEvent): void => this.#bodyEvent('onCellContextMenu', e);

  // ---------------------------------------------------------------- row identity

  /** Remember which row the active cell is on (by id), so the selection can follow it later. */
  #noteActiveRow(): void {
    const r = this.sel.active.r;
    if (!this.o.rowId || this.#activeRow?.r === r) return;
    const id = r < this.rows.count ? this.o.rowId(this.rowSource(r)) : undefined;
    this.#activeRow = id === undefined ? null : { r, id };
  }

  /** The active row's id and column, before a sort, filter or refresh (null when it is not known). */
  rowSnapshot(): { id: RowId; c: number } | null {
    this.#noteActiveRow();
    const a = this.#activeRow;
    return a && a.r === this.sel.active.r ? { id: a.id, c: this.sel.active.c } : null;
  }

  /**
   * After the rows changed order or content, put the selection back on the row it was on (found by id).
   * When that row is not in the view any more, or the grid cannot tell where it went, the selection moves
   * to the first row and a notice says why (messages.selectionRowGone / selectionNotFollowed). A refresh
   * without row ids keeps the position (the order is the same).
   */
  #followRow(snap: { id: RowId; c: number } | null, refresh: boolean): void {
    this.#clampSelection();
    this.#checksUnknown = false;
    this.#checksNoticeShown = false;
    const table = this.model.hostClass === 'vg-table';
    if (!table || !this.#userSelected || this.rows.count === 0) return;
    const c = snap?.c ?? this.sel.active.c;
    const toFirst = (why: 'rowGone' | 'notFollowed') => {
      const cell = this.#clampCell({ r: 0, c });
      this.sel = { active: cell, anchor: cell, focus: cell, ranges: [rangeOf(cell, cell)] };
      this.#moveReason = why;
      this.notify(why === 'rowGone' ? this.msg.selectionRowGone : this.msg.selectionNotFollowed, false);
      this.#reveal(cell);
      this.#selectionChanged();
    };
    if (!snap) {
      if (!refresh) toFirst('notFollowed');
      return;
    }
    if (!this.o.findRow) {
      toFirst('notFollowed');
      return;
    }
    const seq = ++this.#followSeq;
    const query = this.query;
    const apply = (pos: number | null) => {
      if (seq !== this.#followSeq || this.rows.count === 0) return;
      if (pos === null || !(pos >= 0) || pos >= this.rows.count) {
        toFirst(pos === -1 ? 'rowGone' : 'notFollowed');
        return;
      }
      const cell = this.#clampCell({ r: pos, c });
      this.sel = { active: cell, anchor: cell, focus: cell, ranges: [rangeOf(cell, cell)] };
      this.#selectionChanged();
      this.#activeRow = { r: cell.r, id: snap.id };
    };
    let res: number | null | Promise<number | null>;
    try {
      res = this.o.findRow(snap.id, query);
    } catch {
      res = null;
    }
    if (res instanceof Promise) res.then(apply, () => apply(null));
    else apply(res);
  }

  // ---------------------------------------------------------------- row checkboxes
  //
  // Checked rows are a list of steps: a row by id, or a range of positions in the order of some sort and
  // filter. The last step covering a row decides. A range costs the same for 10 rows or 50 million, so
  // checking works the same at any size without loading rows. Rows of another sort / filter are placed
  // by looking up their position there (indexOfRow), a screenful at a time.

  #checksOn(): boolean {
    return !!this.o.rowSelection && this.model.hostClass === 'vg-table';
  }

  #rowIdAt(r: number): RowId | undefined {
    return this.o.rowId ? this.o.rowId(this.rowSource(r)) : undefined;
  }

  #sigOf(step: CheckStep): string {
    if (step.sig === undefined && 'query' in step) step.sig = querySig(step.query);
    return step.sig ?? '';
  }

  /** Position of a row under another query, from the cache; asks for it (and redraws later) when missing. */
  #positionIn(sig: string, query: Query, id: RowId): number | null | undefined {
    let m = this.#positions.get(sig);
    if (!m) {
      m = new Map();
      this.#positions.set(sig, m);
      while (this.#positions.size > 8) this.#positions.delete(this.#positions.keys().next().value as string);
    }
    const hit = m.get(id);
    if (hit === 'pending') return undefined;
    if (hit !== undefined) return hit;
    if (!this.o.findRow) return null;
    const map = m;
    const store = (pos: number | null) => {
      if (map.size > MAX_POSITIONS) map.delete(map.keys().next().value as RowId);
      map.set(id, typeof pos === 'number' ? pos : null);
      this.anchorRow = null;
      this.invalidate();
    };
    let res: number | null | Promise<number | null>;
    try {
      res = this.o.findRow(id, query);
    } catch {
      res = null;
    }
    if (res instanceof Promise) {
      map.set(id, 'pending');
      res.then(store, () => store(null));
      return undefined;
    }
    map.set(id, typeof res === 'number' ? res : null);
    return map.get(id) as number | null;
  }

  #isChecked(r: number): boolean {
    const steps = this.#checks;
    if (!steps.length) return false;
    const sig = querySig(this.query);
    let id: RowId | undefined | null = null; // null = not read yet
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      if ('id' in step) {
        if (id === null) id = this.#rowIdAt(r);
        if (id !== undefined && id === step.id) return step.checked;
        continue;
      }
      if (this.#sigOf(step) === sig) {
        if (r >= step.from && r <= step.to) return step.checked;
        continue;
      }
      // A range from another sort / filter: where was this row there?
      if (id === null) id = this.#rowIdAt(r);
      if (id === undefined) {
        // No ids at all: these checks cannot be placed. (An id that is not loaded yet comes with the data.)
        if (!this.o.rowId) this.#checksUnknown = true;
        continue;
      }
      const pos = this.#positionIn(this.#sigOf(step), step.query, id);
      if (pos === null) this.#checksUnknown = true;
      else if (pos !== undefined && pos >= step.from && pos <= step.to) return step.checked;
    }
    return false;
  }

  /** Checked rows as steps, in order (the last step covering a row decides). */
  getRowSelection(): RowSelection {
    return { checks: this.#checks.map((st) => ('id' in st ? { id: st.id, checked: st.checked } : { from: st.from, to: st.to, query: st.query, checked: st.checked })) };
  }

  setRowSelection(sel: RowSelection | null | undefined): void {
    // The same checks coming back (a controlled prop echoing onRowSelectionChange) keep what the grid knows about them.
    if (JSON.stringify(sel?.checks ?? []) === JSON.stringify(this.getRowSelection().checks)) return;
    this.#checks = (sel?.checks ?? []).map((st) => ({ ...st }));
    this.anchorRow = null; // row classes and checkboxes
    this.invalidate();
  }

  #rowSelectionChanged(): void {
    this.anchorRow = null;
    this.#render(true);
    this.o.onRowSelectionChange?.(this.getRowSelection());
  }

  #push(step: CheckStep): void {
    // A newer step for the same id, or a range in the same view covering an older one, replaces it.
    const sig = 'query' in step ? this.#sigOf(step) : '';
    this.#checks = this.#checks.filter((old) => {
      if ('id' in step) return !('id' in old && old.id === step.id);
      return !('query' in old && this.#sigOf(old) === sig && old.from >= step.from && old.to <= step.to);
    });
    this.#checks.push(step);
  }

  /** Check or uncheck a row; with Shift, every row from the last one clicked takes the same state. */
  toggleRow(r: number, range = false): void {
    if (!this.#checksOn() || r < 0 || r >= this.rows.count) return;
    const checked = !this.#isChecked(r);
    const query = this.query;
    if (range && this.#lastCheck >= 0 && this.#lastCheck < this.rows.count && this.#lastCheck !== r) {
      this.#push({ from: Math.min(this.#lastCheck, r), to: Math.max(this.#lastCheck, r), query, checked });
    } else {
      const id = this.#rowIdAt(r);
      // A row checked by id remembers where it was, so it can be counted without asking the server.
      this.#push(id !== undefined ? { id, checked, at: r, atSig: querySig(query) } : { from: r, to: r, query, checked });
    }
    this.#lastCheck = r;
    this.#rowSelectionChanged();
  }

  /** True when every row of the current view is checked by one step (the header checkbox). */
  #allChecked(): boolean {
    const last = this.#checks[this.#checks.length - 1];
    return this.#checks.length === 1 && !!last && 'query' in last && last.checked && last.from === 0 && last.to >= this.rows.count - 1
      && this.#sigOf(last) === querySig(this.query);
  }

  /** The header checkbox: every row of the view (matching the filter), or none. */
  toggleAllRows(): void {
    if (!this.#checksOn()) return;
    this.#checks = this.#checks.length ? [] : [{ from: 0, to: Math.max(0, this.rows.count - 1), query: this.query, checked: true }];
    this.#lastCheck = -1;
    this.#rowSelectionChanged();
  }

  /**
   * How many rows are checked, when it can be told without the server: every range is in the current
   * sort / filter and every row checked by id has a known position. Otherwise undefined.
   */
  checkedCount(): number | undefined {
    // Count in the view where the ranges were made (a sort does not change which rows are checked):
    // all ranges must share one sort / filter; rows checked by id are placed in it.
    const ranges = this.#checks.filter((st): st is CheckStep & { query: Query } => 'query' in st);
    const home = ranges[0]?.query ?? this.query;
    const sig = querySig(home);
    if (ranges.some((st) => this.#sigOf(st) !== sig)) return undefined;
    const count = ranges.length && sig !== querySig(this.query) ? undefined : this.rows.count;
    let spans: [number, number][] = []; // disjoint, sorted
    const apply = (a: number, b: number, on: boolean) => {
      const out: [number, number][] = [];
      for (const [x, y] of spans) {
        if (y < a || x > b) out.push([x, y]);
        else {
          if (x < a) out.push([x, a - 1]);
          if (y > b) out.push([b + 1, y]);
        }
      }
      if (on) out.push([a, b]);
      spans = out.sort((p, q) => p[0] - q[0]);
    };
    for (const step of this.#checks) {
      if ('id' in step) {
        const pos = step.atSig === sig ? step.at : this.o.findRow ? this.#positionIn(sig, home, step.id) : undefined;
        if (pos === undefined || pos === null) return undefined;
        if (pos >= 0) apply(pos, pos, step.checked);
      } else apply(step.from, count === undefined ? step.to : Math.min(step.to, count - 1), step.checked);
    }
    return spans.reduce((n, [a, b]) => n + (b - a + 1), 0);
  }

  #paintCornerCheck(): void {
    const box = this.#cornerCheck;
    if (!box) return;
    const all = this.#allChecked();
    box.checked = all;
    box.indeterminate = !all && this.#checks.some((st) => st.checked);
  }

  /** After drawing: say once per view when checked rows could not be placed in it. */
  #checksNotice(): void {
    if (!this.#checksUnknown || this.#checksNoticeShown) return;
    this.#checksNoticeShown = true;
    this.notify(this.msg.checksNotShown, false);
  }

  // ---------------------------------------------------------------- column order

  /** Move the column at visible index `from` to visible index `to` (pinned and other columns stay apart). */
  moveColumn(from: number, to: number): void {
    const { model } = this;
    if (!model.moveColumn) return;
    const n = this.cols.count;
    if (from < 0 || from >= n) return;
    const pane = this.#paneOf(from);
    const [m0, m1] = this.#middle();
    to = pane ? clamp(to, pane.first, pane.first + pane.count - 1) : clamp(to, m0, m1);
    if (to === from) return;
    const activeSrc = this.colSource(this.sel.active.c);
    model.moveColumn(from, to);
    this.#columnsMoved(activeSrc);
    this.o.onColumnOrderChange?.(model.columnOrder?.() ?? []);
    this.o.onSelectionChange?.(this.selectionInfo());
  }

  /** Apply a column order from code: compact ([first, last] runs and indexes), source indexes or keys. */
  setColumnOrder(order: (string | number | [number, number])[]): void {
    if (!this.model.setColumnOrder) return;
    const activeSrc = this.colSource(this.sel.active.c);
    this.model.setColumnOrder(order);
    this.#columnsMoved(activeSrc);
  }

  /** After the column order changed: redraw, and keep the active cell on its column. */
  #columnsMoved(activeSrc: number): void {
    this.cols = this.model.cols;
    this.#structureChanged();
    const c = this.#visibleCol(activeSrc);
    if (c >= 0) {
      const cell = { r: this.sel.active.r, c };
      this.sel = { active: cell, anchor: cell, focus: cell, ranges: [rangeOf(cell, cell)] };
    } else this.#clampSelection();
    this.scrollToVirtual(this.vx, this.vy);
  }

  #visibleCol(src: number): number {
    const base = (this.cols as { base?: { fromSource?(s: number): number } }).base;
    return base?.fromSource ? base.fromSource(src) : src;
  }

  #onBodyPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.rows.count === 0 || this.cols.count === 0) return;
    if (isInteractive(e.target)) return; // a link, button or input drawn by a cell renderer handles it
    e.preventDefault(); // no text selection; focus the grid ourselves without scrolling the page
    this.scroller.focus({ preventScroll: true });
    const rect = this.body.getBoundingClientRect();
    this.#select(this.#cellAt(e.clientX, e.clientY, rect), e.shiftKey ? 'extend' : this.#isMod(e) ? 'add' : 'set');
    const drag = { x: e.clientX, y: e.clientY, raf: 0 };
    const extend = () => {
      const cell = this.#cellAt(drag.x, drag.y, rect);
      const f = this.sel.focus;
      if (cell.r !== f.r || cell.c !== f.c) this.#select(cell, 'extend');
    };
    // While the pointer is outside the body, keep scrolling toward it (faster the further out it is).
    const tick = () => {
      const dx = drag.x < rect.left ? drag.x - rect.left : drag.x > rect.right ? drag.x - rect.right : 0;
      const dy = drag.y < rect.top ? drag.y - rect.top : drag.y > rect.bottom ? drag.y - rect.bottom : 0;
      if (!dx && !dy) {
        drag.raf = 0;
        return;
      }
      this.scrollToVirtual(this.vx + dx * 0.6, this.vy + dy * 0.6);
      extend();
      drag.raf = requestAnimationFrame(tick);
    };
    const move = (ev: PointerEvent) => {
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      extend();
      if (!drag.raf) drag.raf = requestAnimationFrame(tick);
    };
    const up = () => {
      cancelAnimationFrame(drag.raf);
      this.body.removeEventListener('pointermove', move);
      this.body.removeEventListener('pointerup', up);
      this.body.removeEventListener('pointercancel', up);
    };
    this.body.setPointerCapture(e.pointerId);
    this.body.addEventListener('pointermove', move);
    this.body.addEventListener('pointerup', up);
    this.body.addEventListener('pointercancel', up);
  };

  /** A click on a sort or filter control (headers and corner). Returns true when it was one. */
  #handleControlClick(e: MouseEvent): boolean {
    const filterBtn = closest(e.target, '.vg-filterbtn');
    if (filterBtn?.dataset.filterKey) {
      void this.openFilter(parseViewKeyId(filterBtn.dataset.filterKey), filterBtn);
      return true;
    }
    const sortBtn = closest(e.target, '.vg-sortbtn');
    if (sortBtn?.dataset.sortKey) {
      void this.toggleSort(parseViewKeyId(sortBtn.dataset.sortKey), e.shiftKey);
      return true;
    }
    return false;
  }

  #onCornerClick = (e: MouseEvent): void => {
    // No preventDefault on checkboxes: the browser would undo the state drawn here after the event.
    if (closest(e.target, '.vg-check')) {
      this.toggleAllRows();
      return;
    }
    if (this.#handleControlClick(e)) return;
    this.scroller.focus({ preventScroll: true });
    this.selectAll();
  };

  // Header click: a group label toggles its group; any other header selects its rows/columns.
  // With Shift (extend) or Ctrl/Cmd (add), group labels select their rows/columns too.
  #onHeadClick = (e: MouseEvent): void => {
    if (this.#suppressHeadClick) {
      this.#suppressHeadClick = false; // the click that ends a column drag
      return;
    }
    const check = closest(e.target, '.vg-check');
    if (check && e.currentTarget === this.rowHead) {
      const range = closest(check, '.vg-seg')?.dataset.range;
      if (range) this.toggleRow(Number(range.split(':')[0]), e.shiftKey);
      this.scroller.focus({ preventScroll: true });
      return;
    }
    if (!(e.target instanceof Element) || e.target.closest('.vg-grip') || isInteractive(e.target)) return;
    if (this.#handleControlClick(e)) return;
    const extend = e.shiftKey;
    const add = this.#isMod(e);
    const toggle = closest(e.target, '[data-toggle]');
    if (toggle?.dataset.toggle && !extend && !add && this.o.expandable) {
      const [axis, level, group] = toggle.dataset.toggle.split(':');
      this.toggleGroup(axis as AxisName, Number(level), Number(group));
      return;
    }
    const seg = closest(e.target, '.vg-seg');
    if (!seg?.dataset.range) return;
    const [a, b] = seg.dataset.range.split(':').map(Number);
    this.scroller.focus({ preventScroll: true });
    this.#selectLines(e.currentTarget === this.rowHead ? 'rows' : 'cols', a, b, extend ? 'extend' : add ? 'add' : 'set');
  };

  #onHeadPointerDown = (e: PointerEvent): void => {
    const grip = closest(e.target, '.vg-grip');
    if (!grip) {
      this.#startColumnDrag(e);
      return;
    }
    const col = Number(grip.parentElement?.dataset.item);
    if (!Number.isFinite(col)) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = this.cols.sizeOf(col);
    grip.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => this.setColumnWidth(col, startW + ev.clientX - startX);
    const up = () => {
      const width = this.cols.sizeOf(col);
      if (width !== startW) {
        const source = this.colSource(col);
        this.o.onColumnResize?.({ column: source, key: this.model.keyOf?.(source), width });
      }
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  };

  /** Drag a column header to another place: a line shows where it will go; Escape cancels. */
  #startColumnDrag(e: PointerEvent): void {
    if (e.button !== 0 || closest(e.target, '.vg-sortbtn, .vg-filterbtn') || isInteractive(e.target)) return;
    const seg = closest(e.target, '.vg-seg');
    if (!seg?.dataset.move || !seg.dataset.range) return;
    const from = Number(seg.dataset.range.split(':')[0]);
    const head = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    let line: HTMLDivElement | null = null;
    let to = from;
    const target = (clientX: number): number => {
      const rect = this.body.getBoundingClientRect();
      const lx = clamp(clientX - rect.left, 0, Math.max(0, this.bodyW - 1));
      const pin = this.#pinWidth();
      const rx = this.#rightX();
      const pane = this.#paneOf(from);
      const rbase = this.cols.offsetOf(this.pinR.first);
      // Pinned columns move within their pane, the others between the panes.
      const px = pane === this.pinL ? Math.min(lx, pin - 1) : pane ? Math.max(lx, rx) - rx + rbase : clamp(lx, pin, Math.max(pin, rx - 1)) + this.vx;
      const c = this.cols.indexAt(px);
      const mid = this.cols.offsetOf(c) + this.cols.sizeOf(c) / 2;
      let slot = px > mid ? c + 1 : c; // insert before `slot`
      const [m0, m1] = this.#middle();
      slot = pane ? clamp(slot, pane.first, pane.first + pane.count) : clamp(slot, m0, m1 + 1);
      // Line position (viewport x) at the boundary before `slot`.
      const edge = this.cols.offsetOf(slot);
      const x = this.rowHeaderWidth + (pane === this.pinL ? edge : pane ? rx + edge - rbase : clamp(edge - this.vx, pin, rx));
      if (line) line.style.transform = `translate3d(${x - 1}px,0,0)`;
      return slot > from ? slot - 1 : slot;
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!line) {
        if (Math.abs(ev.clientX - startX) < 6) return;
        // Capture only once it is a drag: capturing on press would send a plain click to the header container.
        if (head.isConnected) head.setPointerCapture(e.pointerId);
        line = div('vg-dropline', this.viewport);
        seg.classList.add('vg-dragging');
        this.host.classList.add('vg-moving');
      }
      to = target(ev.clientX);
    };
    const finish = (apply: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      if (!line) return;
      line.remove();
      line = null;
      seg.classList.remove('vg-dragging');
      this.host.classList.remove('vg-moving');
      this.#suppressHeadClick = true;
      setTimeout(() => { this.#suppressHeadClick = false; }, 0);
      if (apply && to !== from) this.moveColumn(from, to);
    };
    const up = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) finish(true); };
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) finish(false); };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        finish(false);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
  }

  // ---------------------------------------------------------------- selection

  /** Current selection in visible coordinates. */
  getSelection(): Selection {
    return { active: { ...this.sel.active }, ranges: this.sel.ranges.map((g) => ({ ...g })) };
  }

  /** Set the selection (visible coordinates); the first range's top-left becomes active unless given. */
  setSelection({ active, ranges }: { active?: CellPosition; ranges?: SelectionRange[] }): void {
    this.#followSeq++;
    this.#userSelected = true;
    const list = (ranges ?? []).map((g) => this.#clampRange(g));
    const a = this.#clampCell(active ?? (list[0] ? { r: list[0].r0, c: list[0].c0 } : { r: 0, c: 0 }));
    this.sel = { active: a, anchor: a, focus: a, ranges: list.length ? list : [rangeOf(a, a)] };
    this.#selectionChanged();
  }

  selectAll(): void {
    if (this.o.selection !== 'multi') return;
    this.#userSelected = true;
    const last = { r: this.rows.count - 1, c: this.cols.count - 1 };
    this.sel = { active: this.sel.active, anchor: { r: 0, c: 0 }, focus: last, ranges: [{ r0: 0, c0: 0, r1: last.r, c1: last.c }] };
    this.#selectionChanged();
  }

  /** Active cell, its text (if loaded), and the selection size. */
  selectionInfo(): SelectionInfo {
    const { active, ranges } = this.sel;
    const g = ranges[ranges.length - 1];
    const info: SelectionInfo = { active: { ...active }, text: this.cellText(active.r, active.c), ranges: ranges.length, rows: g.r1 - g.r0 + 1, cols: g.c1 - g.c0 + 1, cells: cellCount(ranges) };
    if (this.#moveReason) info.moved = this.#moveReason;
    return info;
  }

  /** Text shown in a visible cell (a merged cell shows its own value), or undefined if not loaded. */
  cellText(r: number, c: number): string | undefined {
    const p = pieceAt(this.#pieces, r, c);
    if (p) return p.merge.label ?? this.#textOf(this.#valueBySource(p.merge.r0, p.merge.c0), p.merge.r0, p.merge.c0);
    const rs = this.rowSource(r);
    const cs = this.colSource(c);
    return rs < 0 || cs < 0 ? '' : this.#textOf(this.#valueBySource(rs, cs), rs, cs);
  }

  /** The raw value of a visible cell (undefined while not loaded). */
  cellValue(r: number, c: number): unknown {
    const p = pieceAt(this.#pieces, r, c);
    if (p) return p.merge.label ?? this.#valueBySource(p.merge.r0, p.merge.c0);
    const rs = this.rowSource(r);
    const cs = this.colSource(c);
    return rs < 0 || cs < 0 ? null : this.#valueBySource(rs, cs);
  }

  #valueBySource(rs: number, cs: number): unknown {
    const cache = this.cache;
    return lookupCell((k) => cache.get(k) as CellBlock | undefined, rs, cs, this.o.blockRows, this.o.blockCols);
  }

  #clampCell({ r, c }: CellPosition): CellPosition {
    return { r: clamp(Math.floor(r), 0, Math.max(0, this.rows.count - 1)), c: clamp(Math.floor(c), 0, Math.max(0, this.cols.count - 1)) };
  }

  #clampRange(g: SelectionRange): SelectionRange {
    const a = this.#clampCell({ r: Math.min(g.r0, g.r1), c: Math.min(g.c0, g.c1) });
    const b = this.#clampCell({ r: Math.max(g.r0, g.r1), c: Math.max(g.c0, g.c1) });
    return { r0: a.r, c0: a.c, r1: b.r, c1: b.c };
  }

  /** Keep the selection inside the grid after its size changed. */
  #clampSelection(): void {
    this.sel = {
      active: this.#clampCell(this.sel.active),
      anchor: this.#clampCell(this.sel.anchor),
      focus: this.#clampCell(this.sel.focus),
      ranges: this.sel.ranges.map((g) => this.#clampRange(g)),
    };
  }

  /** mode: 'set' (new selection), 'add' (extra range), 'extend' (move the focus corner of the last range). */
  #select(cell: CellPosition, mode: SelectMode): void {
    this.#followSeq++; // the user moved on: a pending "follow the row" must not move the selection back
    this.#userSelected = true;
    if (this.o.selection !== 'multi') mode = 'set';
    const target = this.#clampCell(cell);
    if (mode === 'extend') {
      this.sel.focus = target;
      this.sel.ranges[this.sel.ranges.length - 1] = rangeOf(this.sel.anchor, target);
    } else {
      // Keep the cell that was clicked, even inside a merged cell: the outline still covers the whole
      // merged cell, but the view does not jump to its top-left and arrow keys leave from this row/column.
      this.sel.active = target;
      this.sel.anchor = target;
      this.sel.focus = target;
      const range = rangeOf(target, target);
      if (mode === 'add') this.sel.ranges.push(range);
      else this.sel.ranges = [range];
    }
    this.#selectionChanged();
  }

  #selectionChanged(): void {
    this.#activeRow = null;
    this.#noteActiveRow();
    this.#render(true);
    this.o.onSelectionChange?.(this.selectionInfo());
    this.#moveReason = undefined;
  }

  /** Scroll the least amount needed to show a cell (just that cell, even inside a large merged cell). */
  #reveal({ r, c }: CellPosition): void {
    const top = this.rows.offsetOf(r);
    const bottom = this.rows.offsetOf(r + 1);
    const left = this.cols.offsetOf(c);
    const right = this.cols.offsetOf(c + 1);
    let y = this.vy;
    let x = this.vx;
    if (top < y || bottom - top > this.bodyH) y = top;
    else if (bottom > y + this.bodyH) y = bottom - this.bodyH;
    // Pinned columns are always in view; other columns must not end up beneath them.
    if (!this.#paneOf(c)) {
      const pin = this.#pinWidth();
      const end = this.bodyW - this.#pinWidthRight(); // the right pane starts here when scrolled
      if (left - pin < x || right - left > end - pin) x = left - pin;
      else if (right > x + end) x = right - end;
    }
    if (x !== this.vx || y !== this.vy) this.scrollToVirtual(x, y);
  }

  #move(dr: number, dc: number, extend: boolean, jump: boolean): void {
    const from = extend ? this.sel.focus : this.sel.active;
    // Moving the active cell steps over a merged cell; extending a range moves one row/column at a time.
    const p = extend ? null : pieceAt(this.#pieces, from.r, from.c);
    let { r, c } = from;
    if (jump) {
      if (dr) r = dr < 0 ? 0 : this.rows.count - 1;
      if (dc) c = dc < 0 ? 0 : this.cols.count - 1;
    } else {
      // Step off the far edge of a merged cell, not just to the next cell inside it.
      if (dr > 0) r = (p ? this.#farEdge(p, 'rows', 1) : r) + 1;
      else if (dr < 0) r = (p ? this.#farEdge(p, 'rows', -1) : r) - 1;
      if (dc > 0) c = (p ? this.#farEdge(p, 'cols', 1) : c) + 1;
      else if (dc < 0) c = (p ? this.#farEdge(p, 'cols', -1) : c) - 1;
    }
    this.#goTo({ r, c }, extend);
  }

  /**
   * A merged cell's far edge (visible index) in one direction. Its piece is clipped to the drawn rows and
   * columns, so a tall or wide merge goes on past them: follow it to its end in the source, as long as the
   * visible items in between show its source items one to one (no collapsed group or total in between).
   */
  #farEdge(p: MergePiece, axis: AxisName, dir: 1 | -1): number {
    const rows = axis === 'rows';
    const edge = rows ? (dir > 0 ? p.vr1 : p.vr0) : (dir > 0 ? p.vc1 : p.vc0);
    const m = p.merge;
    const end = rows ? (dir > 0 ? m.r1 : m.r0) : (dir > 0 ? m.c1 : m.c0);
    const src = rows ? this.rowSource(edge) : this.colSource(edge);
    if (src < 0 || src === end) return edge;
    const [v, exact] = this.model.visibleOf ? this.model.visibleOf(axis, end) : [rows ? end : this.#visibleCol(end), true];
    const count = rows ? this.rows.count : this.cols.count;
    return exact && v >= 0 && v < count && v - edge === end - src ? v : edge;
  }

  #goTo(cell: CellPosition, extend: boolean): void {
    const target = this.#clampCell(cell);
    this.#reveal(target); // draws the area first, so merged cells there are known
    this.#select(target, extend ? 'extend' : 'set');
    this.#reveal(extend ? this.sel.focus : this.sel.active);
  }

  #page(dir: number, extend: boolean): void {
    const from = extend ? this.sel.focus : this.sel.active;
    const y0 = this.rows.offsetOf(from.r);
    const r = this.rows.indexAt(clamp(y0 + dir * this.bodyH, 0, Math.max(0, this.rows.total - 1)));
    this.scrollToVirtual(this.vx, this.vy + (this.rows.offsetOf(r) - y0)); // keep the cell at the same height on screen
    this.#select({ r, c: from.c }, extend ? 'extend' : 'set');
    this.#reveal(extend ? this.sel.focus : this.sel.active);
  }

  /** Enter: inside a multi-cell selection, move the active cell through it (down, then next column). */
  #cycle(dir: number): void {
    const { ranges } = this.sel;
    const g = ranges[ranges.length - 1];
    const justActive = isActiveOnly(this.#pieces, g, this.sel.active);
    if (ranges.length !== 1 || justActive) {
      this.#move(dir, 0, false, false);
      return;
    }
    let { r, c } = this.sel.active;
    for (let guard = 0; guard < 10_000; guard++) {
      const p = pieceAt(this.#pieces, r, c);
      r = dir > 0 ? (p ? this.#farEdge(p, 'rows', 1) : r) + 1 : (p ? this.#farEdge(p, 'rows', -1) : r) - 1;
      if (r > g.r1) {
        r = g.r0;
        c = c + 1 > g.c1 ? g.c0 : c + 1;
      }
      if (r < g.r0) {
        r = g.r1;
        c = c - 1 < g.c0 ? g.c1 : c - 1;
      }
      const q = pieceAt(this.#pieces, r, c);
      // Skip cells hidden under a merged cell; its first cell inside the range stands for it.
      if (!q || (Math.max(q.vr0, g.r0) === r && Math.max(q.vc0, g.c0) === c)) break;
    }
    this.sel.active = { r, c };
    this.#reveal(this.sel.active);
    this.#selectionChanged();
  }

  #toggleGroupAtActive(axis: AxisName, expand: boolean): void {
    const fn = expand ? this.model.expandTarget : this.model.collapseTarget;
    if (typeof fn !== 'function') return;
    const t = fn.call(this.model, axis, axis === 'rows' ? this.sel.active.r : this.sel.active.c);
    if (!t) return;
    this.toggleGroup(axis, t.level, t.group);
    this.#reveal(this.sel.active);
  }

  /** Whole rows (axis 'rows') or columns a..b. */
  #selectLines(axis: AxisName, a: number, b: number, mode: SelectMode): void {
    this.#userSelected = true;
    const last = { r: this.rows.count - 1, c: this.cols.count - 1 };
    const win = this.#win ?? { firstRow: 0, firstCol: 0 };
    if (mode === 'extend') {
      const from = axis === 'rows' ? this.sel.anchor.r : this.sel.anchor.c;
      const lo = Math.min(from, a);
      const hi = Math.max(from, b);
      this.sel.focus = axis === 'rows' ? { r: hi, c: last.c } : { r: last.r, c: hi };
      this.sel.ranges[this.sel.ranges.length - 1] = axis === 'rows' ? { r0: lo, c0: 0, r1: hi, c1: last.c } : { r0: 0, c0: lo, r1: last.r, c1: hi };
    } else {
      // The active cell goes to the first visible cell of the line, so the view does not jump.
      const active = axis === 'rows' ? { r: a, c: win.firstCol } : { r: win.firstRow, c: a };
      const range = axis === 'rows' ? { r0: a, c0: 0, r1: b, c1: last.c } : { r0: 0, c0: a, r1: last.r, c1: b };
      this.sel.active = active;
      this.sel.anchor = active;
      this.sel.focus = active;
      if (mode === 'add') this.sel.ranges.push(range);
      else this.sel.ranges = [range];
    }
    this.#selectionChanged();
  }

  #captureSelection(): SelectionSnapshot {
    const anchorOf = (axis: AxisName, i: number) => (this.model.anchorOf ? this.model.anchorOf(axis, i) : i);
    const pt = ({ r, c }: CellPosition): [number, number] => [anchorOf('rows', r), anchorOf('cols', c)];
    const { active, anchor, focus, ranges } = this.sel;
    return {
      active: pt(active),
      anchor: pt(anchor),
      focus: pt(focus),
      ranges: ranges.map((g) => [anchorOf('rows', g.r0), anchorOf('cols', g.c0), this.rowSource(g.r1), this.colSource(g.c1)]),
    };
  }

  #restoreSelection(snap: SelectionSnapshot): void {
    const vis = (axis: AxisName, src: number) => (this.model.visibleOf ? this.model.visibleOf(axis, src)[0] : src);
    const pt = ([rs, cs]: [number, number]) => this.#clampCell({ r: vis('rows', rs), c: vis('cols', cs) });
    this.sel = {
      active: pt(snap.active),
      anchor: pt(snap.anchor),
      focus: pt(snap.focus),
      ranges: snap.ranges.map(([a, b, c, d]) => this.#clampRange({ r0: vis('rows', a), c0: vis('cols', b), r1: vis('rows', c), c1: vis('cols', d) })),
    };
  }

  #renderSelection(r0: number, r1: number, c0: number, c1: number): void {
    const { rows, cols } = this;
    const rect = (a0: number, a1: number, b0: number, b1: number): SelectionBox | null => {
      const ra = Math.max(a0, r0);
      const rb = Math.min(a1, r1);
      const ca = Math.max(b0, c0);
      const cb = Math.min(b1, c1);
      if (ra > rb || ca > cb) return null;
      const top = rows.offsetOf(ra);
      const left = cols.offsetOf(ca);
      const edges = `${ra === a0 ? 1 : 0}${cb === b1 ? 1 : 0}${rb === a1 ? 1 : 0}${ca === b0 ? 1 : 0}`;
      return { x: left - this.anchorColPx, y: top - this.anchorRowPx, w: cols.offsetOf(cb + 1) - left, h: rows.offsetOf(rb + 1) - top, edges };
    };
    this.#noteActiveRow();
    const { active, ranges } = this.sel;
    const activeRange = cellRange(this.#pieces, active);
    const single = ranges.length === 1 && isActiveOnly(this.#pieces, ranges[0], active);
    const [m0, m1] = this.#middle();
    // Pinned columns have their own selection layers; a range across a pane boundary is drawn in parts, with
    // no border where they meet.
    const paneRect = (pane: PinPane, a0: number, a1: number, b0: number, b1: number): SelectionBox | null => {
      const ra = Math.max(a0, r0);
      const rb = Math.min(a1, r1);
      const ca = Math.max(b0, pane.first);
      const cb = Math.min(b1, pane.first + pane.count - 1);
      if (ra > rb || ca > cb) return null;
      const top = rows.offsetOf(ra);
      const left = cols.offsetOf(ca);
      const edges = `${ra === a0 ? 1 : 0}${cb === b1 ? 1 : 0}${rb === a1 ? 1 : 0}${ca === b0 ? 1 : 0}`;
      return { x: left - pane.base, y: top - this.anchorRowPx, w: cols.offsetOf(cb + 1) - left, h: rows.offsetOf(rb + 1) - top, edges };
    };
    const mainRect = (a0: number, a1: number, b0: number, b1: number): SelectionBox | null => {
      if (b1 < m0 || b0 > m1) return null;
      const box = rect(a0, a1, Math.max(b0, m0), Math.min(b1, m1));
      if (box && (b0 < m0 || b1 > m1)) {
        const e = box.edges;
        box.edges = `${e[0]}${b1 > m1 ? 0 : e[1]}${e[2]}${b0 < m0 ? 0 : e[3]}`;
      }
      return box;
    };
    const boxes = single ? [] : ranges.map((g) => mainRect(g.r0, g.r1, g.c0, g.c1));
    const act = mainRect(activeRange.r0, activeRange.r1, activeRange.c0, activeRange.c1);
    this.selLayer.render(boxes, act);
    for (const pane of this.#panes()) {
      if (!pane.count) continue;
      const paneBoxes = single ? [] : ranges.map((g) => paneRect(pane, g.r0, g.r1, g.c0, g.c1));
      pane.sel.render(paneBoxes, paneRect(pane, activeRange.r0, activeRange.r1, activeRange.c0, activeRange.c1));
    }

    // Screen readers: point the grid at the element that shows the active cell.
    let el: HTMLElement | null | undefined = null;
    const p = pieceAt(this.#pieces, active.r, active.c);
    const pane = this.#paneOf(active.c);
    if (p) el = this.pinL.merges.live.get(p.key)?.el ?? this.pinR.merges.live.get(p.key)?.el ?? this.mergeLayer.live.get(p.key)?.el;
    else if (pane) {
      const slot = pane.slots[active.r % this.N];
      el = slot?.r === active.r ? slot.cells[active.c - pane.first]?.el : null;
    } else if (act) el = this.rowSlots[active.r % this.N]?.cells[active.c % this.M]?.el;
    if (el && !el.id) el.id = `${this.#uid}-${++this.#idSeq}`;
    const id = el ? el.id : '';
    if (id !== this.#activeId) {
      if (id) this.scroller.setAttribute('aria-activedescendant', id);
      else this.scroller.removeAttribute('aria-activedescendant');
      this.#activeId = id;
    }
  }

  // ---------------------------------------------------------------- copy

  /**
   * Copy the selection to the clipboard as tab-separated text plus an HTML table. Cells that are not
   * loaded are fetched first (batched gather requests). Reports through `onCopy(info)` and resolves with
   * the same info.
   */
  copySelection(): Promise<CopyInfo> {
    const started = performance.now();
    const ranges = this.sel.ranges.map((g) => ({ ...g }));
    const last = ranges[ranges.length - 1];
    const base = { cells: cellCount(ranges), ranges: ranges.length, rows: last.r1 - last.r0 + 1, cols: last.c1 - last.c0 + 1, fetched: 0 };
    const report = (info: Partial<CopyInfo> & { ok: boolean }): CopyInfo => {
      const out: CopyInfo = { ...base, ms: Math.round(performance.now() - started), ...info };
      this.o.onCopy?.(out);
      // Built-in feedback (notices: false leaves it to onCopy).
      this.notify(out.ok ? this.msg.copied(out) : out.reason ?? '', !out.ok && !out.retry);
      return out;
    };
    if (base.cells > MAX_COPY_CELLS) {
      return Promise.resolve(report({ ok: false, reason: this.msg.copyTooLarge(base.cells, MAX_COPY_CELLS) }));
    }

    // Merged cells belong to the unsorted layout (see #render).
    const merges = this.sortParam || this.filterParam || this.#serverColFilter ? null : this.merges;
    const { model } = this;
    const plans = ranges.map((g) => planCopy(g, {
      rowSource: this.rowSource,
      colSource: this.colSource,
      rowExact: model.rowExact?.bind(model),
      colExact: model.colExact?.bind(model),
      merges,
    }));
    const missing = new Map<number, Set<number>>(); // row source -> column sources not loaded
    forEachNeededCell(plans, (rs, cs) => {
      if (rs < 0 || cs < 0 || this.#copyValue(rs, cs) !== undefined) return;
      let set = missing.get(rs);
      if (!set) missing.set(rs, (set = new Set()));
      set.add(cs);
    });
    const build = () => this.#buildCopy(plans);

    if (missing.size === 0) {
      const out = build();
      const ok = writeClipboardNow(out.text, out.html);
      return Promise.resolve(report(ok ? { ok: true, text: out.text } : { ok: false, reason: this.msg.copyRefused, text: out.text }));
    }

    // Some cells must be loaded first. Hand the clipboard a promise now, while the key press still
    // counts as a user action (Safari requires that; Chromium accepts it), and fill it when the data is in.
    let fetchedCells = 0;
    this.notify(this.msg.copying(base.cells));
    const pending = this.#fetchForCopy(missing).then((n) => {
      fetchedCells = n;
      return build();
    });
    let write: Promise<void>;
    try {
      write = navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': pending.then((o) => new Blob([o.text], { type: 'text/plain' })),
          'text/html': pending.then((o) => new Blob([o.html], { type: 'text/html' })),
        }),
      ]);
    } catch (err) {
      write = Promise.reject(err);
    }
    return write.then(
      () => pending.then((o) => report({ ok: true, text: o.text, fetched: fetchedCells })),
      async (err: unknown) => {
        let out;
        try {
          out = await pending;
        } catch (loadErr) {
          return report({ ok: false, reason: this.msg.copyLoadFailed(errorMessage(loadErr)) });
        }
        // Fallback: plain text only (may still be refused once the key press is too long ago). The
        // values stay in the copy cache, so pressing the shortcut again copies instantly.
        try {
          await navigator.clipboard.writeText(out.text);
          return report({ ok: true, text: out.text, fetched: fetchedCells, plainOnly: true });
        } catch {
          return report({ ok: false, retry: true, fetched: fetchedCells, reason: this.msg.copyAgain(fetchedCells, this.isMac ? '⌘C' : 'Ctrl+C'), cause: errorMessage(err) });
        }
      },
    );
  }

  #buildCopy(plans: CopyPlan[]): { text: string; html: string } {
    return buildCopy(plans, (rs, cs) => this.#textOf(this.#copyValue(rs, cs), rs, cs));
  }

  #copyValue(rs: number, cs: number): unknown {
    return this.#valueBySource(rs, cs) ?? this.#view?.copyCache.get(`${rs}:${cs}`);
  }

  /** Loads the missing cells with batched gather requests (or blocks without gather). Resolves with the count. */
  async #fetchForCopy(missing: Map<number, Set<number>>): Promise<number> {
    const view = this.#view!;
    const ctx: FetchContext = { query: this.query, sort: this.sortParam, filter: this.filterParam, colfilter: this.#serverColFilter };
    let count = 0;
    const take = (r0: number, c0: number, nr: number, nc: number, cells: unknown[]) => {
      const cc = view.copyCache;
      for (let i = 0; i < nr; i++) {
        for (let j = 0; j < nc; j++) {
          if (cc.size >= COPY_CACHE_MAX) cc.delete(cc.keys().next().value as string);
          cc.set(`${r0 + i}:${c0 + j}`, cells[i * nc + j]);
        }
      }
      count += nr * nc;
    };
    const fetchGather = this.o.fetchGather;
    if (fetchGather) {
      const batches = batchRects(coalesceRects(missing));
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const b = batches[next++];
          const res = await fetchGather({ ...ctx, rects: b });
          const arrays = Array.isArray(res) ? res : res.cells;
          if (!Array.isArray(res) && !ctx.sort && !ctx.filter) this.merges.addServer(res.merges);
          b.forEach((rect, i) => take(rect[0], rect[1], rect[2], rect[3], arrays[i]));
        }
      };
      await Promise.all(Array.from({ length: COPY_CONCURRENCY }, worker));
    } else {
      const { blockRows: BR, blockCols: BC } = this.o;
      const blocks = new Set<string>();
      for (const [rs, cols] of missing) for (const cs of cols) blocks.add(blockKey(Math.floor(rs / BR), Math.floor(cs / BC)));
      const rowCount = this.model.rowSourceCount ?? this.rows.count;
      const colCount = this.model.colSourceCount ?? this.cols.count;
      for (const key of blocks) {
        const [br, bc] = key.split(':').map(Number);
        const r0 = br * BR;
        const c0 = bc * BC;
        const nr = Math.min(BR, rowCount - r0);
        const nc = Math.min(BC, colCount - c0);
        const res = await this.o.fetchBlock({ ...ctx, r0, c0, nr, nc });
        take(r0, c0, nr, nc, Array.isArray(res) ? res : res.cells);
      }
    }
    return count;
  }

  // ---------------------------------------------------------------- rendering

  /** Empty state: "No rows match the filter" / "No rows", or what renderEmpty draws. */
  #renderEmpty(empty: boolean): void {
    const emptySig = empty ? (this.filterParam || this.colFilterParam ? 'filtered' : 'empty') : '';
    if (emptySig !== this.#emptySig) {
      this.#emptySig = emptySig;
      // A renderer that returned a cleanup owns what it drew (React removes its own nodes); otherwise clear it here.
      if (this.emptyCleanup) this.emptyCleanup();
      else this.emptyEl.textContent = '';
      this.emptyCleanup = null;
      if (emptySig) {
        const filtered = emptySig === 'filtered';
        if (this.o.renderEmpty) {
          const out = this.o.renderEmpty(this.emptyEl, { filtered });
          this.emptyCleanup = typeof out === 'function' ? out : null;
        } else {
          this.emptyEl.textContent = filtered ? this.msg.noRows : this.msg.noData;
        }
      }
      this.emptyEl.hidden = !emptySig;
    }
    if (empty !== this.#emptyShown) {
      this.#emptyShown = empty;
      for (const layer of [this.bodyLayer, this.mergeLayerEl, this.selLayerEl, this.rowHeadLayer, this.pinL.layer, this.pinL.mergeEl, this.pinR.layer, this.pinR.mergeEl]) layer.style.visibility = empty ? 'hidden' : '';
    }
  }

  #render(force = false): void {
    const { N, M, rows, cols, model } = this;
    // Nothing to draw (e.g. a filter matched no rows): show a message instead of stale rows.
    this.#renderEmpty(N === 0 || M === 0);
    // No rows but some columns: still draw the column headers (the body layers stay hidden).
    if (M === 0) return;
    const { vx, vy } = this;
    if (!force && vx === this.rendered.vx && vy === this.rendered.vy) return;
    const t0 = performance.now();
    const { overscanRows, overscanCols, blockRows: BR, blockCols: BC } = this.o;

    if (!Number.isNaN(this.rendered.vy) && vy !== this.rendered.vy) this.dirY = Math.sign(vy - this.rendered.vy);
    if (!Number.isNaN(this.rendered.vx) && vx !== this.rendered.vx) this.dirX = Math.sign(vx - this.rendered.vx);

    // Window of rows/columns to draw: exactly N rows and M columns, biased toward the scroll direction.
    const firstRow = rows.indexAt(vy);
    const lastRow = Math.max(firstRow, rows.indexAt(vy + this.bodyH - 1));
    let r0 = this.dirY > 0 ? firstRow - 1 : this.dirY < 0 ? lastRow + 2 - N : firstRow - overscanRows;
    r0 = clamp(r0, 0, rows.count - N);
    const r1 = r0 + N - 1;

    const firstCol = cols.indexAt(vx);
    const lastCol = Math.max(firstCol, cols.indexAt(vx + this.bodyW - 1));
    let c0 = this.dirX > 0 ? firstCol - 1 : this.dirX < 0 ? lastCol + 2 - M : firstCol - overscanCols;
    c0 = clamp(c0, 0, cols.count - M);
    const c1 = c0 + M - 1;

    // Rebase anchors so element offsets stay small, then move whole layers with one transform each.
    const r0px = rows.offsetOf(r0);
    if (this.anchorRow === null || Math.abs(r0px - this.anchorRowPx) > REBASE_PX) {
      this.anchorRow = r0;
      this.anchorRowPx = r0px;
      for (const slot of this.#allSlots()) slot.r = -1;
    }
    const c0px = cols.offsetOf(c0);
    if (this.anchorCol === null || Math.abs(c0px - this.anchorColPx) > REBASE_PX) {
      this.anchorCol = c0;
      this.anchorColPx = c0px;
      for (const slot of this.#allSlots()) for (const cell of slot.cells) cell.c = -1;
    }
    const ox = vx - this.anchorColPx;
    const oy = vy - this.anchorRowPx;
    // Cells, merged cells and the selection overlay share one coordinate space, so all three move together.
    const bodyShift = `translate3d(${-ox}px,${-oy}px,0)`;
    this.bodyLayer.style.transform = bodyShift;
    this.mergeLayerEl.style.transform = bodyShift;
    this.selLayerEl.style.transform = bodyShift;
    this.colHeadLayer.style.transform = `translate3d(${-ox}px,0,0)`;
    this.rowHeadLayer.style.transform = `translate3d(0,${-oy}px,0)`;
    this.#ensurePinPool();
    for (const pane of this.#panes()) {
      if (!pane.count) {
        pane.w = 0;
        continue;
      }
      const shift = `translate3d(0,${-oy}px,0)`;
      pane.layer.style.transform = shift;
      pane.mergeEl.style.transform = shift;
      pane.selEl.style.transform = shift;
      pane.base = cols.offsetOf(pane.first);
      const sig = Array.from({ length: pane.count + 1 }, (_, j) => cols.offsetOf(pane.first + j) - pane.base).join(',');
      if (sig !== pane.sig) {
        pane.sig = sig;
        for (const slot of pane.slots) for (const cell of slot.cells) cell.c = -1;
      }
      const w = cols.offsetOf(pane.first + pane.count) - pane.base;
      const x = pane.right ? this.#rightX() : 0;
      if (w !== pane.w || x !== pane.x) {
        pane.w = w;
        pane.x = x;
        this.host.style.setProperty(pane.right ? '--vg-pinr-w' : '--vg-pin-w', `${w}px`);
        if (pane.right) this.host.style.setProperty('--vg-pinr-x', `${x}px`);
      }
    }

    const xs = this.#xs;
    const ws = this.#ws;
    const colSrc = this.#colSrc;
    const kinds = this.#kinds;
    const infos = this.#infos;
    let x = c0px - this.anchorColPx;
    for (let k = 0; k < M; k++) {
      const w = cols.sizeOf(c0 + k);
      xs[k] = x;
      ws[k] = w;
      colSrc[k] = this.colSource(c0 + k);
      this.#colExact[k] = model.colExact ? (model.colExact(c0 + k) ? 1 : 0) : 1;
      const info = this.#infoOf(colSrc[k]);
      infos[k] = info;
      kinds[k] = model.colKind(c0 + k) + info.cls;
      x += w;
    }
    const rowSrc = this.#rowSrc;
    for (let r = r0; r <= r1; r++) {
      rowSrc[r - r0] = this.rowSource(r);
      this.#rowExact[r - r0] = model.rowExact ? (model.rowExact(r) ? 1 : 0) : 1;
    }

    // Cache lookups are memoized per frame (a block serves many cells).
    const frameBlocks = new Map<string, CellBlock | LabelBlock | null>();
    const block = (key: string) => {
      let b = frameBlocks.get(key);
      if (b === undefined) {
        b = this.cache.get(key) ?? null;
        frameBlocks.set(key, b);
      }
      return b;
    };
    const valueAt = (rs: number, cs: number) => lookupCell((k) => block(k) as CellBlock | null, rs, cs, BR, BC);
    const needs = new Set<string>();
    const label = (axis: AxisName, level: number, idx: number): string | undefined => {
      const key = labelKey(axis, level, idx);
      const b = (axis === 'cols' ? this.colLabels?.get(key) ?? null : block(key)) as LabelBlock | null;
      if (b) return b.names[idx - b.from];
      needs.add(key);
      return undefined;
    };

    this.#renderHeaders(r0, r1, c0, c1, ox, oy, label);
    this.#renderMerges(r0, c0, ox, oy, valueAt);
    this.#renderBody(r0, r1, c0, c1, valueAt);
    this.#renderPinned(r0, r1, valueAt);
    this.#renderSelection(r0, r1, c0, c1);

    this.rendered.vx = vx;
    this.rendered.vy = vy;
    this.#win = { r0, r1, c0, c1, firstRow, lastRow, firstCol, lastCol };
    this.#labelNeeds = needs;
    this.#scheduleFetch(firstRow, firstCol);
    if (this.#checks.length) this.#checksNotice();

    const ms = performance.now() - t0;
    const s = this.stats;
    s.renders++;
    s.renderMsEma = s.renderMsEma === 0 ? ms : s.renderMsEma * 0.9 + ms * 0.1;
    s.renderMsMax = Math.max(s.renderMsMax, ms);
  }

  /** Header segments; items (single rows/columns) that intersect the selection are highlighted. */
  #renderHeaders(r0: number, r1: number, c0: number, c1: number, ox: number, oy: number, label: (axis: AxisName, level: number, idx: number) => string | undefined): void {
    const { model, rows, cols } = this;
    const selRanges = this.sel.ranges;
    const { resizable, expandable } = this.o;
    const noSel = this.o.selection === 'none';
    const decorate = (segs: Segment[]) => {
      for (const s of segs) {
        if (s.sort && !this.#allowed('sortable', s.sort)) s.sort = undefined;
        if (s.filter && !this.#allowed('filterable', s.filter)) s.filter = undefined;
        if (!resizable) s.resizable = false;
        if (!expandable) s.toggle = undefined;
        s.selected = !noSel && s.a === s.b && selRanges.some((g) => g.c0 <= s.b && g.c1 >= s.a);
        if (s.sort) s.sortState = this.#sortStateOf(s.sort);
        if (s.filter) s.filterOn = this.#hasFilter(s.filter);
      }
      return segs;
    };
    const colSegs = decorate(model.colSegments(c0, c1, label));
    const rowSegs: Segment[] = model.rowSegments(r0, r1, label);
    const checks = this.#checksOn();
    for (const s of rowSegs) {
      if (!expandable) s.toggle = undefined;
      s.selected = !noSel && s.a === s.b && selRanges.some((g) => g.r0 <= s.b && g.r1 >= s.a);
      if (checks && s.a === s.b) s.check = this.#isChecked(s.a);
    }
    if (checks) this.#paintCornerCheck();
    this.colSpans.render(colSegs, { axis: cols, anchorPx: this.anchorColPx, viewStart: ox, lo: c0, hi: c1, bandOff: this.tierOff, labelExtent: 110 });
    for (const pane of this.#panes()) {
      if (!pane.count) continue;
      const lo = pane.first;
      const hi = pane.first + pane.count - 1;
      pane.spans.render(decorate(model.colSegments(lo, hi, label)), { axis: cols, anchorPx: pane.base, viewStart: 0, lo, hi, bandOff: this.tierOff, labelExtent: 110 });
    }
    this.rowSpans.render(rowSegs, { axis: rows, anchorPx: this.anchorRowPx, viewStart: oy, lo: r0, hi: r1, bandOff: this.rowBandOff, labelExtent: rows.minSize });
  }

  /**
   * Merged cells: split into visible pieces (a collapsed group ends a piece), drawn over the cells they
   * cover. A piece shows its merge's label or the value of the merge's top-left source cell.
   */
  #renderMerges(r0: number, c0: number, ox: number, oy: number, valueAt: (rs: number, cs: number) => unknown): void {
    const cover = this.#cover;
    const panes = this.#panes();
    const [m0, m1] = this.#middle();
    // Merged cells belong to the unsorted layout; while sorted they would join unrelated rows, so they are hidden.
    const transformed = this.sortParam || this.filterParam || this.#serverColFilter; // also columns renumbered by the server
    let pieces: MergePiece[] = [];
    const panePieces: MergePiece[][] = [[], []];
    if (transformed) {
      cover.fill(0);
      for (const pane of panes) pane.cover.fill(0);
    } else {
      // Pinned columns have their own layers, which do not scroll sideways: the body's pieces leave them out.
      let exact = this.#colExact;
      const M = exact.length;
      if (m0 > c0 || m1 < c0 + M - 1) {
        exact = this.#bodyExact;
        exact.set(this.#colExact);
        if (m0 > c0) exact.fill(0, 0, Math.min(m0 - c0, M));
        if (m1 < c0 + M - 1) exact.fill(0, Math.max(0, m1 + 1 - c0), M);
      }
      pieces = mergePieces(this.merges, r0, this.#rowSrc, this.#rowExact, c0, this.#colSrc, exact, cover);
      panes.forEach((pane, i) => {
        if (!pane.count) return void pane.cover.fill(0);
        for (let j = 0; j < pane.count; j++) {
          pane.src[j] = this.colSource(pane.first + j);
          pane.exact[j] = this.model.colExact ? (this.model.colExact(pane.first + j) ? 1 : 0) : 1;
        }
        panePieces[i] = mergePieces(this.merges, r0, this.#rowSrc, this.#rowExact, pane.first, pane.src, pane.exact, pane.cover);
      });
    }
    const drawn = [panePieces[0], pieces, panePieces[1]];
    const anchors = new Set<string>();
    for (const list of drawn) {
      for (const p of list) {
        const m = p.merge;
        if (m.label !== undefined) p.text = m.label;
        else {
          const value = valueAt(m.r0, m.c0);
          p.text = value === undefined ? undefined : this.#textOf(value, m.r0, m.c0);
        }
        if (p.text === undefined) anchors.add(`${m.r0}:${m.c0}`);
      }
    }
    // A merge crossing a pane boundary is drawn as separate pieces, each showing the value, so a part that
    // scrolls still says what it is. For selection, the keyboard and copy they are one cell.
    let logical: MergePiece[] = pieces;
    if (panePieces[0].length || panePieces[1].length) {
      logical = [];
      const open = new Map<string, number>(); // merge|rows → index in logical of a piece ending at a boundary
      for (const list of drawn) {
        for (const p of list) {
          const k = `${p.merge.key}|${p.vr0}|${p.vr1}`;
          const i = p.vc0 === m0 || p.vc0 === m1 + 1 ? open.get(k) : undefined;
          let at: number;
          if (i !== undefined && logical[i].vc1 + 1 === p.vc0) {
            logical[i] = { ...logical[i], vc1: p.vc1 };
            at = i;
          } else {
            logical.push(p);
            at = logical.length - 1;
          }
          if (p.vc1 === m0 - 1 || p.vc1 === m1) open.set(k, at);
        }
      }
    }
    // The body's labels keep clear of the left pane drawn over its left edge.
    this.mergeLayer.render(pieces, { rows: this.rows, cols: this.cols, anchorRowPx: this.anchorRowPx, anchorColPx: this.anchorColPx, ox: ox + this.pinL.w, oy });
    panes.forEach((pane, i) => pane.merges.render(panePieces[i], { rows: this.rows, cols: this.cols, anchorRowPx: this.anchorRowPx, anchorColPx: pane.base, ox: 0, oy }));
    this.#mergeAnchors = anchors;
    this.#pieces = logical;
  }

  /** Body rows: only rows whose slot changed are repositioned; only unfilled cells are written. */
  #renderBody(r0: number, r1: number, c0: number, c1: number, valueAt: (rs: number, cs: number) => unknown): void {
    const { N, M, rows, model } = this;
    const cover = this.#cover;
    const xs = this.#xs;
    const ws = this.#ws;
    const colSrc = this.#colSrc;
    const rowSrc = this.#rowSrc;
    const kinds = this.#kinds;
    const infos = this.#infos;
    const selRanges = this.sel.ranges;
    const bands = model.rowBands.length;
    const tiers = model.colTiers.length;
    const checks = this.#checksOn();
    const [m0, m1] = this.#middle();
    let rowWrites = 0;
    let cellWrites = 0;
    for (let r = r0; r <= r1; r++) {
      const slot = this.rowSlots[r % N];
      if (slot.r !== r) {
        slot.r = r;
        slot.el.style.transform = `translate3d(0,${rows.offsetOf(r) - this.anchorRowPx}px,0)`;
        const h = rows.sizeOf(r);
        if (h !== slot.h) {
          slot.el.style.height = `${h}px`;
          slot.el.style.lineHeight = `${h}px`;
          slot.h = h;
        }
        slot.el.setAttribute('aria-rowindex', String(r + 1 + tiers));
        for (const cell of slot.cells) cell.filled = false;
        rowWrites++;
      }
      const cls = `vg-row${model.rowKind(r)}${checks && this.#isChecked(r) ? ' vg-checked' : ''}`;
      if (cls !== slot.cls) {
        slot.el.className = cls;
        slot.cls = cls;
      }
      const rs = rowSrc[r - r0];
      const coverRow = (r - r0) * M;
      for (let c = c0; c <= c1; c++) {
        const cell = slot.cells[c % M];
        const k = c - c0;
        // Under a merged cell, or a pinned column (drawn in its own layer): hidden.
        const covered = cover[coverRow + k] || (c < m0 || c > m1 ? 1 : 0); // pinned: drawn in a pane
        if (covered !== cell.covered) {
          cell.el.style.visibility = covered ? 'hidden' : '';
          cell.covered = covered;
        }
        const selected = inRanges(selRanges, r, c);
        if (selected !== cell.selected) {
          cell.el.setAttribute('aria-selected', selected ? 'true' : 'false');
          cell.selected = selected;
        }
        let clsDirty = false;
        if (cell.c !== c) {
          cell.c = c;
          cell.el.setAttribute('aria-colindex', String(c + 1 + bands));
          cell.el.style.transform = `translate3d(${xs[k]}px,0,0)`;
          cell.el.style.width = `${ws[k]}px`;
          cell.base = `vg-cell${kinds[k]}`;
          cell.filled = false;
          clsDirty = true;
        }
        if (!cell.filled) {
          const cs = colSrc[k];
          const value = rs < 0 || cs < 0 ? null : valueAt(rs, cs);
          if (value !== undefined) {
            const extra = rs < 0 || cs < 0 ? this.#fillBlank(cell) : this.#fillCell(cell, infos[k]!, r, c, rs, cs, value);
            if (extra !== cell.extra) {
              cell.extra = extra;
              clsDirty = true;
            }
            cell.filled = true;
            cellWrites++;
            if (cell.ph) {
              cell.ph = false;
              clsDirty = true;
            }
          } else if (!cell.ph) {
            if (cell.cleanup !== undefined) this.#clearCustom(cell);
            cell.text.data = '';
            cell.ph = true;
            if (cell.extra) cell.extra = '';
            clsDirty = true;
          }
        }
        if (clsDirty) {
          const cls = cell.ph ? `${cell.base} vg-ph` : cell.base + cell.extra;
          if (cls !== cell.cls) {
            cell.el.className = cls;
            cell.cls = cls;
          }
        }
      }
    }
    this.stats.rowWrites += rowWrites;
    this.stats.cellWrites += cellWrites;
  }

  /** Pinned columns: cells at fixed x (they do not scroll sideways), same rows as the body. */
  #renderPinned(r0: number, r1: number, valueAt: (rs: number, cs: number) => unknown): void {
    for (const pane of this.#panes()) if (pane.count) this.#renderPane(pane, r0, r1, valueAt);
  }

  #renderPane(pane: PinPane, r0: number, r1: number, valueAt: (rs: number, cs: number) => unknown): void {
    const { count: P, first } = pane;
    const { N, rows, cols, model } = this;
    const selRanges = this.sel.ranges;
    const bands = model.rowBands.length;
    const tiers = model.colTiers.length;
    const checks = this.#checksOn();
    const rowSrc = this.#rowSrc;
    const srcs = new Array<number>(P);
    const infos = new Array<ColumnInfo>(P);
    for (let j = 0; j < P; j++) {
      srcs[j] = this.colSource(first + j);
      infos[j] = this.#infoOf(srcs[j]);
    }
    for (let r = r0; r <= r1; r++) {
      const slot = pane.slots[r % N];
      if (!slot) continue;
      if (slot.r !== r) {
        slot.r = r;
        slot.el.style.transform = `translate3d(0,${rows.offsetOf(r) - this.anchorRowPx}px,0)`;
        const h = rows.sizeOf(r);
        if (h !== slot.h) {
          slot.el.style.height = `${h}px`;
          slot.el.style.lineHeight = `${h}px`;
          slot.h = h;
        }
        slot.el.setAttribute('aria-rowindex', String(r + 1 + tiers));
        for (const cell of slot.cells) cell.filled = false;
      }
      const cls = `vg-row${model.rowKind(r)}${checks && this.#isChecked(r) ? ' vg-checked' : ''}`;
      if (cls !== slot.cls) {
        slot.el.className = cls;
        slot.cls = cls;
      }
      const rs = rowSrc[r - r0];
      const coverRow = (r - r0) * P;
      for (let j = 0; j < P; j++) {
        const cell = slot.cells[j];
        let clsDirty = false;
        const covered = pane.cover[coverRow + j];
        if (covered !== cell.covered) {
          cell.el.style.visibility = covered ? 'hidden' : ''; // under a merged cell
          cell.covered = covered;
        }
        const c = first + j;
        const selected = inRanges(selRanges, r, c);
        if (selected !== cell.selected) {
          cell.el.setAttribute('aria-selected', selected ? 'true' : 'false');
          cell.selected = selected;
        }
        if (cell.c !== c) {
          cell.c = c;
          cell.el.setAttribute('aria-colindex', String(c + 1 + bands));
          cell.el.style.transform = `translate3d(${cols.offsetOf(c) - pane.base}px,0,0)`;
          cell.el.style.width = `${cols.sizeOf(c)}px`;
          cell.base = `vg-cell${model.colKind(c)}${infos[j].cls}`;
          cell.filled = false;
          clsDirty = true;
        }
        if (!cell.filled) {
          const cs = srcs[j];
          const value = rs < 0 || cs < 0 ? null : valueAt(rs, cs);
          if (value !== undefined) {
            const extra = rs < 0 || cs < 0 ? this.#fillBlank(cell) : this.#fillCell(cell, infos[j], r, c, rs, cs, value);
            if (extra !== cell.extra) {
              cell.extra = extra;
              clsDirty = true;
            }
            cell.filled = true;
            if (cell.ph) {
              cell.ph = false;
              clsDirty = true;
            }
          } else if (!cell.ph) {
            if (cell.cleanup !== undefined) this.#clearCustom(cell);
            cell.text.data = '';
            cell.ph = true;
            if (cell.extra) cell.extra = '';
            clsDirty = true;
          }
        }
        if (clsDirty) {
          const c = cell.ph ? `${cell.base} vg-ph` : cell.base + cell.extra;
          if (c !== cell.cls) {
            cell.el.className = c;
            cell.cls = c;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- cell content

  /** A cell with no source (e.g. outside a pivot's data): empty. Returns its extra classes. */
  #fillBlank(cell: CellSlot): string {
    if (cell.cleanup !== undefined) this.#clearCustom(cell);
    cell.text.data = '';
    return '';
  }

  /** Draws a loaded value (format / renderCell / cellClass). Returns its extra classes. */
  #fillCell(cell: CellSlot, info: ColumnInfo, r: number, c: number, rs: number, cs: number, value: unknown): string {
    const ctx = info.hooks ? this.#cellCtx(r, c, rs, cs, value, info.column) : null;
    const text = info.format ? String(info.format(value, ctx) ?? '') : defaultFormat(value);
    if (info.renderCell) {
      ctx!.text = text;
      this.#renderCustom(cell, info.renderCell, ctx!);
    } else {
      if (cell.cleanup !== undefined) this.#clearCustom(cell);
      cell.text.data = text;
    }
    if (info.cellClass) {
      const add = info.cellClass(value, ctx);
      if (add) return ` ${add}`;
    }
    return '';
  }

  /** Format / class / renderer for a source column (from the model, else the grid-wide options). */
  #infoOf(cs: number): ColumnInfo {
    const info = this.model.columnInfo?.(cs);
    if (info) {
      if (info.hooks === undefined) info.hooks = !!(info.format || info.cellClass || info.renderCell);
      return info;
    }
    if (!this.#defaultInfo) {
      const o = this.o;
      this.#defaultInfo = { column: undefined, format: o.format, cellClass: o.cellClass, renderCell: o.renderCell, cls: '' };
      this.#defaultInfo.hooks = !!(o.format || o.cellClass || o.renderCell);
    }
    return this.#defaultInfo;
  }

  /** The text of a value as shown in its column (copy, merged cells, selectionInfo). */
  #textOf(value: unknown, rs: number, cs: number): string | undefined {
    if (value === undefined) return undefined;
    const info = this.#infoOf(cs);
    if (!info.format) return defaultFormat(value);
    return String(info.format(value, this.#cellCtx(-1, -1, rs, cs, value, info.column)) ?? '');
  }

  /** What format / cellClass / renderCell get. `row` is the data record when the data source can tell (rowAt). */
  #cellCtx(r: number, c: number, rs: number, cs: number, value: unknown, column: ColumnDef | undefined): CellContext {
    const rowAt = this.o.rowAt;
    let row: unknown;
    let rowLoaded = false;
    return {
      rowIndex: r,
      colIndex: c,
      rowSource: rs,
      colSource: cs,
      value,
      text: '',
      column,
      grid: this.o.api as Grid,
      get row() {
        if (!rowLoaded) {
          row = rowAt ? rowAt(rs) : undefined;
          rowLoaded = true;
        }
        return row;
      },
    };
  }

  /**
   * A cell drawn by a renderer: render(el, ctx) draws into the cell's own box and may return a cleanup.
   * The cleanup runs before the box is drawn again or goes back to plain text; without one the box is
   * emptied by the grid.
   */
  #renderCustom(cell: CellSlot, render: Renderer<CellContext<any>>, ctx: CellContext): void {
    if (cell.cleanup !== undefined) this.#runCleanup(cell);
    if (!cell.box) {
      cell.box = div('vg-cbox', cell.el);
    }
    cell.box.hidden = false;
    cell.text.data = '';
    const cleanup = render(cell.box, ctx);
    cell.cleanup = typeof cleanup === 'function' ? cleanup : null;
  }

  #runCleanup(cell: CellSlot): void {
    if (cell.cleanup) cell.cleanup();
    else if (cell.box) cell.box.textContent = '';
    cell.cleanup = undefined;
  }

  #clearCustom(cell: CellSlot): void {
    this.#runCleanup(cell);
    if (cell.box) cell.box.hidden = true;
  }

  // ---------------------------------------------------------------- data

  #scheduleFetch(firstRow: number, firstCol: number): void {
    // A jump past the whole pool (scrollbar drag, go-to) waits for the position to settle, so a drag
    // across a billion rows does not request every block it passes over.
    const jumped = Math.abs(firstRow - this.#lastFirstRow) > this.N || Math.abs(firstCol - this.#lastFirstCol) > this.M;
    this.#lastFirstRow = firstRow;
    this.#lastFirstCol = firstCol;
    clearTimeout(this.#fetchTimer);
    if (jumped) {
      this.#fetchTimer = setTimeout(() => {
        this.#fetchTimer = 0;
        this.#requestData();
      }, JUMP_FETCH_DELAY_MS);
    } else {
      this.#fetchTimer = 0;
      this.#requestData();
    }
  }

  /** Sends the caches the wish list for the drawn window (plus prefetch), nearest to the middle first. */
  #requestData(): void {
    const win = this.#win;
    if (!win) return;
    const { blockRows: BR, blockCols: BC, fetchBlock, fetchLabels } = this.o;
    const query = this.query;
    const labelQuery: Query = this.#serverColFilter ? { ...EMPTY_QUERY, columnFilter: query.columnFilter } : EMPTY_QUERY;
    const sort = this.sortParam; // requests are for the current sort + filter (and land in its cache)
    const filter = this.filterParam;
    const colfilter = this.#serverColFilter;
    const rowCount = this.rows.count;
    const colCount = this.cols.count;
    // Prefetch half a block ahead in the direction of travel, then widen to chunk boundaries so the wish
    // list (and with it the requests) only changes when the window crosses a chunk, not on every step.
    const ra = clamp(alignDown(win.r0 - (this.dirY < 0 ? BR >> 1 : 0), CHUNK_ROWS), 0, rowCount - 1);
    const rb = clamp(alignUp(win.r1 + (this.dirY > 0 ? BR >> 1 : 0), CHUNK_ROWS), 0, rowCount - 1);
    const ca = clamp(alignDown(win.c0 - (this.dirX < 0 ? BC >> 1 : 0), CHUNK_COLS), 0, colCount - 1);
    const cb = clamp(alignUp(win.c1 + (this.dirX > 0 ? BC >> 1 : 0), CHUNK_COLS), 0, colCount - 1);
    const midR = (win.firstRow + win.lastRow) / 2;
    const midC = (win.firstCol + win.lastCol) / 2;

    const list: WishItem<CellBlock | LabelBlock>[] = [];
    const colLabelList: WishItem<LabelBlock>[] = [];
    for (const key of this.#labelNeeds) {
      const { axis, level, from } = parseLabelKey(key);
      // Column labels are the same in every sort order: shared cache, requested without the sort.
      const shared = axis === 'cols';
      const item = {
        key,
        dist: -1,
        load: (signal: AbortSignal) => (shared && level === 0 && this.model.describedColumns && this.o.fetchColumns
          // Described columns: one request brings titles and descriptions.
          ? this.o.fetchColumns({ from, n: Math.min(LABEL_BLOCK, Math.max(0, colCount - from)), signal, query: labelQuery, sort: '', filter: '', colfilter })
            .then((metas): LabelBlock => {
              const list = Array.isArray(metas) ? metas.map((m) => m ?? {}) : [];
              this.#columnsDescribed(from, list);
              return { from, names: list.map((m) => (m.title === undefined ? '' : String(m.title))), metas: list } as LabelBlock;
            })
          : fetchLabels({
            axis, level, from, n: LABEL_BLOCK, signal, query: shared ? labelQuery : query, sort: shared ? '' : sort, filter: shared ? '' : filter, colfilter,
          }).then((names): LabelBlock => ({ from, names }))),
      };
      (shared ? colLabelList : list).push(item);
    }
    // Data units live in source space (the fully expanded data). Visible items whose sources form a run
    // (expanded data) use dense blocks. Scattered items (collapsed groups) use thin strips, or single
    // cells where a scattered row meets a scattered column; these are batched into one gather request,
    // so a collapsed view does not pull whole blocks to show a few cells.
    // Each unit gets its distance from the middle of the viewport (in blocks) as its priority.
    const split = (from: number, to: number, source: (i: number) => number, size: number, mid: number, runMin: number) => {
      const dense = new Map<number, number>(); // block index -> distance
      const sparse = new Map<number, number>(); // source index -> distance
      const { src, isDense } = classifyRuns(from, to, source, this.canGather ? runMin : 0);
      for (let k = 0; k < src.length; k++) {
        const s = src[k];
        if (s < 0) continue;
        const d = Math.abs(from + k - mid) / size;
        const map = isDense[k] ? dense : sparse;
        const id = isDense[k] ? Math.floor(s / size) : s;
        const prev = map.get(id);
        if (!(prev !== undefined && prev <= d)) map.set(id, d);
      }
      return { dense, sparse };
    };
    const R = split(ra, rb, this.rowSource, BR, midR, RUN_MIN_ROWS);
    const C = split(ca, cb, this.colSource, BC, midC, RUN_MIN_COLS);
    // Pinned columns are on screen whatever the horizontal scroll.
    for (const pane of this.#panes()) {
      if (!pane.count) continue;
      const pinned = split(pane.first, pane.first + pane.count - 1, this.colSource, BC, pane.first, RUN_MIN_COLS);
      for (const [id] of pinned.dense) if (!C.dense.has(id)) C.dense.set(id, 0);
      for (const [id] of pinned.sparse) if (!C.sparse.has(id)) C.sparse.set(id, 0);
    }
    const rowSrcCount = this.model.rowSourceCount ?? rowCount;
    const colSrcCount = this.model.colSourceCount ?? colCount;
    const rowSpan = (br: number): [number, number] => [br * BR, Math.min(BR, rowSrcCount - br * BR)];
    const colSpan = (bc: number): [number, number] => [bc * BC, Math.min(BC, colSrcCount - bc * BC)];
    const blockItem = (br: number, bc: number, dist: number): WishItem<CellBlock> => {
      const [r0, nr] = rowSpan(br);
      const [c0, nc] = colSpan(bc);
      return {
        key: blockKey(br, bc),
        dist,
        load: (signal) => fetchBlock({ r0, c0, nr, nc, signal, query, sort, filter, colfilter }).then((res): CellBlock => {
          if (Array.isArray(res)) return { r0, c0, nr, nc, cells: res };
          if (!sort && !filter) this.merges.addServer(res.merges); // merged cells the data source reports for this block
          return { r0, c0, nr, nc, cells: res.cells };
        }),
      };
    };
    for (const [br, dr] of R.dense) {
      const [r0, nr] = rowSpan(br);
      for (const [bc, dc] of C.dense) list.push(blockItem(br, bc, dr + dc));
      for (const [cs, dc] of C.sparse) list.push({ key: colStripKey(br, cs), dist: dr + dc, rect: [r0, cs, nr, 1] });
    }
    for (const [rs, dr] of R.sparse) {
      for (const [bc, dc] of C.dense) {
        const [c0, nc] = colSpan(bc);
        list.push({ key: rowStripKey(rs, bc), dist: dr + dc, rect: [rs, c0, 1, nc] });
      }
      for (const [cs, dc] of C.sparse) list.push({ key: cellKey(rs, cs), dist: dr + dc, rect: [rs, cs, 1, 1] });
    }
    // Top-left cells of merges whose start is off screen (their value is shown in every visible piece).
    const keys = new Set(list.map((item) => item.key));
    for (const anchor of this.#mergeAnchors) {
      const [r, c] = anchor.split(':').map(Number);
      const br = Math.floor(r / BR);
      const bc = Math.floor(c / BC);
      if (keys.has(blockKey(br, bc))) continue;
      const item: WishItem<CellBlock> = this.canGather ? { key: cellKey(r, c), dist: 0, rect: [r, c, 1, 1] } : blockItem(br, bc, 0);
      if (keys.has(item.key)) continue;
      keys.add(item.key);
      list.push(item);
    }
    list.sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0));
    const sig = `${colLabelList.map((item) => item.key).join('|')}#${list.map((item) => item.key).join('|')}`;
    if (sig === this.#lastWantSig) return;
    this.#lastWantSig = sig;
    this.colLabels?.request(colLabelList);
    this.cache.request(list);
  }
}
