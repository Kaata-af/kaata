package expo.modules.kaatainstallreferrer

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean

class KaataInstallReferrerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KaataInstallReferrer")

    AsyncFunction("getInstallReferrer") { installId: String, promise: Promise ->
      val context = appContext.reactContext?.applicationContext
      if (context == null) {
        promise.reject("ERR_INSTALL_REFERRER", "Play install referrer unavailable", null)
        return@AsyncFunction
      }

      // Android preserves firstInstallTime on updates. An existing installation
      // picking up this module should not be counted as a new campaign install.
      @Suppress("DEPRECATION")
      val installedAt = try {
        context.packageManager.getPackageInfo(context.packageName, 0).firstInstallTime
      } catch (_: Exception) {
        promise.reject("ERR_INSTALL_REFERRER", "Installation time unavailable", null)
        return@AsyncFunction
      }
      if (installedAt <= 0L || System.currentTimeMillis() - installedAt !in 0L..FRESH_INSTALL_MS) {
        promise.resolve(null)
        return@AsyncFunction
      }

      // A local data reset can create a different logical install ID while the
      // same APK is still installed. Keep the Play referrer on the original ID.
      val matchesOriginal = try {
        synchronized(installationLock) {
          val prefs = context.getSharedPreferences("kaata_install_referrer", Context.MODE_PRIVATE)
          if (prefs.getLong("installed_at", 0) == installedAt) {
            prefs.getString("install_id", null) == installId
          } else {
            check(prefs.edit().putLong("installed_at", installedAt).putString("install_id", installId).commit())
            true
          }
        }
      } catch (_: Exception) {
        promise.reject("ERR_INSTALL_REFERRER", "Installation binding unavailable", null)
        return@AsyncFunction
      }
      if (!matchesOriginal) {
        promise.resolve(null)
        return@AsyncFunction
      }

      val client = InstallReferrerClient.newBuilder(context).build()
      val handler = Handler(Looper.getMainLooper())
      val settled = AtomicBoolean(false)
      fun finish(value: String?, retry: Boolean) {
        if (!settled.compareAndSet(false, true)) return
        try {
          client.endConnection()
        } catch (_: Exception) {
          // The Play service can disconnect before cleanup.
        }
        if (retry) {
          promise.reject("ERR_INSTALL_REFERRER", "Play install referrer unavailable", null)
        } else {
          promise.resolve(value)
        }
      }

      val timeout = Runnable { finish(null, retry = true) }
      fun complete(value: String?, retry: Boolean) {
        handler.removeCallbacks(timeout)
        finish(value, retry)
      }
      handler.postDelayed(timeout, CONNECTION_TIMEOUT_MS)
      try {
        client.startConnection(object : InstallReferrerStateListener {
          override fun onInstallReferrerSetupFinished(result: Int) {
            when (result) {
              InstallReferrerClient.InstallReferrerResponse.OK -> {
                // The Binder read can block. Keep it off Android's UI thread.
                Thread {
                  try {
                    val referrer = client.installReferrer.installReferrer
                    complete(referrer?.takeIf { it.length <= MAX_REFERRER_LENGTH }, retry = false)
                  } catch (_: Exception) {
                    complete(null, retry = true)
                  }
                }.start()
              }
              InstallReferrerClient.InstallReferrerResponse.FEATURE_NOT_SUPPORTED,
              InstallReferrerClient.InstallReferrerResponse.DEVELOPER_ERROR -> complete(null, retry = false)
              else -> complete(null, retry = true)
            }
          }

          override fun onInstallReferrerServiceDisconnected() {
            complete(null, retry = true)
          }
        })
      } catch (_: Exception) {
        complete(null, retry = true)
      }
    }
  }

  private companion object {
    val installationLock = Any()
    const val FRESH_INSTALL_MS = 24 * 60 * 60_000L
    const val CONNECTION_TIMEOUT_MS = 4_000L
    const val MAX_REFERRER_LENGTH = 4_096
  }
}
