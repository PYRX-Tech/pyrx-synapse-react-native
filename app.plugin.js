// Expo config plugin entry shim.
//
// Expo's autolink-and-resolve looks for `app.plugin.js` at the package
// root when a customer references this package by name in their
// `app.config.ts` / `app.json` `plugins` array. We forward to the
// compiled plugin in `plugin/build/index.js`.
//
// The actual plugin source lives in `plugin/src/index.ts` and is
// compiled to CommonJS at publish time via `tsc -p plugin/tsconfig.json`
// (see the `build:plugin` script in package.json).
//
// The compiled `plugin/build/index.js` exposes the plugin as
// `exports.default` because the source uses `export default`. Expo's
// config-plugin loader expects the plugin to be the top-level export,
// so we unwrap the default here.
const plugin = require('./plugin/build');
module.exports = plugin.default || plugin;
