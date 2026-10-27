import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const require = createRequire(path.join(root, 'package.json'));
const coreName = '@voidzero-dev/vite-plus-core';
const report = { ok: false, installations: [], consumers: [] };

try {
  const manifest = readJson(path.join(root, 'package.json'));
  const lock = readJson(path.join(root, 'package-lock.json'));
  const vitePlusPath = require.resolve('vite-plus/package.json');
  const vitePlus = readJson(vitePlusPath);
  const expectedAlias = `npm:${coreName}@${vitePlus.version}`;
  const canonicalVitePath = realpathSync(require.resolve('vite/package.json'));
  const canonicalVite = readJson(canonicalVitePath);
  report.vitePlusVersion = vitePlus.version;
  report.vitePackage = { name: canonicalVite.name, version: canonicalVite.version };
  assert.equal(manifest.dependencies.vite, expectedAlias, 'The direct vite dependency must use the matching core alias.');
  assert.equal(manifest.overrides?.vite, expectedAlias, 'The vite override must use the matching core alias.');
  assert.equal(manifest.overrides?.vitest, vitePlus.dependencies.vitest, 'The vitest override must match the bundled version.');
  assert.equal(canonicalVite.name, coreName, 'The root vite import must resolve to Vite+ core.');
  assert.equal(canonicalVite.version, vitePlus.version, 'Vite+ and its core must have the same package version.');

  const anchors = new Set([path.join(root, 'package.json'), vitePlusPath]);
  for (const fixture of readdirSync(path.join(root, 'fixtures'))) {
    const anchor = path.join(root, 'fixtures', fixture, 'package.json');
    if (existsSync(anchor)) anchors.add(anchor);
  }
  for (const [location, entry] of Object.entries(lock.packages)) {
    const anchor = path.join(root, location, 'package.json');
    if (/(^|\/)node_modules\/vite$/.test(location) || entry.name === 'vite') {
      assert.equal(entry.name, coreName, `Standalone Vite remains in the lockfile at ${location}.`);
      assert.equal(entry.version, vitePlus.version, `Unexpected core version in the lockfile at ${location}.`);
      const installed = readJson(anchor);
      assert.equal(installed.name, coreName, `Standalone Vite is installed at ${location}.`);
      assert.equal(installed.version, vitePlus.version, `Unexpected installed core version at ${location}.`);
      assert.equal(realpathSync(anchor), canonicalVitePath, `A separate Vite installation remains at ${location}.`);
      report.installations.push({ location, name: installed.name, version: installed.version });
    }
    // Platform-specific optional packages in the lockfile may not be installed.
    if (!existsSync(anchor)) continue;
    const installed = readJson(anchor);
    if (['dependencies', 'peerDependencies', 'optionalDependencies'].some(field => installed[field]?.vite)) {
      anchors.add(anchor);
    }
  }
  assert.ok(report.installations.length > 0, 'The lockfile must contain the Vite+ core alias.');

  for (const anchor of anchors) {
    const consumer = readJson(anchor);
    const vitePath = realpathSync(createRequire(anchor).resolve('vite/package.json'));
    const vite = readJson(vitePath);
    assert.equal(vite.name, coreName, `${consumer.name} resolves standalone Vite.`);
    assert.equal(vite.version, vitePlus.version, `${consumer.name} resolves the wrong Vite+ core version.`);
    assert.equal(vitePath, canonicalVitePath, `${consumer.name} resolves a different Vite instance.`);
    report.consumers.push({
      name: consumer.name,
      manifest: path.relative(root, anchor),
      viteManifest: path.relative(root, vitePath),
    });
  }
  const [vite, vitePlusApi] = await Promise.all([import('vite'), import('vite-plus')]);
  assert.equal(vite.resolveConfig, vitePlusApi.resolveConfig, 'vite and vite-plus must export the same resolveConfig function.');
  report.sameResolveConfig = true;
  report.ok = true;
  console.log(`Verified ${report.consumers.length} consumers: all resolve ${coreName}@${vitePlus.version} from one installation.`);
  console.log('vite and vite-plus share the same resolveConfig function. Details: results/dependencies.json');
} catch (error) {
  report.error = error.stack ?? error.message;
  console.error(`Dependency verification failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  mkdirSync(path.join(root, 'results'), { recursive: true });
  writeFileSync(path.join(root, 'results/dependencies.json'), JSON.stringify(report, null, 2) + '\n');
}
