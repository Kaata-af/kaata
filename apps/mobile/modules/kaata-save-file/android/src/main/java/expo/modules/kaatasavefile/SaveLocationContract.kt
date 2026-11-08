package expo.modules.kaatasavefile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.exception.CodedException
import java.io.Serializable

internal data class SaveLocationOptions(val fileName: String, val mimeType: String) : Serializable
internal data class SaveLocationResult(val cancelled: Boolean, val uri: Uri?)

/** A one-file Save As operation, not a persistent directory grant. Cloud
 * providers appear here when installed and enabled by the user. */
internal class SaveLocationContract : AppContextActivityResultContract<SaveLocationOptions, SaveLocationResult> {
  override fun createIntent(context: Context, input: SaveLocationOptions): Intent =
    Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = input.mimeType
      putExtra(Intent.EXTRA_TITLE, input.fileName)
    }

  override fun parseResult(input: SaveLocationOptions, resultCode: Int, intent: Intent?): SaveLocationResult =
    SaveLocationResult(resultCode == Activity.RESULT_CANCELED, if (resultCode == Activity.RESULT_OK) intent?.data else null)
}

internal fun requireSafeFileName(fileName: String) {
  if (fileName.isBlank() || fileName == "." || fileName == ".." || fileName.any { it == '/' || it == '\\' || it.code < 32 }) {
    throw CodedException("E_WRITE", "A plain file name is required", null)
  }
}
