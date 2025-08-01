// Copyright 2015-present 650 Industries. All rights reserved.
package host.exp.exponent.experience

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Bundle
import android.os.Debug
import android.view.View
import android.view.ViewTreeObserver
import android.view.animation.AccelerateInterpolator
import androidx.activity.enableEdgeToEdge
import androidx.core.splashscreen.SplashScreen
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader
import de.greenrobot.event.EventBus
import expo.modules.application.ApplicationModule
import expo.modules.asset.AssetModule
import expo.modules.blur.BlurModule
import expo.modules.camera.CameraViewModule
import expo.modules.clipboard.ClipboardModule
import expo.modules.constants.ConstantsModule
import expo.modules.constants.ConstantsPackage
import expo.modules.core.interfaces.Package
import expo.modules.device.DeviceModule
import expo.modules.easclient.EASClientModule
import expo.modules.filesystem.FileSystemModule
import expo.modules.filesystem.FileSystemPackage
import expo.modules.font.FontLoaderModule
import expo.modules.font.FontUtilsModule
import expo.modules.haptics.HapticsModule
import expo.modules.keepawake.KeepAwakeModule
import expo.modules.keepawake.KeepAwakePackage
import expo.modules.kotlin.ModulesProvider
import expo.modules.kotlin.modules.Module
import expo.modules.lineargradient.LinearGradientModule
import expo.modules.notifications.NotificationsPackage
import expo.modules.storereview.StoreReviewModule
import expo.modules.taskManager.TaskManagerPackage
import expo.modules.trackingtransparency.TrackingTransparencyModule
import expo.modules.webbrowser.WebBrowserModule
import host.exp.exponent.Constants
import host.exp.exponent.di.NativeModuleDepsProvider
import host.exp.exponent.experience.splashscreen.legacy.SplashScreenModule
import host.exp.exponent.experience.splashscreen.legacy.SplashScreenPackage
import host.exp.exponent.kernel.ExperienceKey
import host.exp.exponent.kernel.Kernel.KernelStartedRunningEvent
import host.exp.exponent.utils.ExperienceActivityUtils
import host.exp.exponent.utils.ExperienceRTLManager
import host.exp.exponent.utils.currentDeviceIsAPhone
import org.json.JSONException

open class HomeActivity : BaseExperienceActivity() {
  //region Activity Lifecycle
  override fun onCreate(savedInstanceState: Bundle?) {
    configureSplashScreen(installSplashScreen())
    enableEdgeToEdge()

    if (currentDeviceIsAPhone(this)) {
      // Like on iOS, we lock the orientation only for phones
      @SuppressLint("SourceLockedOrientationActivity")
      requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    }

    super.onCreate(savedInstanceState)

    NativeModuleDepsProvider.instance.inject(HomeActivity::class.java, this)

    manifest = exponentManifest.getKernelManifestAndAssetRequestHeaders().manifest
    experienceKey = try {
      ExperienceKey.fromManifest(manifest!!)
    } catch (e: JSONException) {
      ExperienceKey("")
    }

    // @sjchmiela, @lukmccall: We are consciously not overriding UI mode in Home, because it has no effect.
    // `ExpoAppearanceModule` with which `ExperienceActivityUtils#overrideUiMode` is compatible
    // is disabled in Home as of end of 2020, to fix some issues with dev menu, see:
    // https://github.com/expo/expo/blob/eb9bd274472e646a730fd535a4bcf360039cbd49/android/expoview/src/main/java/versioned/host/exp/exponent/ExponentPackage.java#L200-L207
    // ExperienceActivityUtils.overrideUiMode(mExponentManifest.getKernelManifest(), this);
    ExperienceActivityUtils.configureStatusBar(
      exponentManifest.getKernelManifestAndAssetRequestHeaders().manifest,
      this
    )

    EventBus.getDefault().registerSticky(this)
    kernel.startJSKernel(this)

    ExperienceRTLManager.setRTLPreferences(this, allowRTL = false, forceRTL = false)
  }

  override fun shouldCreateLoadingView(): Boolean {
    // Home app shouldn't show LoadingView as it indicates state when the app's manifest is being
    // downloaded and Splash info is not yet available and this is not the case for Home app
    // (Splash info is known from the start).
    return false
  }

  override fun onResume() {
    SoLoader.init(this, OpenSourceMergedSoMapping)
    super.onResume()
  }
  //endregion Activity Lifecycle
  /**
   * This method has been split out from onDestroy lifecycle method to [ReactNativeActivity.destroyReactHost]
   * and overridden here as we want to prevent destroying react instance manager when HomeActivity gets destroyed.
   * It needs to continue to live since it is needed for DevMenu to work as expected (it relies on ExponentKernelModule from that react context).
   */
  override fun destroyReactHost(reason: String) {}

  fun onEventMainThread(event: KernelStartedRunningEvent?) {
    reactHost = kernel.reactHost
    reactNativeHost = kernel.reactNativeHost
    reactSurface = kernel.surface

    reactHost?.onHostResume(this, this)
    reactSurface?.view?.let {
      setReactRootView(it)
    }
    finishLoading()

    if (Constants.DEBUG_COLD_START_METHOD_TRACING) {
      Debug.stopMethodTracing()
    }
  }

  private fun configureSplashScreen(customSplashscreen: SplashScreen) {
    val contentView = findViewById<View>(android.R.id.content)
    val observer = contentView.viewTreeObserver
    observer.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
      override fun onPreDraw(): Boolean {
        if (isLoading) {
          return false
        }
        contentView.viewTreeObserver.removeOnPreDrawListener(this)
        return true
      }
    })

    customSplashscreen.setOnExitAnimationListener { splashScreenViewProvider ->
      val splashScreenView = splashScreenViewProvider.view
      splashScreenView
        .animate()
        .setDuration(450)
        .alpha(0.0f)
        .setInterpolator(AccelerateInterpolator())
        .withEndAction {
          splashScreenViewProvider.remove()
        }.start()
    }
  }

  override fun onError(intent: Intent) {
    intent.putExtra(ErrorActivity.IS_HOME_KEY, true)
    kernel.setHasError()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    // Will update the navigation bar colors if the system theme has changed. This is only relevant for the three button navigation bar.
    enableEdgeToEdge()
    super.onConfigurationChanged(newConfig)
  }

  companion object : ModulesProvider {
    fun homeExpoPackages(): List<Package> {
      return listOf(
        ConstantsPackage(),
        FileSystemPackage(),
        KeepAwakePackage(),
        NotificationsPackage(), // home doesn't use notifications, but we want the singleton modules created
        TaskManagerPackage(), // load expo-task-manager to restore tasks once the client is opened
        SplashScreenPackage()
      )
    }

    override fun getModulesList(): List<Class<out Module>> {
      return listOf(
        AssetModule::class.java,
        BlurModule::class.java,
        CameraViewModule::class.java,
        ClipboardModule::class.java,
        ConstantsModule::class.java,
        DeviceModule::class.java,
        EASClientModule::class.java,
        FileSystemModule::class.java,
        FontLoaderModule::class.java,
        FontUtilsModule::class.java,
        HapticsModule::class.java,
        KeepAwakeModule::class.java,
        LinearGradientModule::class.java,
        SplashScreenModule::class.java,
        TrackingTransparencyModule::class.java,
        StoreReviewModule::class.java,
        WebBrowserModule::class.java,
        ApplicationModule::class.java
      )
    }
  }
}
