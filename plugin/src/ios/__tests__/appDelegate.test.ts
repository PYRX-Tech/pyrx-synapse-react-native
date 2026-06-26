/**
 * Tests for the AppDelegate inheritance-swap surgery.
 *
 * Fixtures mirror real Expo template AppDelegate.swift / AppDelegate.mm
 * outputs so the patcher is exercised against the actual shapes
 * customers run `expo prebuild` to produce.
 */

import { patchAppDelegateObjC, patchAppDelegateSwift } from '../appDelegate';

const PLUGIN_NAME = '@pyrx/synapse-react-native';

// ---------- Swift fixtures ----------

const SWIFT_SDK_53_TEMPLATE = `import Expo
import React
import ReactAppDependencyProvider
import UIKit

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

const SWIFT_WITH_MULTI_PROTOCOL = `import Expo
import UIKit
import UserNotifications

class AppDelegate: ExpoAppDelegate, UNUserNotificationCenterDelegate {
  // implementation
}
`;

const SWIFT_BARE_RN_RCT = `import Foundation
import React
import UIKit

@UIApplicationMain
class AppDelegate: RCTAppDelegate {
  // bare RN with Swift AppDelegate (rare but possible)
}
`;

const SWIFT_CUSTOM_PARENT = `import Foundation
import SomeThirdPartySDK

class AppDelegate: ThirdPartyBaseDelegate {
  // customer's custom parent — we can't auto-patch this
}
`;

// ---------- ObjC fixtures ----------

const OBJC_SDK_52_TEMPLATE = `#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <React/RCTRootView.h>

@interface AppDelegate : RCTAppDelegate
@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  return [super application:application didFinishLaunchingWithOptions:launchOptions];
}

@end
`;

const OBJC_WITH_PROTOCOL = `#import "AppDelegate.h"
#import <React/RCTBundleURLProvider.h>

@interface AppDelegate : RCTAppDelegate <UIApplicationDelegate>
@end

@implementation AppDelegate
@end
`;

const OBJC_CUSTOM_PARENT = `#import "AppDelegate.h"
#import <ThirdParty/ThirdPartyAppDelegate.h>

@interface AppDelegate : ThirdPartyAppDelegate
@end
`;

// ---------- Swift tests ----------

describe('patchAppDelegateSwift', () => {
  it('replaces ExpoAppDelegate parent on the SDK 53+ template', () => {
    const patched = patchAppDelegateSwift(SWIFT_SDK_53_TEMPLATE, PLUGIN_NAME);
    expect(patched).toContain(
      'public class AppDelegate: PyrxSynapseAppDelegate'
    );
    expect(patched).not.toContain(': ExpoAppDelegate');
    expect(patched).toContain('import PyrxSynapseRN');
  });

  it('preserves additional protocol conformances after the parent class', () => {
    const patched = patchAppDelegateSwift(
      SWIFT_WITH_MULTI_PROTOCOL,
      PLUGIN_NAME
    );
    expect(patched).toContain(
      'class AppDelegate: PyrxSynapseAppDelegate, UNUserNotificationCenterDelegate'
    );
  });

  it('replaces RCTAppDelegate parent (Swift bare-RN variant)', () => {
    const patched = patchAppDelegateSwift(SWIFT_BARE_RN_RCT, PLUGIN_NAME);
    expect(patched).toContain('class AppDelegate: PyrxSynapseAppDelegate');
    expect(patched).not.toContain(': RCTAppDelegate');
  });

  it('inserts the PyrxSynapseRN import after the last existing import', () => {
    const patched = patchAppDelegateSwift(SWIFT_SDK_53_TEMPLATE, PLUGIN_NAME);
    const lines = patched.split('\n');
    const lastSdkImportIndex = lines.findIndex((l) =>
      l.includes('import UIKit')
    );
    const pyrxImportIndex = lines.findIndex((l) =>
      l.includes('import PyrxSynapseRN')
    );
    expect(pyrxImportIndex).toBeGreaterThan(lastSdkImportIndex);
  });

  it('is idempotent — running twice produces the same output as running once', () => {
    const once = patchAppDelegateSwift(SWIFT_SDK_53_TEMPLATE, PLUGIN_NAME);
    const twice = patchAppDelegateSwift(once, PLUGIN_NAME);
    expect(twice).toBe(once);
  });

  it('does not double-insert the import on a second run', () => {
    const once = patchAppDelegateSwift(SWIFT_SDK_53_TEMPLATE, PLUGIN_NAME);
    const twice = patchAppDelegateSwift(once, PLUGIN_NAME);
    const importCount = (twice.match(/import PyrxSynapseRN/g) ?? []).length;
    expect(importCount).toBe(1);
  });

  it('throws a clear error when the parent class is not recognized', () => {
    expect(() =>
      patchAppDelegateSwift(SWIFT_CUSTOM_PARENT, PLUGIN_NAME)
    ).toThrow(/Could not find a recognized AppDelegate parent class/);
    expect(() =>
      patchAppDelegateSwift(SWIFT_CUSTOM_PARENT, PLUGIN_NAME)
    ).toThrow(/docs\/INSTALL-BARE\.md/);
  });

  it('throws on completely unrecognized files', () => {
    expect(() =>
      patchAppDelegateSwift('// just a comment', PLUGIN_NAME)
    ).toThrow();
  });
});

// ---------- ObjC tests ----------

describe('patchAppDelegateObjC', () => {
  it('replaces RCTAppDelegate parent on the SDK 52 template', () => {
    const patched = patchAppDelegateObjC(OBJC_SDK_52_TEMPLATE, PLUGIN_NAME);
    expect(patched).toContain(
      '@interface AppDelegate : PyrxSynapseAppDelegate'
    );
    expect(patched).not.toContain(': RCTAppDelegate');
    expect(patched).toContain('#import <PyrxSynapseRN/PyrxSynapseRN-Swift.h>');
  });

  it('preserves protocol conformance angle-bracket lists', () => {
    const patched = patchAppDelegateObjC(OBJC_WITH_PROTOCOL, PLUGIN_NAME);
    expect(patched).toContain(
      '@interface AppDelegate : PyrxSynapseAppDelegate <UIApplicationDelegate>'
    );
  });

  it('inserts the bridging-header import after the last existing #import', () => {
    const patched = patchAppDelegateObjC(OBJC_SDK_52_TEMPLATE, PLUGIN_NAME);
    const lines = patched.split('\n');
    const lastRctImportIndex = lines.findIndex((l) =>
      l.includes('RCTRootView')
    );
    const pyrxImportIndex = lines.findIndex((l) =>
      l.includes('PyrxSynapseRN-Swift.h')
    );
    expect(pyrxImportIndex).toBeGreaterThan(lastRctImportIndex);
  });

  it('is idempotent', () => {
    const once = patchAppDelegateObjC(OBJC_SDK_52_TEMPLATE, PLUGIN_NAME);
    const twice = patchAppDelegateObjC(once, PLUGIN_NAME);
    expect(twice).toBe(once);
  });

  it('does not double-insert the bridging-header import on a second run', () => {
    const once = patchAppDelegateObjC(OBJC_SDK_52_TEMPLATE, PLUGIN_NAME);
    const twice = patchAppDelegateObjC(once, PLUGIN_NAME);
    const importCount = (twice.match(/PyrxSynapseRN-Swift\.h/g) ?? []).length;
    expect(importCount).toBe(1);
  });

  it('throws a clear error when the parent class is not recognized', () => {
    expect(() => patchAppDelegateObjC(OBJC_CUSTOM_PARENT, PLUGIN_NAME)).toThrow(
      /Could not find a recognized AppDelegate parent class/
    );
  });

  it('mentions the bare-install fallback in the error', () => {
    expect(() => patchAppDelegateObjC(OBJC_CUSTOM_PARENT, PLUGIN_NAME)).toThrow(
      /docs\/INSTALL-BARE\.md/
    );
  });
});
