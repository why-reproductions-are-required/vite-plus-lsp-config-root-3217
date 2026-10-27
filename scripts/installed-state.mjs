import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vitePlus from 'vite-plus';
import vitePlusPackage from 'vite-plus/package.json' with { type: 'json' };
import manifest from '../package.json' with { type: 'json' };

export const baseline = process.argv.includes('--baseline');
export const mode = baseline ? 'preview' : 'adapted';

export function assertInstalledState() {
  assert.equal(vitePlusPackage.version, manifest.dependencies['vite-plus'],
    'Install the pinned preview with npm ci before running the checks.');
  assert.equal(typeof vitePlus.resolveConfigFile, 'function',
    'Both modes require the published preview API.');

  const oldCall = /config\s*=\s*await resolveConfig\(\{\s*configFile:\s*path\s*\},\s*"build"\)/;
  const newCall = /config\s*=\s*await resolveConfigFile\(path\)/;
  for (const file of ['oxlint/dist/js_config.js', 'oxfmt/dist/cli.js']) {
    const source = readFileSync(new URL(`../node_modules/${file}`, import.meta.url), 'utf8');
    const message = `Expected ${mode} consumers in ${file}. Run npm run patch:${baseline ? 'revert' : 'apply'}.`;
    assert.match(source, baseline ? oldCall : newCall, message);
    assert.doesNotMatch(source, baseline ? newCall : oldCall, message);
  }
}
