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

  # Bridge → native SDK dependency. Pinned to >= 0.1.1 (the version that
  # added PyrxConfig.sdkVariant — see pyrx-synapse-ios#12). Caret-style
  # constraints aren't a CocoaPods construct, but ">= 0.1.1" accepts every
  # 0.1.x and 0.2.x release while pinning us out of a future 1.0 with
  # breaking API changes — which is what we want until the RN wrapper
  # itself bumps to 1.0 alongside the underlying native.
  s.dependency "PYRXSynapse", ">= 0.1.1"

  # install_modules_dependencies is the canonical RN 0.76+ helper that
  # links the codegen output, React-Core, React-Codegen, RCT-Folly, etc.
  # No manual New-Architecture flag plumbing needed — the helper handles
  # both new-arch and bridge fallback (the latter being our v1 stance:
  # we support new arch only, but the helper guards against build
  # breakage on older RN versions during local dev with link:).
  install_modules_dependencies(s)
end
