// Shared helpers for the release scripts: the packages, in publish order (dependencies first).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const PACKAGES = ['packages/grid-core', 'packages/react-grid'];

export const pkgPath = (dir) => `${ROOT}${dir}/package.json`;
export const readPkg = (dir) => JSON.parse(readFileSync(pkgPath(dir), 'utf8'));
export const writePkg = (dir, pkg) => writeFileSync(pkgPath(dir), `${JSON.stringify(pkg, null, 2)}\n`);
export { ROOT };

// Semantic version, optionally with a prerelease part (1.2.3, 1.2.3-beta.1).
export const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
