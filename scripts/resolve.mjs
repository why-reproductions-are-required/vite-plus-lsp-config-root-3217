import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile, resolveConfig } from 'vite-plus';
import vitePlusPackage from 'vite-plus/package.json' with { type: 'json' };

const base = fileURLToPath(new URL('../', import.meta.url));
const [method, fixture, cwdChoice] = process.argv.slice(2);
if (!['current', 'inline', 'preserve', 'oxlint'].includes(method)
  || !['plain', 'custom'].includes(fixture)
  || !['project', 'other'].includes(cwdChoice)) {
  console.error('Usage: node scripts/resolve.mjs <current|inline|preserve|oxlint> <plain|custom> <project|other>');
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
  } else if (method === 'preserve') {
    // Diagnostic experiment only: this changes other Vite config semantics.
    const loaded = await loadConfigFromFile({
      command: 'build', mode: 'development', isSsrBuild: false, isPreview: false,
    }, configFile);
    const root = path.resolve(path.dirname(configFile), loaded.config.root ?? '');
    config = await resolveConfig({ ...loaded.config, root, configFile: false }, 'build');
    config.configFile = loaded.path;
    config.configFileDependencies = loaded.dependencies;
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
