/**
 * Metro config for the Synapse RN demo.
 *
 * Tweaks the default Expo config so that the locally-linked
 * `@pyrx/synapse-react-native` (which lives in the sibling `../..`
 * directory and is referenced via `"file:../.."` in package.json)
 * resolves cleanly without Metro complaining about modules outside the
 * project root. Without `watchFolders`, Metro silently ignores hot
 * reloads to the SDK source.
 *
 * Customers integrating the package from npm (not from a local
 * `file:` link) do NOT need this configuration — their copy of the
 * package lives inside `node_modules/` and Metro picks it up by
 * default.
 */

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const sdkRoot = path.resolve(projectRoot, '..', '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [sdkRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(sdkRoot, 'node_modules'),
];

config.resolver.disableHierarchicalLookup = true;

module.exports = config;
