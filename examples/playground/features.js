// Pieces the playground uses to show the grid's customisation options: translations (`messages`),
// a custom header (`renderHeader`), a custom empty state (`renderEmpty`), a custom filter
// (`filter: { op, render }`), moving any column next to the pinned block of a very wide table
// (`setColumnOrder` with compact runs), and turning the plain-JavaScript code view into React.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ------------------------------------------------------------------ translations

const n = (x) => Number(x).toLocaleString();
export const LANGUAGES = {
  en: { label: 'English', messages: null },
  de: {
    label: 'Deutsch',
    messages: {
      noRows: 'Keine Zeilen passen zum Filter', noData: 'Keine Zeilen', filterTitle: (name) => `Filter: ${name}`,
      min: 'Min.', max: 'Max.', from: 'Von', to: 'Bis', contains: 'Enthält', containsPlaceholder: 'Gesuchter Text', find: 'Suchen',
      searchValues: (t) => (t === undefined ? 'Werte durchsuchen' : `${n(t)} Werte durchsuchen`), all: 'Alle', none: 'Keine',
      loadingValues: 'Werte werden geladen…', noValues: 'Keine passenden Werte', clear: 'Zurücksetzen', apply: 'Anwenden',
      selectAll: 'Alles auswählen', columns: 'Spalten', applying: 'Wird angewendet…', cancel: 'Abbrechen',
    },
  },
  es: {
    label: 'Español',
    messages: {
      noRows: 'Ninguna fila coincide con el filtro', noData: 'Sin filas', filterTitle: (name) => `Filtro: ${name}`,
      min: 'Mín.', max: 'Máx.', from: 'Desde', to: 'Hasta', contains: 'Contiene', containsPlaceholder: 'Texto a buscar', find: 'Buscar',
      searchValues: (t) => (t === undefined ? 'Buscar valores' : `Buscar entre ${n(t)} valores`), all: 'Todos', none: 'Ninguno',
      loadingValues: 'Cargando valores…', noValues: 'Ningún valor coincide', clear: 'Borrar', apply: 'Aplicar',
      selectAll: 'Seleccionar todo', columns: 'Columnas', applying: 'Aplicando…', cancel: 'Cancelar',
    },
  },
  fr: {
    label: 'Français',
    messages: {
      noRows: 'Aucune ligne ne correspond au filtre', noData: 'Aucune ligne', filterTitle: (name) => `Filtre : ${name}`,
      min: 'Min.', max: 'Max.', from: 'Du', to: 'Au', contains: 'Contient', containsPlaceholder: 'Texte à chercher', find: 'Chercher',
      searchValues: (t) => (t === undefined ? 'Chercher des valeurs' : `Chercher parmi ${n(t)} valeurs`), all: 'Tout', none: 'Aucun',
      loadingValues: 'Chargement des valeurs…', noValues: 'Aucune valeur ne correspond', clear: 'Effacer', apply: 'Appliquer',
      selectAll: 'Tout sélectionner', columns: 'Colonnes', applying: 'Application…', cancel: 'Annuler',
    },
  },
  ja: {
    label: '日本語',
    messages: {
      noRows: 'フィルターに一致する行はありません', noData: '行がありません', filterTitle: (name) => `フィルター: ${name}`,
      min: '最小', max: '最大', from: '開始', to: '終了', contains: '含む', containsPlaceholder: '検索する文字列', find: '検索',
      searchValues: (t) => (t === undefined ? '値を検索' : `${n(t)} 件の値を検索`), all: 'すべて', none: 'なし',
      loadingValues: '値を読み込み中…', noValues: '一致する値はありません', clear: 'クリア', apply: '適用',
      selectAll: 'すべて選択', columns: '列', applying: '適用中…', cancel: 'キャンセル',
    },
  },
};

// ------------------------------------------------------------------ renderers

/** A header with a type badge, a pin mark and the sort order spelled out. */
export function customHeader(el, ctx) {
  if (ctx.axis !== 'cols' || !ctx.column) {
    el.textContent = ctx.label ?? '';
    return;
  }
  const c = ctx.column;
  const badge = c.type === 'number' ? '#' : c.type === 'date' ? '◷' : 'A';
  const pin = c.pinned === 'right' ? ' ⇥' : c.pinned ? ' ⇤' : '';
  const sort = ctx.sorted ? ` <span class="hdr-sort">${ctx.sorted === 'asc' ? '↑' : '↓'}${ctx.sortPriority > 0 ? ctx.sortPriority + 1 : ''}</span>` : '';
  el.innerHTML = `<span class="hdr"><span class="hdr-badge t-${c.type ?? 'text'}">${badge}</span><span class="hdr-label">${esc(ctx.label ?? '')}</span>${pin ? `<span class="hdr-pin">${pin}</span>` : ''}${sort}</span>`;
}

/** An empty state with a way out: clear the filters right there. */
export function customEmpty(getGrid) {
  return (el, { filtered }) => {
    el.innerHTML = filtered
      ? `<div class="empty-custom"><b>Nothing matches these filters.</b><button type="button" class="btn small">Clear filters</button></div>`
      : `<div class="empty-custom"><b>This table is empty.</b><span>Load or generate some rows.</span></div>`;
    el.querySelector('button')?.addEventListener('click', () => {
      const g = getGrid();
      g?.setQuery({ filter: [], columnFilter: [] });
    });
  };
}

/** A custom filter for number columns: "at least" with a slider and a number box. Sent as { op: 'atLeast', value }. */
export function atLeastFilter(hint = {}) {
  return {
    op: 'atLeast',
    render(el, api) {
      const lo = Number.isFinite(hint.min) ? hint.min : 0;
      const hi = Number.isFinite(hint.max) && hint.max > lo ? hint.max : lo + 1000;
      const start = api.value ?? lo;
      el.innerHTML = `<label class="cf"><span>At least</span>
        <input type="range" min="${lo}" max="${hi}" step="any" value="${start}">
        <input type="number" value="${start}"></label>
        <small class="cf-hint">A custom filter: the server receives { op: 'atLeast', value }</small>`;
      const [range, num] = el.querySelectorAll('input');
      const set = (v) => { range.value = v; num.value = v; api.setValue(Number(v)); };
      range.addEventListener('input', () => set(range.value));
      num.addEventListener('input', () => set(num.value));
      num.addEventListener('keydown', (e) => { if (e.key === 'Enter') api.apply(Number(num.value)); });
    },
  };
}

// ------------------------------------------------------------------ column order (compact runs)

/**
 * Moves source column `s` to display position `pos` in a compact order (source indexes and [first, last]
 * runs, as getColumnOrder returns for very wide tables). A million columns stay a handful of entries.
 */
export function moveColumn(order, s, pos, total) {
  const runs = (Array.isArray(order) && order.length ? order : [[0, total - 1]])
    .map((x) => (Array.isArray(x) ? [x[0], x[1]] : [x, x]));
  const without = [];
  for (const [a, b] of runs) {
    if (s < a || s > b) without.push([a, b]);
    else {
      if (a <= s - 1) without.push([a, s - 1]);
      if (s + 1 <= b) without.push([s + 1, b]);
    }
  }
  const out = [];
  let acc = 0;
  let done = false;
  for (const [a, b] of without) {
    const len = b - a + 1;
    if (!done && pos < acc + len) {
      const k = pos - acc;
      if (k > 0) out.push([a, a + k - 1]);
      out.push([s, s]);
      out.push([a + k, b]);
      done = true;
    } else out.push([a, b]);
    acc += len;
  }
  if (!done) out.push([s, s]);
  return out.map(([a, b]) => (a === b ? a : [a, b]));
}

// ------------------------------------------------------------------ React code

/**
 * The React version of the plain-JavaScript code view: same data source and options, as a <VirtualGrid>
 * component from @borealjs/react-grid.
 */
export function toReact(jsCode) {
  const cut = jsCode.indexOf('const grid = createGrid(');
  if (cut < 0) return jsCode;
  let head = jsCode.slice(0, cut).trimEnd();
  const call = jsCode.slice(cut);
  // Imports: createGrid comes from the React package as <VirtualGrid>; keep the rest.
  head = head.replace(/import \{([^}]*)\} from '@borealjs\/grid-core';/, (_, names) => {
    const rest = names.split(',').map((x) => x.trim()).filter((x) => x && x !== 'createGrid');
    return `import { VirtualGrid } from '@borealjs/react-grid';${rest.length ? `\nimport { ${rest.join(', ')} } from '@borealjs/grid-core';` : ''}`;
  });
  // Options object -> JSX props.
  const body = call.slice(call.indexOf('{') + 1, call.lastIndexOf('}'));
  const props = [];
  let depth = 0;
  let cur = '';
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || (t.startsWith('//') && depth === 0)) { if (t.startsWith('//')) props.push({ comment: t }); continue; }
    cur += (cur ? '\n' : '') + line;
    for (const ch of t) { if ('([{'.includes(ch)) depth++; if (')]}'.includes(ch)) depth--; }
    if (depth === 0) { props.push({ text: cur.trim().replace(/,$/, '') }); cur = ''; }
  }
  const jsx = props.map((p) => {
    if (p.comment) return `      {/* ${p.comment.replace(/^\/\/\s*/, '')} */}`;
    const m = p.text.match(/^(\w+)(?::\s*([\s\S]*))?$/);
    if (!m) return `      {/* ${p.text} */}`;
    const [, key, value] = m;
    const name = key === 'ariaLabel' ? 'aria-label' : key;
    if (value === undefined) return `      ${name}={${key}}`;
    if (/^'[^']*'$/.test(value)) return `      ${name}="${value.slice(1, -1)}"`;
    if (value === 'true') return `      ${name}`;
    return `      ${name}={${value.replace(/\n/g, '\n      ')}}`;
  });
  return `${head}

export default function Grid() {
  return (
    <VirtualGrid
      style={{ height: 600 }}
${jsx.join('\n')}
    />
  );
}`;
}
