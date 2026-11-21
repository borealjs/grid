// `npm run dev`: everything for working on the grid, in one terminal.
//   server  the reference server: /api, the plain JavaScript example and the playground (port 5174)
//   react   the React demo with hot reload of the packages' TypeScript sources (port 5175)
//   build   rebuilds grid-core's dist on every change, for the pages that load the built bundle
// The start page at http://localhost:5174 links all three demos. Ctrl+C stops everything.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const COLORS = { server: 36, react: 35, build: 33 };

const tasks = [
  ['build', ['run', 'build', '--workspace', 'packages/grid-core', '--', '--watch']],
  ['server', ['run', 'serve']],
  ['react', ['run', 'dev', '--workspace', 'examples/react']],
];

const children = [];
let stopping = false;

function prefix(name, stream, out) {
  const tag = `\x1b[${COLORS[name]}m${name.padEnd(6)}\x1b[0m │ `;
  let rest = '';
  stream.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    for (const line of lines) out.write(tag + line + '\n');
  });
  stream.on('end', () => rest && out.write(tag + rest + '\n'));
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}

for (const [name, args] of tasks) {
  const child = spawn(NPM, args, { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '1' }, shell: process.platform === 'win32' });
  prefix(name, child.stdout, process.stdout);
  prefix(name, child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`\n${name} stopped (exit ${code}); stopping the rest.`);
    stop(code ?? 1);
  });
  children.push(child);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

console.log(`\n  Start page: http://localhost:${process.env.PORT ?? 5174}\n`);
