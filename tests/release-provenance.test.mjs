import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  checkReleaseProvenance,
  generateReleaseProvenance,
  validateReleaseProvenance,
} from '../scripts/release-provenance.mjs';

const DIGEST = 'a'.repeat(64);

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function withRepository(run) {
  const root = await mkdtemp(resolve(tmpdir(), 'ksadk-web-provenance-'));
  try {
    git(root, 'init', '--quiet');
    git(root, 'config', 'user.email', 'release-test@example.invalid');
    git(root, 'config', 'user.name', 'Release Test');
    await writeFile(
      resolve(root, 'package.json'),
      `${JSON.stringify({ name: '@kingsoftcloud/ksadk-web', version: '0.3.3' }, null, 2)}\n`,
    );
    await writeFile(resolve(root, 'README.md'), 'fixture\n');
    git(root, 'add', '.');
    git(root, 'commit', '--quiet', '-m', 'freeze candidate');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('release provenance schema is strict and rejects fabricated fields', () => {
  const valid = {
    schema_version: 1,
    package: '@kingsoftcloud/ksadk-web',
    version: '0.3.3',
    source_commit: 'b'.repeat(40),
    interaction_contract_digest: DIGEST,
  };
  assert.equal(validateReleaseProvenance(valid), valid);
  assert.throws(
    () => validateReleaseProvenance({ ...valid, source_commit: 'HEAD' }),
    /full lowercase Git SHA/,
  );
  assert.throws(
    () => validateReleaseProvenance({ ...valid, generated_at: 'whenever' }),
    /keys must be exactly/,
  );
});

test('published JSON schema describes the executable provenance contract', async () => {
  const schema = JSON.parse(await readFile(
    resolve(import.meta.dirname, '../schemas/release-provenance.schema.json'),
    'utf8',
  ));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), [
    'interaction_contract_digest',
    'package',
    'schema_version',
    'source_commit',
    'version',
  ]);
  assert.equal(schema.properties.schema_version.const, 1);
  assert.equal(schema.properties.package.const, '@kingsoftcloud/ksadk-web');
  assert.match('0.3.3', new RegExp(schema.properties.version.pattern));
  assert.match('b'.repeat(40), new RegExp(schema.properties.source_commit.pattern));
  assert.match(DIGEST, new RegExp(schema.properties.interaction_contract_digest.pattern));
});

test('the 0.3.3 candidate remains untagged until the protected release', async () => {
  const result = await checkReleaseProvenance({
    repoRoot: resolve(import.meta.dirname, '..'),
    allowUnreleased: true,
  });
  assert.equal(result.tag, 'v0.3.3');
  assert.equal(result.tagExists, false);
  assert.equal(result.currentAheadOfPublishedTag, false);
});

test('formal provenance generation uses a clean frozen commit and cannot re-sign a tag', async () => {
  await withRepository(async (root) => {
    const frozenCommit = git(root, 'rev-parse', 'HEAD');
    const generated = await generateReleaseProvenance({
      repoRoot: root,
      interactionContractDigest: DIGEST,
    });
    assert.equal(generated.source_commit, frozenCommit);
    assert.deepEqual(
      JSON.parse(await readFile(resolve(root, 'RELEASE_PROVENANCE.json'), 'utf8')),
      generated,
    );

    git(root, 'add', 'RELEASE_PROVENANCE.json');
    git(root, 'commit', '--quiet', '-m', 'attest candidate');
    const checked = await checkReleaseProvenance({ repoRoot: root });
    assert.equal(checked.sourceCommit, frozenCommit);

    git(root, 'tag', 'v0.3.3');
    await assert.rejects(
      generateReleaseProvenance({ repoRoot: root, interactionContractDigest: DIGEST }),
      /already tagged version/,
    );
  });
});

test('formal provenance generation refuses a dirty candidate', async () => {
  await withRepository(async (root) => {
    await writeFile(resolve(root, 'README.md'), 'dirty\n');
    await assert.rejects(
      generateReleaseProvenance({ repoRoot: root, interactionContractDigest: DIGEST }),
      /dirty worktree/,
    );
  });
});
