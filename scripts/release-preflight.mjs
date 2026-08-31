#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReleaseProvenance } from './release-provenance.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');
export const RELEASE_COMMANDS = Object.freeze([
  ['npm', ['test']],
  ['npm', ['run', 'test:node']],
  ['npm', ['run', 'lint']],
  ['npm', ['run', 'build:all']],
  ['npm', ['run', 'test:e2e:conversation']],
  ['npm', ['run', 'test:e2e:demo']],
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const detail = options.capture
      ? `\n${result.stdout ?? ''}${result.stderr ?? ''}`
      : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}${detail}`);
  }
  return result.stdout ?? '';
}

function assertCleanWorktree({ allowDirty }) {
  if (allowDirty) return;
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('unable to inspect Git worktree');
  if (result.stdout.trim()) {
    throw new Error('formal release preflight requires a clean worktree');
  }
}

async function packAndVerify() {
  const tempRoot = await mkdtemp(resolve(tmpdir(), 'ksadk-web-release-'));
  try {
    const packOutput = run(
      'npm',
      // build:all above already exercises the package's complete build surface.
      // Suppress lifecycle scripts here so npm's JSON artifact manifest remains
      // machine-readable instead of being prefixed by Vite reporter output.
      ['pack', '--ignore-scripts', '--json', '--access', 'public', '--pack-destination', tempRoot],
      { capture: true },
    );
    const packResult = JSON.parse(packOutput)[0];
    if (!packResult?.filename || !Array.isArray(packResult.files)) {
      throw new Error('npm pack did not return a structured artifact manifest');
    }
    const packedPaths = new Set(packResult.files.map((entry) => entry.path));
    for (const requiredPath of [
      'dist-lib/conversation.js',
      'dist-lib/public/conversation.d.ts',
      'dist-ksadk/index.html',
      'RELEASE_PROVENANCE.json',
      'schemas/release-provenance.schema.json',
      'CHANGELOG.md',
    ]) {
      if (!packedPaths.has(requiredPath)) {
        throw new Error(`packed artifact is missing ${requiredPath}`);
      }
    }

    const consumerRoot = resolve(tempRoot, 'consumer');
    await mkdir(consumerRoot, { recursive: true });
    await writeFile(
      resolve(consumerRoot, 'package.json'),
      `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
      'utf8',
    );

    const tarball = resolve(tempRoot, basename(packResult.filename));
    run(
      'npm',
      ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund', tarball],
      { cwd: consumerRoot },
    );
    await cp(
      resolve(REPO_ROOT, 'scripts/verify-packed-conversation.mjs'),
      resolve(consumerRoot, 'verify-packed-conversation.mjs'),
    );
    run('node', ['verify-packed-conversation.mjs'], { cwd: consumerRoot });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function parseFlags(args) {
  return {
    allowDirty: args.includes('--allow-dirty'),
    allowUnreleased: args.includes('--allow-unreleased'),
  };
}

export async function main(args = process.argv.slice(2)) {
  const flags = parseFlags(args);
  assertCleanWorktree(flags);
  const provenance = await checkReleaseProvenance({
    repoRoot: REPO_ROOT,
    allowUnreleased: flags.allowUnreleased,
  });
  console.log(
    `verified release provenance ${provenance.package}@${provenance.version} `
    + `(source ${provenance.sourceCommit})`,
  );
  for (const [command, commandArgs] of RELEASE_COMMANDS) {
    run(command, commandArgs);
  }
  await packAndVerify();
  console.log('ksadk-web release preflight passed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
