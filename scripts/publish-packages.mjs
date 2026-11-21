// Publishes every package whose version is not on npm yet, dependencies first. Safe to re-run: a
// version that is already published is skipped. Prereleases (1.2.0-beta.1) go to the "next" tag.
//   node scripts/publish-packages.mjs [--tag v1.2.3] [--dry-run]
import { execFileSync, spawnSync } from 'node:child_process';
import { PACKAGES, readPkg, ROOT, VERSION_RE } from './release-lib.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const tagIndex = args.indexOf('--tag');
const gitTag = tagIndex >= 0 ? args[tagIndex + 1] : '';

const pkgs = PACKAGES.map((dir) => ({ dir, ...readPkg(dir) }));
const versions = new Set(pkgs.map((p) => p.version));
if (versions.size !== 1) throw new Error(`packages must share one version, found ${[...versions].join(', ')} (npm run version-packages -- <version>)`);
const [version] = versions;
if (!VERSION_RE.test(version)) throw new Error(`not a valid version: ${version}`);
if (gitTag && gitTag !== `v${version}`) throw new Error(`release tag ${gitTag} does not match the package version ${version} (expected v${version})`);

// Dependencies between our packages must point at this exact version.
const names = new Set(pkgs.map((p) => p.name));
for (const p of pkgs) {
  for (const [dep, range] of Object.entries(p.dependencies ?? {})) {
    if (names.has(dep) && range !== version) throw new Error(`${p.name} depends on ${dep}@${range}, expected ${version}`);
  }
}

const published = (name) => {
  try {
    return execFileSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === version;
  } catch {
    return false; // not published (npm view exits non-zero for unknown versions)
  }
};

const distTag = version.includes('-') ? 'next' : 'latest';
for (const p of pkgs) {
  if (published(p.name)) {
    console.log(`skip ${p.name}@${version} (already on npm)`);
    continue;
  }
  const cmd = ['publish', '--workspace', p.dir, '--access', 'public', '--tag', distTag];
  if (dryRun) cmd.push('--dry-run');
  console.log(`npm ${cmd.join(' ')}`);
  const run = spawnSync('npm', cmd, { cwd: ROOT, encoding: 'utf8' });
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  if (run.status !== 0) {
    // Newly published versions can take minutes to show up in `npm view`; npm still refuses a duplicate.
    if (/previously published|cannot publish over/i.test(`${run.stdout}${run.stderr}`)) {
      console.log(`skip ${p.name}@${version} (npm says it is already published)`);
      continue;
    }
    process.exit(run.status ?? 1);
  }
}
