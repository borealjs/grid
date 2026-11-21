// Sets the same version on every package, on their dependencies on each other and on version links in
// the READMEs, then updates the lockfile:  npm run version-packages -- 0.2.0
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PACKAGES, readPkg, writePkg, ROOT, VERSION_RE } from './release-lib.mjs';

const version = process.argv[2];
if (!VERSION_RE.test(version ?? '')) {
  console.error('Usage: npm run version-packages -- <version>   (e.g. 0.2.0 or 0.2.0-beta.1)');
  process.exit(1);
}
const names = new Set(PACKAGES.map((dir) => readPkg(dir).name));
for (const dir of PACKAGES) {
  const pkg = readPkg(dir);
  const from = pkg.version;
  pkg.version = version;
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) if (names.has(dep)) pkg[field][dep] = version;
  }
  writePkg(dir, pkg);
  console.log(`${pkg.name}: ${from} -> ${version}`);
}
// Versions written into the docs (CDN links such as @borealjs/grid-core@0.1.0/...).
const DOCS = ['README.md', 'CONTRIBUTING.md', ...PACKAGES.map((dir) => `${dir}/README.md`)];
const pinned = new RegExp(`(${[...names].map((n) => n.replace(/[/@.-]/g, '\\$&')).join('|')})@\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?`, 'g');
for (const file of DOCS) {
  const path = `${ROOT}${file}`;
  if (!existsSync(path)) continue;
  const text = readFileSync(path, 'utf8');
  const next = text.replace(pinned, `$1@${version}`);
  if (next !== text) {
    writeFileSync(path, next);
    console.log(`${file}: version links -> ${version}`);
  }
}

execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: ROOT, stdio: 'inherit' });
console.log(`\nNext: commit, push, then publish a GitHub release tagged v${version}.`);
