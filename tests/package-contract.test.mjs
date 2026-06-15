import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const publishWorkflow = await readFile(new URL('../.github/workflows/publish-npm.yml', import.meta.url), 'utf8');

test('package metadata exposes release artifacts and public entrypoints', () => {
  assert.equal(packageJson.name, '@kingsoftcloud/ksadk-web');
  assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.deepEqual(packageJson.publishConfig, { access: 'public' });
  assert.equal(packageJson.scripts['build:lib'], 'vite build --config vite.lib.config.ts && tsc -p tsconfig.lib.json');
  assert.equal(packageJson.scripts['build:all'], 'npm run build:ksadk && npm run build:hosted && npm run build:lib');

  assert.deepEqual(Object.keys(packageJson.exports).sort(), [
    '.',
    './capabilities',
    './components',
    './runtime',
    './styles',
    './types',
  ]);
  assert.equal(packageJson.exports['./runtime'].types, './dist-lib/public/runtime.d.ts');
  assert.equal(packageJson.exports['./runtime'].import, './dist-lib/runtime.js');
  assert.equal(packageJson.exports['./components'].types, './dist-lib/public/components.d.ts');
  assert.equal(packageJson.exports['./capabilities'].types, './dist-lib/public/capabilities.d.ts');
  assert.equal(packageJson.exports['./types'].types, './dist-lib/public/types.d.ts');
  assert.equal(packageJson.exports['./styles'], './dist-lib/styles.css');

  assert.ok(packageJson.files.includes('dist-lib'));
  assert.ok(packageJson.files.includes('dist-ksadk'));
  assert.ok(packageJson.files.includes('README.md'));
  assert.ok(packageJson.files.includes('CHANGELOG.md'));
  assert.ok(packageJson.files.includes('LICENSE'));
});

test('react is a peer dependency for hosted-ui consumers', () => {
  assert.equal(packageJson.peerDependencies.react, '^19.2.4');
  assert.equal(packageJson.peerDependencies['react-dom'], '^19.2.4');
  assert.equal(packageJson.devDependencies.react, '^19.2.4');
  assert.equal(packageJson.devDependencies['react-dom'], '^19.2.4');
  assert.equal(packageJson.dependencies.react, undefined);
  assert.equal(packageJson.dependencies['react-dom'], undefined);
});

test('npm publishing uses trusted publishing instead of repository tokens', () => {
  assert.match(publishWorkflow, /id-token:\s+write/);
  assert.match(publishWorkflow, /npm publish --access public --provenance/);
  assert.doesNotMatch(publishWorkflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
});
