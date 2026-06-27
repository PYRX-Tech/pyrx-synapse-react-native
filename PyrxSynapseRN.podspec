require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "PyrxSynapseRN"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  # min_ios_version_supported is provided by the React Native pods helper.
  # RN 0.76+ requires iOS 13.4+; the underlying PYRXSynapse pod ships
  # iOS 14.0+, so the binding-side floor is whichever is higher. Apps
  # using this wrapper inherit the same floor.
  s.platforms    = { :ios => "14.0" }
  s.source       = { :git => "https://github.com/PYRX-Tech/pyrx-synapse-react-native.git", :tag => "v#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm,swift,cpp}"
  s.private_header_files = "ios/**/*.h"

  # Apple Privacy Manifest — declares the SDK's data use categories. RN
  # 0.76+ ship templates with one; we keep ours alongside the bridge
  # sources so it gets packaged in the framework bundle.
  s.resource_bundles = {
    "PyrxSynapseRN_Privacy" => ["ios/PrivacyInfo.xcprivacy"]
  }

  # Bridge → native SDK dependency. Pinned to ~> 0.1.2 (the version that
  # added the public observer surface — `Pyrx.shared.observe(...)` and
  # `Pyrx.shared.events()` AsyncStream — landed in Phase 9.2.1 PR-1,
  # tracked at pyrx-synapse-ios#13).
  #
  # The `~> 0.1.2` pessimistic constraint accepts every 0.1.x patch
  # (0.1.2, 0.1.3, ...) but EXCLUDES 0.2.0 — which is what we want: the
  # observer event taxonomy is frozen for the 0.1.x line, and a 0.2.0
  # would carry breaking changes the RN bridge must opt into explicitly.
  # When the native SDK bumps to 0.2.0, this wrapper bumps to 0.3.0 and
  # tightens to "~> 0.2".
  #
  # Why 0.1.2 specifically (and not 0.1.1 with a wide pin): the bridge
  # at this version SUBSCRIBES to `Pyrx.shared.events()` to forward
  # native events into RN's `RCTEventEmitter`. That subscription would
  # fail to compile against 0.1.1 (no observer API existed yet) and
  # would silently misbehave if a customer's Podfile resolved 0.1.1
  # through a separate transitive pin. The strict floor protects them.
  s.dependency "PYRXSynapse", "~> 0.1.2"

  # install_modules_dependencies is the canonical RN 0.76+ helper that
  # links the codegen output, React-Core, React-Codegen, RCT-Folly, etc.
  # No manual New-Architecture flag plumbing needed — the helper handles
  # both new-arch and bridge fallback (the latter being our v1 stance:
  # we support new arch only, but the helper guards against build
  # breakage on older RN versions during local dev with link:).
  install_modules_dependencies(s)
end
