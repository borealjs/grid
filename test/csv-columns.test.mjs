// The playground's streaming CSV -> typed columns parser (examples/playground/csv-columns.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { parseCsvColumns, parseNumber, SAMPLE_ROWS } from '../examples/playground/csv-columns.js';

const parse = (text, opts = {}) => parseCsvColumns({ text, ...opts });
// The text a cell shows: numbers as numbers (NaN for blank), text through its dictionary.
const cell = (f, r) => (f.kind === 'num' ? f.values[r] : f.dict[f.codes[r]]);
const col = (res, c) => Array.from({ length: res.n }, (_, r) => cell(res.fields[c], r));

test('types, header names, delimiter detection and blank cells', async () => {
  const r = await parse('id,name,score,note\n1,Ada,9.5,\n2,Grace,7,hello\n3,Alan,,"x"\n');
  assert.equal(r.n, 3);
  assert.equal(r.delimiter, ',');
  assert.deepEqual(r.fields.map((f) => [f.name, f.kind]), [['id', 'num'], ['name', 'dim'], ['score', 'num'], ['note', 'dim']]);
  assert.deepEqual(col(r, 1), ['Ada', 'Grace', 'Alan']);
  assert.deepEqual(col(r, 3), ['(blank)', 'hello', 'x']);
  assert.ok(Number.isNaN(col(r, 2)[2]));
  assert.equal((await parse('a;b\n1;2\n3;4')).delimiter, ';');
  assert.equal((await parse('a\tb\n1\t2')).delimiter, '\t');
});

test('quotes, doubled quotes, newlines inside quotes, CRLF, BOM, blank lines, a last line without newline', async () => {
  const r = await parse('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n"two\nlines",z\r\nlast,row');
  assert.deepEqual(r.fields.map((f) => f.name), ['a', 'b']);
  assert.deepEqual(col(r, 0), ['x, y', 'two\nlines', 'last']);
  assert.deepEqual(col(r, 1), ['say "hi"', 'z', 'row']);
});

test('no header: columns are named Column N and the first line is data', async () => {
  const r = await parse('1,2\n3,4', { header: false });
  assert.deepEqual(r.fields.map((f) => f.name), ['Column 1', 'Column 2']);
  assert.deepEqual(col(r, 0), [1, 3]);
});

test('duplicate and empty header names are made unique', async () => {
  const r = await parse('a,a,\n1,2,3');
  assert.deepEqual(r.fields.map((f) => f.name), ['a', 'a ·', 'Column 3']);
});

test('numbers: $ and thousands separators parse; blank and junk become NaN', () => {
  assert.equal(parseNumber('$1,234.5'), 1234.5);
  assert.equal(parseNumber('1,000,000'), 1000000);
  assert.equal(parseNumber('1e3'), 1000);
  assert.ok(Number.isNaN(parseNumber('')));
  assert.ok(Number.isNaN(parseNumber('abc')));
});

test('narrowing: whole numbers -> Int32Array, exact 32-bit floats -> Float32Array, everything else Float64Array', async () => {
  const r = await parse('i,f,d,big,blank\n1,0.5,0.1,3000000001,1\n-2,0.25,0.2,4000000001,\n7,1.5,0.3,5,3\n');
  const types = r.fields.map((f) => f.values.constructor.name);
  assert.deepEqual(types, ['Int32Array', 'Float32Array', 'Float64Array', 'Float64Array', 'Float32Array']); // blank (NaN) keeps a column off Int32
  assert.deepEqual(Array.from(r.fields[0].values), [1, -2, 7]);
  assert.deepEqual(Array.from(r.fields[1].values), [0.5, 0.25, 1.5]);
  assert.deepEqual(Array.from(r.fields[2].values), [0.1, 0.2, 0.3]); // exact, not rounded to 32 bits
});

test('narrowing is lossless across many chunks: integers beyond 2^24 are never stored in a Float32Array', async () => {
  const rows = ['a'];
  for (let i = 0; i < 1_100_000; i++) rows.push(i === 1_050_000 ? '33554433' : '0.5'); // 2^25 + 1 is not a float32
  const r = await parse(rows.join('\n'));
  assert.equal(r.fields[0].values.constructor.name, 'Float64Array');
  assert.equal(r.fields[0].values[1_050_000], 33554433);
  assert.equal(r.fields[0].values[1_099_999], 0.5);
});

test('text columns: dictionary plus Uint16 codes, widened to Uint32 past 65,535 distinct values, order kept', async () => {
  const small = await parse('t\nb\na\nb\na');
  assert.equal(small.fields[0].codes.constructor.name, 'Uint16Array');
  assert.deepEqual(small.fields[0].dict, ['b', 'a']);
  const rows = ['t'];
  for (let i = 0; i < 70_000; i++) rows.push(`v${i}`);
  rows.push('v5', 'v69999');
  const big = await parse(rows.join('\n'));
  const f = big.fields[0];
  assert.equal(f.codes.constructor.name, 'Uint32Array');
  assert.equal(f.dict.length, 70_000);
  assert.equal(cell(f, 0), 'v0');
  assert.equal(cell(f, 65_536), 'v65536');
  assert.equal(cell(f, 70_000), 'v5');
  assert.equal(cell(f, 70_001), 'v69999');
});

test('a numeric column that turns out to be text is converted, keeping its original strings', async () => {
  const rows = ['v'];
  for (let i = 0; i < SAMPLE_ROWS + 5000; i++) rows.push(String(i));
  for (let i = 0; i < 3000; i++) rows.push(`N/A-${i}`); // > 1000 and > 2% of the cells
  const r = await parse(rows.join('\n'));
  const f = r.fields[0];
  assert.equal(f.kind, 'dim');
  assert.equal(cell(f, 0), '0');
  assert.equal(cell(f, SAMPLE_ROWS + 4999), String(SAMPLE_ROWS + 4999));
  assert.equal(cell(f, SAMPLE_ROWS + 5000), 'N/A-0');
  assert.equal(r.n, SAMPLE_ROWS + 8000);
});

test('a few bad cells in a numeric column stay numeric (NaN)', async () => {
  const rows = ['v'];
  for (let i = 0; i < 5000; i++) rows.push(i === 4000 ? 'oops' : String(i));
  const f = (await parse(rows.join('\n'))).fields[0];
  assert.equal(f.kind, 'num');
  assert.ok(Number.isNaN(f.values[4000]));
  assert.equal(f.values[4001], 4001);
});

test('ragged rows: missing cells are blank, extra cells make another column', async () => {
  const r = await parse('a,b\n1\n2,3,4\n5,6');
  assert.equal(r.fields.length, 3);
  assert.deepEqual(col(r, 2).map(String), ['NaN', '4', 'NaN']);
  assert.ok(Number.isNaN(col(r, 1)[0]));
});

test('a column that first appears after the type sample is added as text, earlier rows blank', async () => {
  const rows = ['a,b'];
  for (let i = 0; i < SAMPLE_ROWS + 10; i++) rows.push(`${i},x`);
  rows.push('1,y,late');
  const r = await parse(rows.join('\n'));
  assert.equal(r.fields.length, 3);
  assert.equal(r.fields[2].kind, 'dim');
  assert.equal(cell(r.fields[2], 0), '(blank)');
  assert.equal(cell(r.fields[2], r.n - 1), 'late');
  assert.equal(r.n, SAMPLE_ROWS + 11);
});

test('no data rows is an error', async () => {
  await assert.rejects(parse('only,a,header\n'), /no data rows/);
  await assert.rejects(parse(''), /no data rows/);
});

test('a File is streamed in blocks and gives exactly what the string path gives (quoted newlines across block ends)', async () => {
  // ~9M characters: records of different lengths, quoted fields with commas / quotes / newlines, so some
  // 4M-character block ends fall inside a quoted field.
  const lines = ['id,text,n'];
  let i = 0;
  let size = 0;
  while (size < 9_000_000) {
    const t = i % 7 === 0 ? `"multi\nline, ""q"" ${i}"` : i % 5 === 0 ? `"a,${i}"` : `plain${i % 977}`;
    const line = `${i},${t},${i * 3}`;
    lines.push(line);
    size += line.length + 1;
    i++;
  }
  const text = lines.join('\n');
  const [a, b] = await Promise.all([parse(text), parseCsvColumns({ file: new Blob([text]) })]);
  assert.equal(a.n, i);
  assert.equal(b.n, i);
  for (let c = 0; c < 3; c++) {
    assert.equal(b.fields[c].kind, a.fields[c].kind);
    for (const r of [0, 1, 6, 7, 5, 100_000, i - 1]) assert.equal(String(cell(b.fields[c], r)), String(cell(a.fields[c], r)));
  }
  assert.deepEqual(b.fields[1].dict, a.fields[1].dict);
  assert.deepEqual(Array.from(b.fields[1].codes), Array.from(a.fields[1].codes));
  assert.deepEqual(Array.from(b.fields[2].values), Array.from(a.fields[2].values));
});

test('progress: parsing is reported while a file is read, then every column as it is packed', async () => {
  const text = `a,b\n${'1,x\n'.repeat(3_000_000)}`;
  const calls = [];
  await parseCsvColumns({ file: new Blob([text]), onProgress: (p) => calls.push(p) });
  const parsing = calls.filter((p) => p.phase === 'Parsing CSV');
  const packing = calls.filter((p) => p.phase === 'Packing columns');
  assert.ok(parsing.length >= 2);
  assert.equal(parsing.at(-1).done, parsing.at(-1).total);
  assert.deepEqual(packing.map((p) => p.done), [0, 1, 2]); // 2 columns, then the final 2 / 2
  assert.ok(packing.every((p) => p.total === 2));
  assert.ok(calls.indexOf(packing[0]) > calls.indexOf(parsing.at(-1))); // packing comes after parsing
});

// Any table, quoted the way a spreadsheet would, reads back cell for cell.
test('property: a CSV written from random cells reads back identically (text and numeric columns)', async () => {
  const textCell = fc.string({ unit: fc.constantFrom('a', 'b', ',', '"', '\n', ' ', 'é', '1', ';') }).filter((s) => s.trim() === s && s !== '');
  const num = fc.oneof(fc.integer({ min: -1e6, max: 1e6 }), fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }));
  const column = fc.oneof(fc.record({ kind: fc.constant('num'), vals: fc.array(num, { minLength: 1, maxLength: 30 }) }), fc.record({ kind: fc.constant('text'), vals: fc.array(textCell, { minLength: 1, maxLength: 30 }) }));
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 6 }).chain((w) => fc.tuple(fc.constant(w), fc.array(column, { minLength: w, maxLength: w }), fc.integer({ min: 1, max: 30 }))), async ([w, cols, rows]) => {
      const n = Math.min(rows, ...cols.map((c) => c.vals.length));
      const q = (s) => (/[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
      const lines = [cols.map((_, c) => `h${c}`).join(',')];
      for (let r = 0; r < n; r++) lines.push(cols.map((c) => q(String(c.vals[r]))).join(','));
      const res = await parse(lines.join('\n'));
      assert.equal(res.n, n);
      cols.forEach((c, ci) => {
        for (let r = 0; r < n; r++) {
          const got = cell(res.fields[ci], r);
          if (c.kind === 'num') assert.equal(res.fields[ci].kind, 'num');
          // a text column made only of numeric-looking strings is read as numbers: compare as numbers then
          const want = c.vals[r];
          if (res.fields[ci].kind === 'num') assert.equal(got, Number(String(want))); // String(-0) is '0': that is what was written
          else assert.equal(got, String(want));
        }
      });
    }),
    { numRuns: 150 },
  );
});
