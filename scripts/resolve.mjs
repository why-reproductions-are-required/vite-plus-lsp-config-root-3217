import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, resolveConfigFile } from 'vite-plus';
import vitePlusPackage from 'vite-plus/package.json' with { type: 'json' };
import { assertInstalledState } from './installed-state.mjs';

const base = fileURLToPath(new URL('../', import.meta.url));
const [method, fixture, cwdChoice] = process.argv.slice(2).filter(arg => arg !== '--baseline');
assertInstalledState();
if (!['current', 'inline', 'api', 'oxlint'].includes(method)
  || !['plain', 'custom'].includes(fixture)
  || !['project', 'other'].includes(cwdChoice)) {
  console.error('Usage: node scripts/resolve.mjs <current|inline|api|oxlint> <plain|custom> <project|other> [--baseline]');
  process.exit(2);
}

const project = path.join(base, 'fixtures', fixture);
const configFile = path.join(project, 'vite.config.ts');
process.chdir(cwdChoice === 'project' ? project : path.join(base, 'fixtures', 'other'));
process.env.VP_VERSION = vitePlusPackage.version;
process.env.VP_COMMAND = 'lint';
process.env.VP_RESOLVING_CONFIG_METADATA = '1';

try {
  let config;
  if (method === 'current') {
    config = await resolveConfig({ configFile }, 'build');
  } else if (method === 'inline') {
    config = await resolveConfig({ root: project, configFile }, 'build');
  } else if (method === 'api') {
    config = await resolveConfigFile(configFile);
  } else {
    // Use the actual loader from the pinned Oxlint release.
    const { loadVitePlusConfigs } = await import('../node_modules/oxlint/dist/js_config.js');
    const raw = JSON.parse(await loadVitePlusConfigs([configFile]));
    const ok = Array.isArray(raw.Success) && !raw.Failures;
    console.log(JSON.stringify({ method, fixture, cwdChoice, ok, raw }));
    process.exit(ok ? 0 : 1);
  }
  console.log(JSON.stringify({
    method, fixture, cwdChoice, ok: true, root: config.root,
    lint: config.lint ?? null, fmt: config.fmt ?? null,
  }));
} catch (error) {
  console.log(JSON.stringify({ method, fixture, cwdChoice, ok: false, error: error.message, stack: error.stack }));
  process.exitCode = 1;
}
