import { defineConfig } from 'tsdown';

// One minified ES module and one bundled declaration file: dist/index.js + dist/index.d.ts.
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  dts: true,
  fixedExtension: false,
  clean: true,
});
