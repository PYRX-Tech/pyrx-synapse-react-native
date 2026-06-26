/*
 * PyrxSynapsePackage.kt
 * @pyrx/synapse-react-native — Android package registration.
 *
 * RN autolinking discovers this class from `react-native.config.js`
 * (which we ship at the repo root) and registers it with the React
 * Native runtime at startup. Customers do not need to add anything to
 * their `MainApplication.kt` for autolinking to work on RN 0.76+.
 *
 * For bare-RN customers who use manual linking, the integration is:
 *
 *     // MainApplication.kt
 *     override fun getPackages(): List<ReactPackage> {
 *         return PackageList(this).packages.toMutableList().apply {
 *             // PyrxSynapsePackage is auto-added by PackageList(this) on
 *             // RN 0.76+. No manual add() needed when autolinking is on.
 *         }
 *     }
 */

package com.pyrx.synapse

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class PyrxSynapsePackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
        return if (name == PyrxSynapseModule.NAME) {
            PyrxSynapseModule(reactContext)
        } else {
            null
        }
    }

    override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
        mapOf(
            PyrxSynapseModule.NAME to ReactModuleInfo(
                name = PyrxSynapseModule.NAME,
                className = PyrxSynapseModule.NAME,
                canOverrideExistingModule = false,
                needsEagerInit = false,
                isCxxModule = false,
                isTurboModule = true,
            ),
        )
    }
}
