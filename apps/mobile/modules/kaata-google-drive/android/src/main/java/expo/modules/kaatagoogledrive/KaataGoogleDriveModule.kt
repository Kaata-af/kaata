package expo.modules.kaatagoogledrive

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.AccountPicker
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Task
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout

private const val DRIVE_FILE = "https://www.googleapis.com/auth/drive.file"

/** Google Drive consent is separate from Kaata's sign-in. Automatic calls never launch a resolution. */
class KaataGoogleDriveModule : Module() {
  private val connecting = AtomicBoolean(false)
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("E_UNAVAILABLE", "Drive is unavailable", null)

  override fun definition() = ModuleDefinition {
    Name("KaataGoogleDrive")

    lateinit var chooseAccount: AppContextActivityResultLauncher<Int, String?>
    lateinit var requestConsent: AppContextActivityResultLauncher<Int, Intent?>
    val consent = ConsentContract()
    RegisterActivityContracts {
      chooseAccount = registerForActivityResult(ChooseAccountContract())
      requestConsent = registerForActivityResult(consent)
    }

    AsyncFunction("connect").Coroutine<String?> {
      if (!connecting.compareAndSet(false, true)) {
        throw CodedException("E_BUSY", "Google Drive is already connecting", null)
      }
      try {
        val email = chooseAccount.launch(0) ?: return@Coroutine null
        val client = Identity.getAuthorizationClient(context)
        val result = client.authorize(request(email)).awaitResult()
        val pendingIntent = result.pendingIntent
        if (pendingIntent == null) {
          result.driveToken()
        } else {
          consent.pendingIntent = pendingIntent
          val data = requestConsent.launch(0) ?: return@Coroutine null
          client.getAuthorizationResultFromIntent(data).driveToken()
        }
      } catch (error: ApiException) {
        if (error.statusCode == CommonStatusCodes.CANCELED) null else throw authorizationError(error)
      } finally {
        consent.pendingIntent = null
        connecting.set(false)
      }
    }

    AsyncFunction("getAccessToken") Coroutine { email: String ->
      try {
        // A resolution here means consent expired or the account left the device.
        Identity.getAuthorizationClient(context).authorize(request(email)).awaitResult().driveToken()
      } catch (error: ApiException) {
        throw authorizationError(error)
      }
    }

    AsyncFunction("clearAccessToken") Coroutine { token: String ->
      val request = ClearTokenRequest.builder().setToken(token).build()
      Identity.getAuthorizationClient(context).clearToken(request).awaitResult()
      Unit
    }
  }
}

private fun request(email: String): AuthorizationRequest = AuthorizationRequest.builder()
  .setAccount(Account(email, "com.google"))
  .setRequestedScopes(listOf(Scope(DRIVE_FILE)))
  .build()

private fun AuthorizationResult.driveToken(): String {
  val token = accessToken
  if (hasResolution() || DRIVE_FILE !in grantedScopes || token.isNullOrBlank()) {
    throw CodedException("E_RECONNECT", "Google Drive needs permission", null)
  }
  return token
}

private fun authorizationError(error: ApiException): CodedException {
  val code = when (error.statusCode) {
    CommonStatusCodes.NETWORK_ERROR, CommonStatusCodes.TIMEOUT -> "E_OFFLINE"
    CommonStatusCodes.SIGN_IN_REQUIRED, CommonStatusCodes.INVALID_ACCOUNT,
    CommonStatusCodes.CANCELED,
    CommonStatusCodes.RESOLUTION_REQUIRED -> "E_RECONNECT"
    else -> "E_UNAVAILABLE"
  }
  return CodedException(code, "Google Drive authorization failed", null)
}

private suspend fun <T> Task<T>.awaitResult(): T {
  try {
    return withTimeout(30_000) {
      suspendCancellableCoroutine { continuation ->
        addOnCompleteListener { task ->
          if (task.isSuccessful) continuation.resume(task.result)
          else continuation.resumeWithException(task.exception ?: CodedException("E_RECONNECT", "Authorization ended", null))
        }
      }
    }
  } catch (error: TimeoutCancellationException) {
    throw CodedException("E_OFFLINE", "Google Drive authorization timed out", null)
  }
}

private class ChooseAccountContract : AppContextActivityResultContract<Int, String?> {
  override fun createIntent(context: Context, input: Int): Intent = AccountPicker.newChooseAccountIntent(
    AccountPicker.AccountChooserOptions.Builder()
      .setAllowableAccountsTypes(listOf("com.google"))
      .setAlwaysShowAccountPicker(true)
      .build()
  )

  override fun parseResult(input: Int, resultCode: Int, intent: Intent?): String? =
    if (resultCode == Activity.RESULT_OK) intent?.getStringExtra(AccountManager.KEY_ACCOUNT_NAME) else null
}

private class ConsentContract : AppContextActivityResultContract<Int, Intent?> {
  var pendingIntent: PendingIntent? = null

  override fun createIntent(context: Context, input: Int): Intent {
    val sender = pendingIntent?.intentSender ?: throw CodedException("E_RECONNECT", "Google Drive needs permission", null)
    return ActivityResultContracts.StartIntentSenderForResult().createIntent(
      context,
      IntentSenderRequest.Builder(sender).build()
    )
  }

  override fun parseResult(input: Int, resultCode: Int, intent: Intent?): Intent? =
    if (resultCode == Activity.RESULT_OK) intent else null
}
