import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { canonicalize } from 'json-canonicalize';
import type { Plugin } from 'vite';

const root = new URL('../', import.meta.url);
const assetRoot = new URL('src/core/a2ui/assets/', root);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Ship the exact assets the runtime validates, and fail a divergent build. */
export function a2uiAssets(): Plugin {
  return {
    name: 'a2ui-catalog-assets',
    apply: 'build',
    buildStart() {
      this.emitFile({ type: 'asset', fileName: 'a2ui/material-icons-OFL-1.1.txt',
        source: readFileSync(createRequire(import.meta.url).resolve('@fontsource/material-icons/LICENSE')) });
      const manifest = JSON.parse(readFileSync(new URL('manifest.json', assetRoot), 'utf8'));
      const metadata = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
      for (const [name, version] of Object.entries(manifest.packages)) {
        if (name.startsWith('@a2ui/') && metadata.dependencies[name] !== version) {
          throw new Error(`A2UI dependency differs from the catalog manifest: ${name}`);
        }
      }
      for (const [name, source] of Object.entries(manifest.sources)) {
        const bytes = readFileSync(new URL(name, assetRoot));
        if (digest(bytes) !== (source as { raw_sha256: string }).raw_sha256) {
          throw new Error(`A2UI source digest differs: ${name}`);
        }
      }
      const catalog = JSON.parse(readFileSync(new URL('basic-v0_9_1.json', assetRoot), 'utf8'));
      if (digest(canonicalize(catalog)) !== manifest.catalog_digest) {
        throw new Error('A2UI canonical catalog digest differs');
      }
      const legacy = JSON.parse(readFileSync(new URL('legacy-seven-components.json', assetRoot), 'utf8'));
      if (digest(canonicalize(legacy)) !== manifest.legacy_profiles[0].catalog_digest) {
        throw new Error('A2UI compatibility catalog digest differs');
      }
      for (const name of [...Object.keys(manifest.sources), 'legacy-seven-components.json', 'manifest.json']) {
        const file = new URL(name, assetRoot);
        this.addWatchFile(fileURLToPath(file));
        this.emitFile({ type: 'asset', fileName: `a2ui/${name}`, source: readFileSync(file) });
      }
    },
  };
}
