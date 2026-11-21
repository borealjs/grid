import { defineConfig } from 'tsdown';

// One minified ES module and one bundled declaration file: dist/index.js + dist/index.d.ts.
// React and @borealjs/grid-core stay external (peer dependency / dependency).
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
  // Bundling drops module-level directives, so the React Server Components marker is added to the output.
  banner: { js: "'use client';" },
});
