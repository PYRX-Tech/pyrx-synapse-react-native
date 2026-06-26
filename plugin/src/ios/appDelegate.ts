/**
 * AppDelegate inheritance-swap surgery for the PYRX Expo plugin.
 *
 * Why this is its own module
 * --------------------------
 * AppDelegate patching is the single most fragile part of the plugin:
 * Expo templates change across SDK versions, customers customize their
 * AppDelegate freely, and a half-patched file produces a build that
 * silently misroutes pushes. Isolating the surgery here makes it
 * testable in pure TS without the rest of @expo/config-plugins'
 * file-system machinery.
 *
 * Design principles
 * -----------------
 * 1. **Idempotent.** Running the plugin twice (the customer adds it,
 *    runs `expo prebuild`, then re-runs prebuild) must not double-patch.
 *    We detect "already patched" via the presence of our import line.
 * 2. **Conservative.** If the file doesn't match the expected shape,
 *    throw a clear error rather than producing a half-patched file.
 *    The customer reads the error, switches to the bare-install path.
 * 3. **Pure functions.** Take a string, return a string. No I/O.
 *    Tested in unit tests with sample Expo templates as fixtures.
 *
 * What "the expected shape" means
 * -------------------------------
 * - **Swift (SDK 53+)**: the file has a `class AppDelegate: ExpoAppDelegate`
 *   declaration. We rewrite to `class AppDelegate: PyrxSynapseAppDelegate`
 *   and add `import PyrxSynapseRN` after the existing imports.
 * - **ObjC (SDK 52)**: the file has either `@interface AppDelegate :
 *   RCTAppDelegate` (in AppDelegate.h, often inlined in .mm) or
 *   `@implementation AppDelegate` with the parent declared elsewhere.
 *   We rewrite `: RCTAppDelegate` → `: PyrxSynapseAppDelegate` and add
 *   `#import <PyrxSynapseRN/PyrxSynapseRN-Swift.h>` after the existing
 *   imports.
 *
 * Customers with non-standard parent classes (a custom AppDelegate that
 * doesn't extend ExpoAppDelegate / RCTAppDelegate) will trigger the
 * "unrecognized shape" error and should use the bare-install path,
 * where the 5-method-forwarding fallback is documented.
 */

const PYRX_SWIFT_IMPORT = 'import PyrxSynapseRN';
const PYRX_OBJC_IMPORT = '#import <PyrxSynapseRN/PyrxSynapseRN-Swift.h>';
const PYRX_BASE_CLASS = 'PyrxSynapseAppDelegate';

// Recognized parent classes that we know how to swap. Order matters —
// `ExpoAppDelegate` is the SDK 53+ default; `RCTAppDelegate` is the
// SDK 52 default and the bare-RN default.
const SWIFT_PARENTS_TO_REPLACE = ['ExpoAppDelegate', 'RCTAppDelegate'];
const OBJC_PARENTS_TO_REPLACE = ['RCTAppDelegate'];

/**
 * Patch an AppDelegate.swift to inherit from `PyrxSynapseAppDelegate`.
 *
 * @param contents — the raw file text
 * @param pluginName — used in error messages
 * @returns the patched file text
 * @throws if the file's structure isn't recognized
 */
export function patchAppDelegateSwift(
  contents: string,
  pluginName: string
): string {
  // Idempotency guard. We use the import line as the marker — once
  // present, the customer's file has already been patched and we
  // return it unchanged.
  if (contents.includes(PYRX_SWIFT_IMPORT)) {
    return contents;
  }

  // 1. Find and rewrite the class declaration.
  //
  // Match patterns we accept:
  //   class AppDelegate: ExpoAppDelegate
  //   public class AppDelegate: ExpoAppDelegate
  //   @main class AppDelegate: ExpoAppDelegate
  //   class AppDelegate : ExpoAppDelegate        (note the space)
  //
  // We deliberately do NOT accept `final` — final classes can't be
  // subclassed in Swift, which would break customer subclasses of
  // PyrxSynapseAppDelegate. If a customer marks AppDelegate `final`,
  // they have to remove it first.
  let parentFound: string | null = null;
  for (const parent of SWIFT_PARENTS_TO_REPLACE) {
    // Regex: capture `class AppDelegate` (with optional modifiers) and
    // the `: <parent>` segment. We rewrite the parent name only,
    // preserving the rest of the line (Swift conformance lists like
    // `: ExpoAppDelegate, UNUserNotificationCenterDelegate` survive
    // intact — we only swap the first listed type).
    const re = new RegExp(`(class\\s+AppDelegate\\s*:\\s*)${parent}\\b`, 'g');
    if (re.test(contents)) {
      contents = contents.replace(re, `$1${PYRX_BASE_CLASS}`);
      parentFound = parent;
      break;
    }
  }

  if (!parentFound) {
    throw new Error(
      `[${pluginName}] Could not find a recognized AppDelegate parent class ` +
        `in AppDelegate.swift. Expected one of: ${SWIFT_PARENTS_TO_REPLACE.join(
          ', '
        )}. ` +
        `If your AppDelegate inherits from a custom base class, use the ` +
        `bare-install path: docs/INSTALL-BARE.md.`
    );
  }

  // 2. Add the PyrxSynapseRN import after the last existing `import`.
  //
  // We insert AFTER the last import to keep the imports grouped and to
  // avoid surprising the customer's import order. If for some reason
  // the file has no imports (unlikely), we prepend.
  const importRegex = /^import\s+\S+.*$/gm;
  const importMatches = [...contents.matchAll(importRegex)];
  if (importMatches.length === 0) {
    contents = `${PYRX_SWIFT_IMPORT}\n${contents}`;
  } else {
    const lastImport = importMatches[importMatches.length - 1];
    const insertAt = (lastImport.index ?? 0) + lastImport[0].length;
    contents =
      contents.slice(0, insertAt) +
      `\n${PYRX_SWIFT_IMPORT}` +
      contents.slice(insertAt);
  }

  return contents;
}

/**
 * Patch an AppDelegate.mm (ObjC++) to inherit from
 * `PyrxSynapseAppDelegate`.
 *
 * @param contents — the raw file text
 * @param pluginName — used in error messages
 * @returns the patched file text
 * @throws if the file's structure isn't recognized
 */
export function patchAppDelegateObjC(
  contents: string,
  pluginName: string
): string {
  // Idempotency guard. We use the import line as the marker.
  if (contents.includes(PYRX_OBJC_IMPORT)) {
    return contents;
  }

  // 1. Find and rewrite the @interface declaration.
  //
  // ObjC inheritance lives in @interface, typically inside
  // AppDelegate.h but in modern Expo templates inlined into AppDelegate.mm
  // via a top-of-file `@interface AppDelegate : RCTAppDelegate ...`
  // section.
  let parentFound: string | null = null;
  for (const parent of OBJC_PARENTS_TO_REPLACE) {
    // Regex: capture `@interface AppDelegate` and the `: <parent>`
    // segment. We rewrite the parent name only, preserving any
    // protocol conformance like `<UIApplicationDelegate>`.
    const re = new RegExp(
      `(@interface\\s+AppDelegate\\s*:\\s*)${parent}\\b`,
      'g'
    );
    if (re.test(contents)) {
      contents = contents.replace(re, `$1${PYRX_BASE_CLASS}`);
      parentFound = parent;
      break;
    }
  }

  if (!parentFound) {
    throw new Error(
      `[${pluginName}] Could not find a recognized AppDelegate parent class ` +
        `in AppDelegate.mm. Expected one of: ${OBJC_PARENTS_TO_REPLACE.join(
          ', '
        )}. ` +
        `If your AppDelegate inherits from a custom base class, use the ` +
        `bare-install path: docs/INSTALL-BARE.md.`
    );
  }

  // 2. Add the PyrxSynapseRN-Swift bridging header import after the
  //    last existing `#import` line. ObjC consumes Swift modules via
  //    the autogenerated `-Swift.h` header.
  const importRegex = /^#import\s+.+$/gm;
  const importMatches = [...contents.matchAll(importRegex)];
  if (importMatches.length === 0) {
    contents = `${PYRX_OBJC_IMPORT}\n${contents}`;
  } else {
    const lastImport = importMatches[importMatches.length - 1];
    const insertAt = (lastImport.index ?? 0) + lastImport[0].length;
    contents =
      contents.slice(0, insertAt) +
      `\n${PYRX_OBJC_IMPORT}` +
      contents.slice(insertAt);
  }

  return contents;
}
