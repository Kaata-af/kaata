package expo.modules.kaatasavefile

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

/**
 * Save a file into the PUBLIC Downloads collection through MediaStore.
 *
 * Why MediaStore and not the folder picker: since Android 11 the system
 * blocks ACTION_OPEN_DOCUMENT_TREE from granting the Downloads folder or the
 * storage root, so a picker-based "save to phone" bounces the user between
 * folders they are not allowed to choose. MediaStore.Downloads (API 29+)
 * needs no permission and no picker: insert a row, stream the bytes, done.
 * The file shows up in the Files app under Downloads with the name we gave
 * it (deduped by the provider if it already exists).
 *
 * Below API 29 the collection does not exist and writing to the public
 * Downloads directory requires WRITE_EXTERNAL_STORAGE. We report
 * E_UNSUPPORTED and let JS fall back to the share sheet instead of adding a
 * runtime permission prompt for a shrinking cohort.
 *
 * IS_PENDING is set while streaming and cleared after, so a reader that lists
 * Downloads mid-copy never sees a half-written PDF.
 */
class KaataSaveFileModule : Module() {
  private val appCtx: Context
    get() = appContext.reactContext
      ?: throw CodedException("E_NO_CONTEXT", "React context unavailable", null)

  override fun definition() = ModuleDefinition {
    Name("KaataSaveFile")

    AsyncFunction("saveToDownloads") { sourceUri: String, fileName: String, mimeType: String, promise: Promise ->
      try {
        promise.resolve(saveToDownloads(sourceUri, fileName, mimeType))
      } catch (e: CodedException) {
        promise.reject(e)
      } catch (e: Throwable) {
        promise.reject(CodedException("E_WRITE", e.message ?: "save failed", e))
      }
    }

    // Not the iOS exporter; present so JS can call one name on both platforms
    // without a platform branch reaching into the native layer.
    AsyncFunction("exportFile") { _: String, _: String, promise: Promise ->
      promise.reject(CodedException("E_UNSUPPORTED", "exportFile is iOS-only", null))
    }
  }

  private fun openSource(sourceUri: String): InputStream {
    val uri = Uri.parse(sourceUri)
    return try {
      when (uri.scheme) {
        null, "file" -> FileInputStream(File(uri.path ?: sourceUri))
        else -> appCtx.contentResolver.openInputStream(uri)
          ?: throw CodedException("E_SOURCE", "cannot open $sourceUri", null)
      }
    } catch (e: CodedException) {
      throw e
    } catch (e: Throwable) {
      throw CodedException("E_SOURCE", e.message ?: "cannot open source", e)
    }
  }

  private fun saveToDownloads(sourceUri: String, fileName: String, mimeType: String): Map<String, String> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      throw CodedException("E_UNSUPPORTED", "MediaStore.Downloads needs Android 10+", null)
    }
    val resolver = appCtx.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, fileName)
      put(MediaStore.Downloads.MIME_TYPE, mimeType)
      put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
      put(MediaStore.Downloads.IS_PENDING, 1)
    }
    val collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    val item = resolver.insert(collection, values)
      ?: throw CodedException("E_WRITE", "MediaStore refused to create the file", null)

    try {
      openSource(sourceUri).use { input ->
        (resolver.openOutputStream(item)
          ?: throw CodedException("E_WRITE", "cannot open destination", null)).use { out ->
          input.copyTo(out)
        }
      }
      resolver.update(item, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
    } catch (e: Throwable) {
      // Never leave a pending, half-written row behind: it would sit invisible
      // in Downloads and block the name.
      try { resolver.delete(item, null, null) } catch (_: Throwable) {}
      throw if (e is CodedException) e else CodedException("E_WRITE", e.message ?: "copy failed", e)
    }

    // The provider may have deduped the name ("x (1).pdf"); report what it used.
    var displayName = fileName
    resolver.query(item, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) displayName = c.getString(0) ?: fileName
    }
    return mapOf("displayName" to displayName, "uri" to item.toString())
  }
}
