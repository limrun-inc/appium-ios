#!/usr/bin/env node
// Packs the packages Limrun forks as @limrun/* tarballs.
//
// The source keeps upstream package names so rebases stay clean. This script
// renames each package for the pack only, versions it <upstream>-lim.<n>, and
// points the simulator at the renamed xcode package. It packs; publishing the
// tarballs is a separate, deliberate step.
//
// Usage: node scripts/limrun-pack.mjs [--lim <n>] [--out <dir>]

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';

const {values} = parseArgs({
  options: {
    lim: {type: 'string', default: '1'},
    out: {type: 'string', default: 'limrun-dist'},
  },
});

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(root, values.out);
fs.mkdirSync(out, {recursive: true});

// Forked packages, in dependency order.
const FORKED = ['xcode', 'simulator', 'webdriveragent'];

const manifests = Object.fromEntries(
  FORKED.map((dir) => {
    const file = path.join(root, 'packages', dir, 'package.json');
    return [dir, {file, original: fs.readFileSync(file, 'utf8')}];
  }),
);
const limVersion = (pkg) => `${pkg.version}-lim.${values.lim}`;
const names = Object.fromEntries(
  FORKED.map((dir) => {
    const pkg = JSON.parse(manifests[dir].original);
    return [pkg.name, {name: `@limrun/${pkg.name}`, version: limVersion(pkg)}];
  }),
);

try {
  for (const dir of FORKED) {
    const pkg = JSON.parse(manifests[dir].original);
    pkg.name = names[pkg.name].name;
    pkg.version = limVersion(pkg);
    pkg.repository = {
      type: 'git',
      url: 'git+https://github.com/limrun-inc/appium-ios.git',
      directory: `packages/${dir}`,
    };
    pkg.bugs = {url: 'https://github.com/limrun-inc/appium-ios/issues'};
    // Code imports the upstream names, so forked dependencies stay installed under them.
    for (const [dep, renamed] of Object.entries(names)) {
      if (pkg.dependencies?.[dep]) {
        pkg.dependencies[dep] = `npm:${renamed.name}@${renamed.version}`;
      }
    }
    fs.writeFileSync(manifests[dir].file, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  for (const dir of FORKED) {
    const stdout = execFileSync('npm', ['pack', '--json', '--pack-destination', out], {
      cwd: path.join(root, 'packages', dir),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const [{filename}] = JSON.parse(stdout.slice(stdout.indexOf('[')));
    process.stdout.write(`${path.join(out, filename)}\n`);
  }
} finally {
  for (const {file, original} of Object.values(manifests)) {
    fs.writeFileSync(file, original);
  }
}
