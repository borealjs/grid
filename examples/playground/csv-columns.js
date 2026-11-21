// Streaming CSV -> typed columns, for the playground's "server" worker (and Node tests).
//
// Why: the whole file is never held as one string and no cell is ever a JS string object (except the
// distinct values of text columns). A file is read in blocks of whole records; every cell goes straight
// into a typed array:
//   - numbers: Int32Array when every value is a whole number that fits, Float32Array when every value is
//     exactly representable in 32 bits, otherwise Float64Array (blank / unparseable = NaN)
//   - text:    a dictionary (the distinct strings) plus Uint16Array codes (Uint32Array past 65,535 values)
// Column types are decided from the first SAMPLE_ROWS rows (a column is numeric when >= 98% of its
// non-empty cells parse as numbers). A numeric column that turns out to be text later is converted to a
// text column when more than 2% of its cells do not parse, keeping the original strings it has seen.

export const SAMPLE_ROWS = 20000;
const CHUNK = 1 << 20; // values per typed chunk while building (a chunk is narrowed as soon as it is full)
const BLOCK_CHARS = 4 << 20; // characters parsed at a time
const MAX_SIDE = 100000; // unparseable cells remembered per numeric column, to restore them on a demotion
const F32_EXACT = 2 ** 24;

const NUM_CLEAN = /^\$|,(?=\d{3}\b)/g;
/** A cell as a number: plain, or with a leading $ and thousands separators. NaN when it is not one. */
export function parseNumber(v) {
  if (v === '') return NaN;
  const n = Number(v);
  if (n === n) return n;
  return Number(v.replace(NUM_CLEAN, ''));
}

// ------------------------------------------------------------------ record parser

export function detectDelimiter(text) {
  const head = text.slice(0, 20000).split(/\r?\n/).slice(0, 10);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = head.map((l) => l.split(d).length - 1);
    const min = Math.min(...counts);
    const score = min > 0 && counts.every((c) => c === counts[0]) ? min * 10 : min;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/** RFC 4180 records from `text` (which holds whole records): quoted fields, doubled quotes, newlines in quotes. */
function parseRecords(text, D, emit) {
  const len = text.length;
  let i = 0;
  let rowVals = [];
  const endRow = () => {
    if (rowVals.length === 1 && rowVals[0] === '') rowVals = []; // blank line
    else emit(rowVals);
    rowVals = [];
  };
  while (i < len) {
    let ch = text.charCodeAt(i);
    if (ch === 34) { // quoted
      let j = i + 1;
      let out = '';
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) { out += text.slice(j); i = len; break; }
        out += text.slice(j, q);
        if (text.charCodeAt(q + 1) === 34) { out += '"'; j = q + 2; continue; }
        i = q + 1;
        break;
      }
      rowVals.push(out);
      ch = text.charCodeAt(i);
      if (ch === D) i++;
      else if (ch === 13) { i += text.charCodeAt(i + 1) === 10 ? 2 : 1; endRow(); }
      else if (ch === 10) { i++; endRow(); }
      else if (i >= len) endRow();
      continue;
    }
    let j = i; // unquoted: up to the next delimiter or newline
    while (j < len) {
      const c = text.charCodeAt(j);
      if (c === D || c === 10 || c === 13) break;
      j++;
    }
    rowVals.push(text.slice(i, j).trim());
    if (j >= len) { i = len; endRow(); break; }
    const c = text.charCodeAt(j);
    if (c === D) { i = j + 1; if (i >= len) { rowVals.push(''); endRow(); } }
    else if (c === 13) { i = j + (text.charCodeAt(j + 1) === 10 ? 2 : 1); endRow(); }
    else { i = j + 1; endRow(); }
  }
  if (rowVals.length) endRow();
}

/** Where the last complete record ends in `text`: after the last newline outside quotes (0 when there is none). */
function lastRecordEnd(text) {
  if (text.indexOf('"') < 0) return text.lastIndexOf('\n') + 1; // no quotes: every newline ends a record
  let quotes = 0;
  let end = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 34) quotes++;
    else if (c === 10 && (quotes & 1) === 0) end = i + 1;
  }
  return end;
}

/** The file (or text) as blocks of characters. */
async function* readBlocks(file, text, onChars) {
  if (text !== undefined) {
    onChars(text.length, text.length);
    yield text;
    return;
  }
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let parts = [];
  let size = 0;
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (value) { parts.push(value); size += value.length; done += value.length; }
    if (end || size >= BLOCK_CHARS) {
      if (size) yield parts.join('');
      parts = [];
      size = 0;
      onChars(done, file.size);
    }
    if (end) return;
  }
}

// ------------------------------------------------------------------ column builders

/** Numbers: filled in 1M-value Float64 chunks, each narrowed to the smallest exact type once it is full. */
class NumBuilder {
  kind = 'num';
  chunks = []; // { kind: 'i32' | 'f32' | 'f64', data, max }
  cur = new Float64Array(CHUNK);
  len = 0;
  n = 0;
  seen = 0;
  bad = 0;
  side = new Map(); // row -> original text of an unparseable cell
  demote = false;

  add(v) {
    const x = parseNumber(v);
    if (v !== '') {
      this.seen++;
      if (x !== x || x === Infinity || x === -Infinity) {
        this.bad++;
        if (this.side.size < MAX_SIDE) this.side.set(this.n, v);
        if (this.bad > 1000 && this.bad > 0.02 * this.seen) this.demote = true;
      }
    }
    this.cur[this.len++] = x;
    this.n++;
    if (this.len === CHUNK) this.#seal();
  }

  addBlank(count) {
    for (let k = 0; k < count; k++) {
      this.cur[this.len++] = NaN;
      this.n++;
      if (this.len === CHUNK) this.#seal();
    }
  }

  #seal() {
    const src = this.len === CHUNK ? this.cur : this.cur.subarray(0, this.len);
    let isInt = true;
    let isF32 = true;
    let max = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (isInt && (v | 0) !== v) isInt = false;
      if (isF32 && v === v && Math.fround(v) !== v) isF32 = false;
      if (!isF32 && !isInt) break;
      const a = v < 0 ? -v : v;
      if (a > max) max = a;
    }
    if (isInt) this.chunks.push({ kind: 'i32', data: Int32Array.from(src), max });
    else if (isF32) this.chunks.push({ kind: 'f32', data: Float32Array.from(src), max });
    else this.chunks.push({ kind: 'f64', data: src === this.cur ? this.cur : src.slice(), max });
    this.cur = this.chunks[this.chunks.length - 1].data === this.cur ? new Float64Array(CHUNK) : this.cur;
    this.len = 0;
  }

  /** The column as one typed array of the smallest type that holds every value exactly. */
  finish() {
    if (this.len) this.#seal();
    const all = this.chunks;
    let Type = Int32Array;
    if (all.some((c) => c.kind === 'f64')) Type = Float64Array;
    else if (all.some((c) => c.kind === 'f32')) Type = all.every((c) => c.kind === 'f32' || c.max <= F32_EXACT) ? Float32Array : Float64Array;
    const values = new Type(this.n);
    let at = 0;
    for (const c of all) { values.set(c.data, at); at += c.data.length; }
    this.chunks = [];
    this.side.clear();
    return values;
  }

  /** The same column as text, restoring the original text of unparseable cells. */
  toDim() {
    const dim = new DimBuilder();
    let row = 0;
    const put = (v) => {
      dim.add(v !== v ? (this.side.get(row) ?? '') : String(v));
      row++;
    };
    for (const c of this.chunks) for (let i = 0; i < c.data.length; i++) put(c.data[i]);
    for (let i = 0; i < this.len; i++) put(this.cur[i]);
    return dim;
  }
}

/** Text: a dictionary plus Uint16 codes (widened to Uint32 when there are more than 65,535 distinct values). */
class DimBuilder {
  kind = 'dim';
  map = new Map();
  dict = [];
  chunks = [];
  cur = new Uint16Array(CHUNK);
  len = 0;
  n = 0;
  wide = false;

  add(v) {
    if (v === '') v = '(blank)';
    let code = this.map.get(v);
    if (code === undefined) {
      code = this.dict.length;
      this.map.set(v, code);
      this.dict.push(v);
      if (code === 65536 && !this.wide) this.#widen();
    }
    this.cur[this.len++] = code;
    this.n++;
    if (this.len === CHUNK) {
      this.chunks.push(this.cur);
      this.cur = this.wide ? new Uint32Array(CHUNK) : new Uint16Array(CHUNK);
      this.len = 0;
    }
  }

  addBlank(count) {
    for (let k = 0; k < count; k++) this.add('');
  }

  #widen() {
    this.wide = true;
    this.chunks = this.chunks.map((c) => Uint32Array.from(c));
    const next = new Uint32Array(CHUNK);
    next.set(this.cur.subarray(0, this.len));
    this.cur = next;
  }

  finish() {
    const codes = this.wide ? new Uint32Array(this.n) : new Uint16Array(this.n);
    let at = 0;
    for (const c of this.chunks) { codes.set(c, at); at += c.length; }
    codes.set(this.cur.subarray(0, this.len), at);
    this.chunks = [];
    this.map = null; // only the dictionary is kept
    return { codes, dict: this.dict };
  }
}

// ------------------------------------------------------------------ the parser

/**
 * Parses a CSV from a File/Blob (streamed) or a string into typed columns.
 * onProgress({ phase, done, total }) is called while reading and while packing the columns.
 * Returns { n, delimiter, fields: [{ key, name, kind: 'num', values } | { key, name, kind: 'dim', codes, dict }] }.
 */
export async function parseCsvColumns({ file, text, header = true, delimiter = 'auto', onProgress } = {}) {
  if (file === undefined && text === undefined) throw new Error('parseCsvColumns needs a file or text');
  let D = 0;
  let delim = ',';
  let first = true;
  let headerNames = null;
  let buffered = []; // the first rows, held until the column types are decided
  let columns = null; // builders, once decided
  let n = 0;

  const decide = () => {
    const width = buffered.reduce((w, r) => Math.max(w, r.length), 0);
    columns = [];
    for (let c = 0; c < width; c++) {
      let nonEmpty = 0;
      let numeric = 0;
      for (const r of buffered) {
        const v = r[c];
        if (v === undefined || v === '') continue;
        nonEmpty++;
        if (Number.isFinite(parseNumber(v))) numeric++;
      }
      columns.push(nonEmpty > 0 && numeric / nonEmpty >= 0.98 ? new NumBuilder() : new DimBuilder());
    }
    const rows = buffered;
    buffered = null;
    for (const r of rows) put(r);
  };

  const put = (vals) => {
    const width = Math.max(vals.length, columns.length);
    for (let c = 0; c < width; c++) {
      if (!columns[c]) { columns[c] = new DimBuilder(); columns[c].addBlank(n); } // a column that first appears late
      const col = columns[c];
      col.add(vals[c] ?? '');
      if (col.demote) columns[c] = col.toDim();
    }
    n++;
  };

  const emit = (vals) => {
    if (header && !headerNames) { headerNames = vals; return; }
    if (buffered) {
      buffered.push(vals);
      if (buffered.length >= SAMPLE_ROWS) decide();
    } else put(vals);
  };

  let pending = '';
  const report = (phase, done, total) => onProgress?.({ phase, done, total });
  for await (let block of readBlocks(file, text, (done, total) => report('Parsing CSV', done, total))) {
    if (first) {
      first = false;
      if (block.charCodeAt(0) === 0xfeff) block = block.slice(1);
      delim = delimiter === 'auto' ? detectDelimiter(block) : delimiter === 'tab' ? '\t' : delimiter;
      D = delim.charCodeAt(0);
    }
    pending += block;
    const end = lastRecordEnd(pending);
    if (end) {
      parseRecords(pending.slice(0, end), D, emit);
      pending = pending.slice(end);
    }
  }
  if (pending) parseRecords(pending, D, emit); // the last record has no newline
  if (buffered) decide();
  if (!columns || !columns.length || !n) throw new Error('The CSV has no data rows');

  const used = new Set();
  const fields = columns.map((col, c) => {
    report('Packing columns', c, columns.length); // narrowing and copying a column of millions of values takes a moment
    let name = (headerNames?.[c] ?? '').trim() || `Column ${c + 1}`;
    while (used.has(name)) name += ' ·';
    used.add(name);
    if (col.kind === 'num') return { key: `f${c}`, name, kind: 'num', values: col.finish() };
    const { codes, dict } = col.finish();
    return { key: `f${c}`, name, kind: 'dim', codes, dict };
  });
  report('Packing columns', columns.length, columns.length);
  return { n, delimiter: delim, fields };
}
