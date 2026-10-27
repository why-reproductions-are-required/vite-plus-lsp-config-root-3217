import { lazyPlugins } from 'vite-plus';
import { marker } from './dependency.mjs';

const state = globalThis.__vitePlusCompatibility;
state.moduleLoads += 1;
state.moduleNodeEnv = process.env.NODE_ENV ?? null;
state.dependencyMarker = marker;

export default async function config(env) {
  state.factoryCalls += 1;
  state.factoryNodeEnv = process.env.NODE_ENV ?? null;
  state.factoryEnv = { ...env };
  await Promise.resolve();

  const observer = {
    name: 'compatibility-observer',
    apply(_config, pluginEnv) {
      state.applyEnv = { ...pluginEnv };
      return true;
    },
    config(_config, pluginEnv) {
      state.configEnv = { ...pluginEnv };
    },
    configResolved(config) {
      state.resolvedHook = {
        root: config.root,
        configFile: config.configFile ?? null,
        dependencies: [...config.configFileDependencies],
        inlineConfigFile: config.inlineConfig.configFile,
        inlineKeys: Object.keys(config.inlineConfig).sort(),
        inlineHasUserMarker: config.inlineConfig.define?.__USER_CONFIG_MARKER__ === 'true',
      };
      if (state.caseName === 'requires-config-file' && !config.configFile) {
        throw new Error('The plugin requires config.configFile during configResolved');
      }
    },
  };

  const ssrPlugin = {
    name: 'compatibility-ssr-only',
    apply(_config, pluginEnv) {
      state.ssrApply = pluginEnv.isSsrBuild;
      return pluginEnv.isSsrBuild;
    },
    config() {
      state.ssrHookCalls += 1;
    },
  };

  const lazy = state.caseName === 'lazy-plugins'
    ? lazyPlugins(() => {
      state.lazyFactoryCalls += 1;
      throw new Error('The lazy plugin factory must not run during metadata resolution');
    })
    : undefined;

  return {
    root: 'app',
    mode: 'custom-mode',
    build: { ssr: 'entry.mjs' },
    define: { __USER_CONFIG_MARKER__: 'true' },
    plugins: [observer, ssrPlugin, lazy],
  };
}
