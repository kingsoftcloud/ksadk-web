#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(SCRIPT_DIR, '..');

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const EXPECTED_KEYS = [
  'interaction_contract_digest',
  'package',
  'schema_version',
  'source_commit',
  'version',
];

function git(repoRoot, args, options = {}) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitSucceeds(repoRoot, args) {
  try {
    git(repoRoot, args);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function validateReleaseProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('release provenance must be a JSON object');
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(EXPECTED_KEYS)) {
    throw new Error(`release provenance keys must be exactly: ${EXPECTED_KEYS.join(', ')}`);
  }
  if (value.schema_version !== 1) {
    throw new Error('release provenance schema_version must be 1');
  }
  if (value.package !== '@kingsoftcloud/ksadk-web') {
    throw new Error('release provenance package is not @kingsoftcloud/ksadk-web');
  }
  if (!VERSION_PATTERN.test(value.version)) {
    throw new Error('release provenance version is not valid SemVer');
  }
  if (!COMMIT_PATTERN.test(value.source_commit)) {
    throw new Error('release provenance source_commit must be a full lowercase Git SHA');
  }
  if (!DIGEST_PATTERN.test(value.interaction_contract_digest)) {
    throw new Error('release provenance interaction_contract_digest must be a SHA-256 digest');
  }
  return value;
}

function readJsonAtCommit(repoRoot, commit, path) {
  return JSON.parse(git(repoRoot, ['show', `${commit}:${path}`]));
}

export async function checkReleaseProvenance({
  repoRoot = DEFAULT_REPO_ROOT,
  allowUnreleased = false,
} = {}) {
  const packageJson = await readJson(resolve(repoRoot, 'package.json'));
  const provenance = validateReleaseProvenance(
    await readJson(resolve(repoRoot, 'RELEASE_PROVENANCE.json')),
  );

  if (provenance.package !== packageJson.name || provenance.version !== packageJson.version) {
    throw new Error(
      `RELEASE_PROVENANCE.json identifies ${provenance.package}@${provenance.version}, `
      + `but package.json identifies ${packageJson.name}@${packageJson.version}`,
    );
  }
  if (!gitSucceeds(repoRoot, ['cat-file', '-e', `${provenance.source_commit}^{commit}`])) {
    throw new Error(`provenance source commit does not exist: ${provenance.source_commit}`);
  }
  if (!gitSucceeds(repoRoot, ['merge-base', '--is-ancestor', provenance.source_commit, 'HEAD'])) {
    throw new Error('provenance source commit is not an ancestor of HEAD');
  }

  const sourcePackage = readJsonAtCommit(repoRoot, provenance.source_commit, 'package.json');
  if (sourcePackage.name !== provenance.package || sourcePackage.version !== provenance.version) {
    throw new Error('provenance source commit does not contain the declared package identity');
  }

  const tag = `v${packageJson.version}`;
  const tagExists = gitSucceeds(repoRoot, ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`]);
  const head = git(repoRoot, ['rev-parse', 'HEAD']);
  let currentAheadOfPublishedTag = false;

  if (tagExists) {
    const tagCommit = git(repoRoot, ['rev-parse', `${tag}^{commit}`]);
    currentAheadOfPublishedTag = head !== tagCommit;
    const taggedProvenance = readJsonAtCommit(repoRoot, tag, 'RELEASE_PROVENANCE.json');
    if (JSON.stringify(taggedProvenance) !== JSON.stringify(provenance)) {
      throw new Error(`${tag} is immutable, but RELEASE_PROVENANCE.json no longer matches the tag`);
    }
    if (currentAheadOfPublishedTag && !allowUnreleased) {
      throw new Error(
        `${packageJson.name}@${packageJson.version} is already tagged at ${tag}; `
        + 'bump the patch version before a formal release preflight',
      );
    }
  } else if (!allowUnreleased) {
    const changedSinceSource = git(repoRoot, [
      'diff', '--name-only', provenance.source_commit, 'HEAD', '--',
    ]).split('\n').filter(Boolean);
    const nonAttestationChanges = changedSinceSource.filter(
      (path) => path !== 'RELEASE_PROVENANCE.json',
    );
    if (nonAttestationChanges.length > 0) {
      throw new Error(
        'formal provenance source is not the frozen code commit; changes after it: '
        + nonAttestationChanges.join(', '),
      );
    }
  }

  return {
    package: provenance.package,
    version: provenance.version,
    sourceCommit: provenance.source_commit,
    tag,
    tagExists,
    currentAheadOfPublishedTag,
  };
}

export async function generateReleaseProvenance({
  repoRoot = DEFAULT_REPO_ROOT,
  interactionContractDigest,
} = {}) {
  const dirty = git(repoRoot, ['status', '--porcelain', '--untracked-files=normal']);
  if (dirty) {
    throw new Error('refusing to generate formal provenance from a dirty worktree');
  }

  const packageJson = await readJson(resolve(repoRoot, 'package.json'));
  if (!VERSION_PATTERN.test(packageJson.version)) {
    throw new Error(`package.json version is not valid SemVer: ${packageJson.version}`);
  }
  const tag = `v${packageJson.version}`;
  if (gitSucceeds(repoRoot, ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`])) {
    throw new Error(`refusing to re-sign already tagged version ${tag}`);
  }

  let digest = interactionContractDigest;
  if (!digest) {
    const existing = validateReleaseProvenance(
      await readJson(resolve(repoRoot, 'RELEASE_PROVENANCE.json')),
    );
    digest = existing.interaction_contract_digest;
  }
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error('interaction contract digest must be a lowercase SHA-256 digest');
  }

  const provenance = validateReleaseProvenance({
    schema_version: 1,
    package: packageJson.name,
    version: packageJson.version,
    source_commit: git(repoRoot, ['rev-parse', 'HEAD']),
    interaction_contract_digest: digest,
  });
  await writeFile(
    resolve(repoRoot, 'RELEASE_PROVENANCE.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
    'utf8',
  );
  return provenance;
}

function parseFlags(args) {
  return {
    command: args.find((arg) => !arg.startsWith('--')) ?? 'check',
    allowUnreleased: args.includes('--allow-unreleased'),
    interactionContractDigest: args.find((arg) => arg.startsWith('--interaction-contract-digest='))
      ?.slice('--interaction-contract-digest='.length),
  };
}

export async function main(args = process.argv.slice(2)) {
  const flags = parseFlags(args);
  if (flags.command === 'check') {
    const result = await checkReleaseProvenance({ allowUnreleased: flags.allowUnreleased });
    console.log(
      `release provenance valid: ${result.package}@${result.version} `
      + `source=${result.sourceCommit}`,
    );
    return;
  }
  if (flags.command === 'generate') {
    const result = await generateReleaseProvenance({
      interactionContractDigest: flags.interactionContractDigest,
    });
    console.log(
      `generated formal provenance for ${result.package}@${result.version} `
      + `from frozen commit ${result.source_commit}`,
    );
    return;
  }
  throw new Error('usage: release-provenance.mjs check [--allow-unreleased] | generate [--interaction-contract-digest=<sha256>]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
