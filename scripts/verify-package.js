#!/usr/bin/env node
/**
 * verify-package.js — pre-publish sanity check.
 *
 * Runs from `npm publish`'s `prepublishOnly` script. Checks that the
 * artifacts we promise to publish actually exist on disk after the
 * `prepare` build has run. Catches the "I bumped the version but
 * forgot to compile the plugin" failure mode before npm uploads.
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — at least one check failed; npm publish should abort
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const REQUIRED_FILES = [
  // JS bundle
  'lib/module/index.js',
  'lib/typescript/src/index.d.ts',
  // Compiled Expo plugin
  'plugin/build/index.js',
  'plugin/build/index.d.ts',
  'plugin/build/ios/appDelegate.js',
  'app.plugin.js',
  // Native sources (shipped as-is, consumed by CocoaPods / Gradle)
  'ios/PyrxSynapseRN/PyrxSynapseAppDelegate.swift',
  'ios/PyrxSynapseRN/PyrxSynapseImpl.swift',
  'ios/PyrxSynapseRN/PyrxSynapseModule.h',
  'ios/PyrxSynapseRN/PyrxSynapseModule.mm',
  'ios/PrivacyInfo.xcprivacy',
  'android/build.gradle',
  'android/src/main/AndroidManifest.xml',
  'android/src/main/java/com/pyrx/synapse/PyrxSynapseModule.kt',
  'android/src/main/java/com/pyrx/synapse/PyrxSynapsePackage.kt',
  // Distribution metadata
  'PyrxSynapseRN.podspec',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'package.json',
];

let ok = true;
for (const rel of REQUIRED_FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.error(`[verify-package] MISSING: ${rel}`);
    ok = false;
  }
}

// Sanity check: package.json `version` matches the latest CHANGELOG
// entry. Catches the "I bumped one but not the other" mistake.
const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')
);
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const versionInChangelog = changelog.match(
  /^##\s*\[?(\d+\.\d+\.\d+[^\]\s]*)\]?/m
);
if (!versionInChangelog) {
  console.error(
    '[verify-package] CHANGELOG.md has no version header — expected ## [X.Y.Z]'
  );
  ok = false;
} else if (versionInChangelog[1] !== pkg.version) {
  console.error(
    `[verify-package] package.json version ${pkg.version} does not match ` +
      `CHANGELOG.md top entry ${versionInChangelog[1]}`
  );
  ok = false;
}

// Sanity check: the compiled plugin exports a function (otherwise Expo
// will fail at customer install with an opaque error).
const compiledPlugin = require(path.join(ROOT, 'app.plugin.js'));
if (typeof compiledPlugin !== 'function') {
  console.error(
    `[verify-package] app.plugin.js does not export a function — Expo ` +
      `will reject this at install. Got: ${typeof compiledPlugin}`
  );
  ok = false;
}

if (!ok) {
  console.error('[verify-package] FAILED — refusing to publish.');
  process.exit(1);
}
console.log('[verify-package] OK — all required artifacts present.');
