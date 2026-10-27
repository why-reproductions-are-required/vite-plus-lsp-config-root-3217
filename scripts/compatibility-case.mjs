import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vitePlus from 'vite-plus';
import { u as withConfigMetadataResolution } from '../node_modules/vite-plus/dist/define-config-ChwJcu5e.js';

const caseName = process.argv[2];
const baseline = process.argv.includes('--baseline');
assert.ok(['observe', 'requires-config-file', 'lazy-plugins'].includes(caseName), 'Unknown probe case');
assert.equal(
  typeof vitePlus.resolveConfigFile,
  baseline ? 'undefined' : 'function',
  `The ${baseline ? 'baseline' : 'patched'} probe requires matching installed package state`,
);

const project = fileURLToPath(new URL('../probes/', import.meta.url));
const configFile = path.join(project, 'config.mjs');
// Keep cwd identical to the config directory to isolate API compatibility from root resolution.
process.chdir(project);
delete process.env.NODE_ENV;
delete process.env.VITE_USER_NODE_ENV;
delete process.env.VP_RESOLVING_CONFIG_METADATA;

const state = globalThis.__vitePlusCompatibility = {
  caseName,
  moduleLoads: 0,
  factoryCalls: 0,
  lazyFactoryCalls: 0,
  ssrHookCalls: 0,
};

let outcome;
try {
  const config = baseline
    ? await withConfigMetadataResolution(() => vitePlus.resolveConfig({ configFile }, 'build'))
    : await vitePlus.resolveConfigFile(configFile);
  outcome = {
    ok: true,
    returned: {
      root: config.root,
      configFile: config.configFile ?? null,
      dependencies: [...config.configFileDependencies],
      inlineConfigFile: config.inlineConfig.configFile,
      inlineHasUserMarker: config.inlineConfig.define?.__USER_CONFIG_MARKER__ === 'true',
    },
  };
} catch (error) {
  outcome = { ok: false, error: error.message };
}

console.log(JSON.stringify({
  mode: baseline ? 'baseline' : 'patched',
  cwd: process.cwd(),
  configFile,
  expectedRoot: path.join(project, 'app'),
  metadataMarkerAfter: process.env.VP_RESOLVING_CONFIG_METADATA ?? null,
  ...outcome,
  state,
}));
