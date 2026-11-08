package expo.modules.kaatasavefile

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import expo.modules.kotlin.Promise
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

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
  private val locationSaveInProgress = AtomicBoolean(false)
  private val appCtx: Context
    get() = appContext.reactContext
      ?: throw CodedException("E_NO_CONTEXT", "React context unavailable", null)

  override fun definition() = ModuleDefinition {
    Name("KaataSaveFile")

    lateinit var locationPicker: AppContextActivityResultLauncher<SaveLocationOptions, SaveLocationResult>
    RegisterActivityContracts {
      locationPicker = registerForActivityResult(SaveLocationContract())
    }

    AsyncFunction("saveToLocation") Coroutine { sourceUri: String, fileName: String, mimeType: String ->
      if (!locationSaveInProgress.compareAndSet(false, true)) {
        throw CodedException("E_BUSY", "A destination picker is already open", null)
      }
      try {
        requireSafeFileName(fileName)
        if (mimeType.isBlank()) throw CodedException("E_WRITE", "A file type is required", null)
        if (appContext.currentActivity == null) {
          throw CodedException("E_NO_VIEW", "No activity to present the destination picker", null)
        }
        // Validate before creating a destination, and close immediately. The
        // source is reopened only after the user has explicitly chosen Save.
        withContext(Dispatchers.IO) { openSource(sourceUri).use { } }
        val picked = try {
          locationPicker.launch(SaveLocationOptions(fileName, mimeType))
        } catch (e: ActivityNotFoundException) {
          throw CodedException("E_UNSUPPORTED", "No document provider is available", e)
        }
        if (picked.cancelled) {
          null
        } else {
          val destination = picked.uri
            ?: throw CodedException("E_WRITE", "The provider returned no destination", null)
          if (destination.scheme != "content" || destination == Uri.parse(sourceUri)) {
            throw CodedException("E_WRITE", "The provider returned an invalid destination", null)
          }
          var completed = false
          try {
            withContext(Dispatchers.IO) {
              writeSelectedFile(sourceUri, destination, fileName).also { completed = true }
            }
          } catch (e: Throwable) {
            // Also clean up if cancellation arrives between picker dismissal
            // and entry into the IO dispatcher. Keep a fully written file if
            // cancellation only prevents delivering the successful receipt.
            if (!completed) withContext(Dispatchers.IO + NonCancellable) {
              deleteSelectedFile(destination)
            }
            throw when (e) {
              is CancellationException, is CodedException -> e
              else -> CodedException("E_WRITE", "Could not save the selected file", e)
            }
          }
        }
      } finally {
        locationSaveInProgress.set(false)
      }
    }

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

  private suspend fun writeSelectedFile(sourceUri: String, destination: Uri, fileName: String): Map<String, String> {
    val resolver = appCtx.contentResolver
    openSource(sourceUri).use { input ->
      (resolver.openOutputStream(destination, "w")
        ?: throw CodedException("E_WRITE", "Cannot open the selected destination", null)).use { output ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
          currentCoroutineContext().ensureActive()
          val count = input.read(buffer)
          if (count < 0) break
          output.write(buffer, 0, count)
        }
        output.flush()
        currentCoroutineContext().ensureActive()
      }
    }
    val displayName = runCatching {
      resolver.query(destination, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) cursor.getString(0) else null
      }
    }.getOrNull()?.takeIf { it.isNotBlank() } ?: fileName
    return mapOf("displayName" to displayName, "uri" to destination.toString())
  }

  private fun deleteSelectedFile(destination: Uri) {
    // A provider may refuse deletion; preserve the original write error.
    runCatching {
      val resolver = appCtx.contentResolver
      val deleted = runCatching { DocumentsContract.deleteDocument(resolver, destination) }.getOrDefault(false)
      if (!deleted) runCatching { resolver.delete(destination, null, null) }
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
