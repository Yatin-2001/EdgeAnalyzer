package expo.modules.modelfile

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class ModelFileModule : Module() {

    override fun definition() = ModuleDefinition {
        Name("ModelFile")

        Events("onWorkerInferenceRequest")

        AsyncFunction("copyContentUriToFile") { sourceUri: String, destinationPath: String ->
            val context: Context =
                requireNotNull(appContext.reactContext) {
                    "React context is not available."
                }

            val uri = Uri.parse(sourceUri)
            if (uri.scheme != "content") {
                throw IllegalArgumentException("Expected a content:// URI, got: $sourceUri")
            }

            val destinationUri = Uri.parse(destinationPath)
            if (destinationUri.scheme != "file") {
                throw IllegalArgumentException("Expected a file:// destination URI, got: $destinationPath")
            }

            val destination = File(
                requireNotNull(destinationUri.path) {
                    "Could not resolve destination path: $destinationPath"
                }
            )

            destination.parentFile?.mkdirs()

            val resolver = context.contentResolver
            val inputStream = resolver.openInputStream(uri)
                ?: throw IllegalStateException("Unable to open content URI: $sourceUri")

            inputStream.use { input ->
                destination.outputStream().use { output ->
                    val buffer = ByteArray(1024 * 1024)
                    while (true) {
                        val bytesRead = input.read(buffer)
                        if (bytesRead == -1) break
                        output.write(buffer, 0, bytesRead)
                    }
                    output.flush()
                }
            }

            if (!destination.exists()) {
                throw IllegalStateException("Destination file was not created: ${destination.absolutePath}")
            }

            destination.absolutePath
        }

        AsyncFunction("getContentUriMetadata") { uriString: String ->
            val uri = Uri.parse(uriString)
            if (uri.scheme != "content") {
                throw IllegalArgumentException("Expected a content:// URI, got: $uriString")
            }

            val resolver =
                appContext.reactContext?.contentResolver
                    ?: throw IllegalStateException("ContentResolver is unavailable")

            var displayName: String? = null
            var sizeBytes: Long? = null

            resolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                null,
                null,
                null
            )?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
                        displayName = cursor.getString(nameIndex)
                    }

                    val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                        sizeBytes = cursor.getLong(sizeIndex)
                    }
                }
            }

            if (displayName.isNullOrBlank()) {
                throw IllegalStateException("Unable to determine original filename.")
            }

            mapOf("name" to displayName, "sizeBytes" to sizeBytes)
        }

        AsyncFunction("isGGUFFile") { fileUriString: String ->
            val fileUri = Uri.parse(fileUriString)
            if (fileUri.scheme != "file") {
                throw IllegalArgumentException("Expected a file:// URI, got: $fileUriString")
            }

            val filePath = fileUri.path
                ?: throw IllegalArgumentException("Could not resolve file path: $fileUriString")

            val file = File(filePath)
            if (!file.exists() || file.length() < 4) return@AsyncFunction false

            file.inputStream().use { input ->
                val header = ByteArray(4)
                val bytesRead = input.read(header)
                if (bytesRead != 4) return@AsyncFunction false

                return@AsyncFunction (
                    header[0] == 0x47.toByte() &&
                    header[1] == 0x47.toByte() &&
                    header[2] == 0x55.toByte() &&
                    header[3] == 0x46.toByte()
                )
            }
        }

        AsyncFunction("startWorkerService") {
            val context: Context = appContext.reactContext ?: run {
                Log.e("ModelFileModule", "appContext.reactContext is null")
                return@AsyncFunction false
            }

            try {
                EdgeComputeWorkerService.onRequestInference = { requestId, prompt ->
                    this@ModelFileModule.sendEvent(
                        "onWorkerInferenceRequest",
                        mapOf("requestId" to requestId, "prompt" to prompt)
                    )
                }

                val intent = Intent(context, EdgeComputeWorkerService::class.java).apply {
                    action = EdgeComputeWorkerService.ACTION_START
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                Log.d("ModelFileModule", "startForegroundService intent dispatched")
                return@AsyncFunction true
            } catch (e: Exception) {
                Log.e("ModelFileModule", "startWorkerService failed: ${e.message}", e)
                throw e
            }
        }

        AsyncFunction("stopWorkerService") {
            val context: Context = appContext.reactContext ?: return@AsyncFunction false
            val intent = Intent(context, EdgeComputeWorkerService::class.java).apply {
                action = EdgeComputeWorkerService.ACTION_STOP
            }
            context.startService(intent)
            EdgeComputeWorkerService.onRequestInference = null
            Log.d("ModelFileModule", "stopWorkerService intent dispatched")
            return@AsyncFunction true
        }

        AsyncFunction("setWorkerActiveModel") { modelName: String ->
            EdgeComputeWorkerService.activeModelName = modelName
            Log.d("ModelFileModule", "setWorkerActiveModel: $modelName")
            return@AsyncFunction true
        }

        AsyncFunction("pushWorkerToken") { requestId: String, token: String ->
            val session = EdgeComputeWorkerService.activeSessions[requestId]
            session?.onToken?.invoke(token)
            return@AsyncFunction true
        }

        AsyncFunction("finishWorkerInference") { requestId: String ->
            val session = EdgeComputeWorkerService.activeSessions[requestId]
            session?.latch?.countDown()
            return@AsyncFunction true
        }
    }
}