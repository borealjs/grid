import { useMemo, useRef, useState } from 'react';

// Translations for the language setting. Functions keep their source text so the code to copy shows them.
const fn = (f, src) => ({ f, src });
const LANGUAGES = {
  de: {
    noRows: 'Keine Zeilen passen zum Filter',
    noData: 'Keine Zeilen',
    filterTitle: fn((name) => `Filter: ${name}`, '(name) => `Filter: ${name}`'),
    min: 'Min', max: 'Max', from: 'Von', to: 'Bis',
    contains: 'Enthält', containsPlaceholder: 'Gesuchter Text', find: 'Suchen',
    searchValues: fn((n) => (n === undefined ? 'Werte durchsuchen' : `${n.toLocaleString('de')} Werte durchsuchen`), "(n) => (n === undefined ? 'Werte durchsuchen' : `${n.toLocaleString('de')} Werte durchsuchen`)"),
    all: 'Alle', none: 'Keine', loadingValues: 'Werte werden geladen…', noValues: 'Keine passenden Werte',
    refineSearch: fn((shown, matches) => `Die ersten ${shown.toLocaleString('de')} von ${matches.toLocaleString('de')}: Suche verfeinern`, "(shown, matches) => `Die ersten ${shown.toLocaleString('de')} von ${matches.toLocaleString('de')}: Suche verfeinern`"),
    clear: 'Zurücksetzen', apply: 'Anwenden', selectAll: 'Alle auswählen', columns: 'Spalten',
    applying: 'Wird angewendet…', cancel: 'Abbrechen',
    copied: fn((info) => `${info.cells.toLocaleString('de')} Zellen kopiert`, "(info) => `${info.cells.toLocaleString('de')} Zellen kopiert`"),
  },
  es: {
    noRows: 'Ninguna fila coincide con el filtro',
    noData: 'Sin filas',
    filterTitle: fn((name) => `Filtro: ${name}`, '(name) => `Filtro: ${name}`'),
    min: 'Mín', max: 'Máx', from: 'Desde', to: 'Hasta',
    contains: 'Contiene', containsPlaceholder: 'Texto a buscar', find: 'Buscar',
    searchValues: fn((n) => (n === undefined ? 'Buscar valores' : `Buscar ${n.toLocaleString('es')} valores`), "(n) => (n === undefined ? 'Buscar valores' : `Buscar ${n.toLocaleString('es')} valores`)"),
    all: 'Todos', none: 'Ninguno', loadingValues: 'Cargando valores…', noValues: 'Ningún valor coincide',
    refineSearch: fn((shown, matches) => `Primeros ${shown.toLocaleString('es')} de ${matches.toLocaleString('es')}: afine la búsqueda`, "(shown, matches) => `Primeros ${shown.toLocaleString('es')} de ${matches.toLocaleString('es')}: afine la búsqueda`"),
    clear: 'Borrar', apply: 'Aplicar', selectAll: 'Seleccionar todo', columns: 'Columnas',
    applying: 'Aplicando…', cancel: 'Cancelar',
    copied: fn((info) => `${info.cells.toLocaleString('es')} celdas copiadas`, "(info) => `${info.cells.toLocaleString('es')} celdas copiadas`"),
  },
};

// Every setting the panel offers: grid options with their defaults, plus theme variables (css: true).
// Only settings that differ from the default end up in the props and in the code to copy.
const OPTIONS = [
  { group: 'Features', name: 'sortable', label: 'Sorting', type: 'bool', default: true },
  { group: 'Features', name: 'multiSort', label: 'Sort by several columns', type: 'bool', default: true },
  { group: 'Features', name: 'filterable', label: 'Filters', type: 'bool', default: true },
  { group: 'Features', name: 'resizable', label: 'Resize columns', type: 'bool', default: true },
  { group: 'Features', name: 'expandable', label: 'Expand and collapse (pivots)', type: 'bool', default: true },
  { group: 'Features', name: 'copy', label: 'Copy with ⌘C / Ctrl+C', type: 'bool', default: true },
  { group: 'Features', name: 'keyboard', label: 'Keyboard navigation', type: 'bool', default: true },
  { group: 'Features', name: 'notices', label: 'Notices (copies, progress, errors)', type: 'bool', default: true },
  { group: 'Features', name: 'selection', label: 'Selection', type: 'select', values: ['multi', 'single', 'none'], default: 'multi' },
  { group: 'Features', name: 'columnChooser', label: 'Column chooser', type: 'select', values: ['auto', 'on', 'off'], labels: { auto: 'auto (when columns have groups)' }, default: 'auto' },
  { group: 'Look', name: 'theme', label: 'Theme', type: 'select', values: ['auto', 'light', 'dark'], default: 'auto' },
  { group: 'Look', name: 'language', label: 'Language', type: 'select', values: ['en', 'de', 'es'], labels: { en: 'English', de: 'Deutsch', es: 'Español' }, default: 'en' },
  { group: 'Look', name: 'rowHeader', label: 'Row numbers', type: 'bool', default: true },
  { group: 'Look', name: 'rowHeaderWidth', label: 'Row number width', type: 'range', min: 40, max: 120, default: 72, unit: 'px' },
  { group: 'Look', name: 'rowHeight', label: 'Row height', type: 'range', min: 20, max: 56, default: 28, unit: 'px' },
  { group: 'Look', name: 'headerHeight', label: 'Header height', type: 'range', min: 24, max: 60, default: 34, unit: 'px' },
  { group: 'Look', name: 'columnWidth', label: 'Column width', type: 'range', min: 60, max: 260, step: 4, default: 132, unit: 'px', hint: 'for columns without a width' },
  { group: 'Look', name: 'minColumnWidth', label: 'Smallest column width', type: 'range', min: 24, max: 120, default: 48, unit: 'px', hint: 'how narrow users can resize a column' },
  { group: 'Colors', name: 'accent', label: 'Accent', type: 'color', default: '', css: '--vg-accent', preview: '#2563eb' },
  { group: 'Colors', name: 'bg', label: 'Background', type: 'color', default: '', css: '--vg-bg', preview: '#ffffff' },
  { group: 'Colors', name: 'fg', label: 'Text', type: 'color', default: '', css: '--vg-fg', preview: '#1d2330' },
  { group: 'Colors', name: 'head', label: 'Header background', type: 'color', default: '', css: '--vg-head', preview: '#f5f6f8' },
  { group: 'Colors', name: 'zebra', label: 'Alternate rows', type: 'color', default: '', css: '--vg-zebra', preview: '#fafbfc' },
  { group: 'Colors', name: 'line', label: 'Grid lines', type: 'color', default: '', css: '--vg-line', preview: '#e4e7ec' },
  { group: 'Colors', name: 'fontSize', label: 'Font size', type: 'select', values: ['', '12', '13', '14', '15', '16'], default: '', css: '--vg-font', labels: { '': 'Default' } },
];

const DEFAULTS = Object.fromEntries(OPTIONS.map((o) => [o.name, o.default]));

/** Settings state: { values, set(name, value), reset() }. */
export function useGridOptions() {
  const [values, setValues] = useState(DEFAULTS);
  return {
    values,
    set: (name, value) => setValues((v) => ({ ...v, [name]: value })),
    reset: () => setValues(DEFAULTS),
  };
}

const isChanged = (values, name) => values[name] !== DEFAULTS[name];

/**
 * The grid props for the settings, as [name, value, source] entries: only what differs from the
 * defaults (the theme always, since the page follows it). `source` is the value as code.
 */
function propEntries(values) {
  const out = [];
  const str = (v) => `'${v}'`;
  for (const o of OPTIONS) {
    if (o.css || o.name === 'rowHeaderWidth') continue;
    if (o.name !== 'theme' && !isChanged(values, o.name)) continue;
    const v = values[o.name];
    if (o.name === 'rowHeader') continue; // with rowHeaderWidth below
    if (o.name === 'columnChooser') out.push([o.name, v === 'on', String(v === 'on')]);
    else if (o.name === 'language') {
      const lang = LANGUAGES[v];
      const value = Object.fromEntries(Object.entries(lang).map(([k, x]) => [k, x.f ?? x]));
      const source = `{\n${Object.entries(lang).map(([k, x]) => `    ${k}: ${x.src ?? str(x)},`).join('\n')}\n  }`;
      out.push(['messages', value, source]);
    } else out.push([o.name, v, typeof v === 'string' ? str(v) : String(v)]);
  }
  if (!values.rowHeader) out.push(['rowHeader', false, 'false']);
  else if (isChanged(values, 'rowHeaderWidth')) out.push(['rowHeader', { width: values.rowHeaderWidth }, `{ width: ${values.rowHeaderWidth} }`]);
  return out;
}

/** Props for <VirtualGrid>. */
export function gridPropsOf(values) {
  return Object.fromEntries(propEntries(values).map(([name, value]) => [name, value]));
}

/** CSS variables for the color settings, as declarations ('' when none). */
export function cssVarsOf(values) {
  const lines = [];
  for (const o of OPTIONS) {
    if (!o.css || !values[o.name]) continue;
    if (o.name === 'fontSize') lines.push(`--vg-font: ${values.fontSize}px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;`);
    else lines.push(`${o.css}: ${values[o.name]};`);
  }
  if (values.accent) {
    lines.push(`--vg-sel-fill: color-mix(in srgb, ${values.accent} 12%, transparent);`);
    lines.push(`--vg-sel-head: color-mix(in srgb, ${values.accent} 20%, var(--vg-bg));`);
  }
  return lines.join('\n');
}

const jsx = (name, source, value) => (typeof value === 'string' ? `${name}="${value}"` : `${name}={${source}}`);

function codeOf(lang, values) {
  const entries = propEntries(values).filter(([name, value]) => !(name === 'theme' && value === 'auto'));
  const css = cssVarsOf(values);
  let code;
  if (lang === 'react') {
    code = [
      `import { VirtualGrid } from '@borealjs/react-grid';`,
      `import '@borealjs/grid-core/style.css';`,
      '',
      '<VirtualGrid',
      ...(css ? ['  className="my-grid"'] : []),
      '  data={rows} // or a data source for your backend',
      '  columns={columns}',
      ...entries.map(([name, value, source]) => `  ${jsx(name, source, value)}`),
      '/>',
    ].join('\n');
  } else {
    code = [
      `import { createGrid } from '@borealjs/grid-core';`,
      `import '@borealjs/grid-core/style.css';`,
      '',
      `createGrid(document.getElementById('grid'), {`,
      '  data: rows, // or a data source for your backend',
      '  columns,',
      ...entries.map(([name, , source]) => `  ${name}: ${source},`),
      '});',
    ].join('\n');
  }
  if (css) {
    const selector = lang === 'react' ? '.my-grid .vg' : '#grid';
    code += `\n\n/* CSS */\n${selector} {\n${css.split('\n').map((l) => `  ${l}`).join('\n')}\n}`;
  }
  return code;
}

function Control({ option, value, onChange }) {
  const id = `opt-${option.name}`;
  if (option.type === 'bool') {
    return (
      <label className="opt opt-check" htmlFor={id}>
        <input id={id} type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
        {option.label}
      </label>
    );
  }
  if (option.type === 'select') {
    return (
      <label className="opt" htmlFor={id}>
        <span>{option.label}</span>
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {option.values.map((v) => <option key={v} value={v}>{option.labels?.[v] ?? v}</option>)}
        </select>
      </label>
    );
  }
  if (option.type === 'range') {
    return (
      <label className="opt opt-range" htmlFor={id} title={option.hint}>
        <span>{option.label} <output>{value}{option.unit}</output></span>
        <input id={id} type="range" min={option.min} max={option.max} step={option.step ?? 1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      </label>
    );
  }
  return (
    <label className="opt" htmlFor={id}>
      <span>{option.label}</span>
      <span className="opt-color">
        <input id={id} type="color" value={value || option.preview} onChange={(e) => onChange(e.target.value)} />
        {value && <button type="button" onClick={() => onChange('')}>Default</button>}
      </span>
    </label>
  );
}

/** The side panel: settings by group, then the code for the current settings with a copy button. */
export function OptionsPanel({ options, onClose }) {
  const [lang, setLang] = useState('react');
  const [copyLabel, setCopyLabel] = useState('Copy');
  const codeRef = useRef(null);
  const code = useMemo(() => codeOf(lang, options.values), [lang, options.values]);
  const groups = [...new Set(OPTIONS.map((o) => o.group))];
  const flash = (label) => {
    setCopyLabel(label);
    setTimeout(() => setCopyLabel('Copy'), 2000);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      flash('Copied');
      return;
    } catch {
      // Clipboard API blocked (some embedded views): select the code and try the older way.
    }
    const range = document.createRange();
    range.selectNodeContents(codeRef.current);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    flash(ok ? 'Copied' : /Mac|iPhone|iPad/.test(navigator.platform) ? 'Press ⌘C' : 'Press Ctrl+C');
  };
  return (
    <aside className="options" aria-label="Grid options">
      <div className="options-head">
        <strong>Options</strong>
        <button type="button" onClick={options.reset}>Reset</button>
        <button type="button" onClick={onClose} aria-label="Close options">✕</button>
      </div>
      {groups.map((group) => (
        <fieldset key={group}>
          <legend>{group}</legend>
          {OPTIONS.filter((o) => o.group === group).map((o) => (
            (o.name !== 'rowHeaderWidth' || options.values.rowHeader) && (
              <Control key={o.name} option={o} value={options.values[o.name]} onChange={(v) => options.set(o.name, v)} />
            )
          ))}
        </fieldset>
      ))}
      <fieldset>
        <legend>Code</legend>
        <div className="code-tabs" role="tablist">
          {[['react', 'React'], ['js', 'JavaScript']].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={lang === id} className={lang === id ? 'on' : ''} onClick={() => setLang(id)}>{label}</button>
          ))}
          <button type="button" className="copy" onClick={copy}>{copyLabel}</button>
        </div>
        <pre className="code"><code ref={codeRef}>{code}</code></pre>
        <p className="muted small">Only settings that differ from the defaults are listed.</p>
      </fieldset>
    </aside>
  );
}
