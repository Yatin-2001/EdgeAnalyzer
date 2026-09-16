package expo.modules.modelfile

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class ModelFileModule : Module() {

    override fun definition() = ModuleDefinition {
        Name("ModelFile")

        /**
         * Copies a content:// URI exposed by Android's document picker
         * into an app-private file:// destination.
         */
        AsyncFunction("copyContentUriToFile") {
                sourceUri: String,
                destinationPath: String ->

            val context: Context =
                requireNotNull(appContext.reactContext) {
                    "React context is not available."
                }

            val uri = Uri.parse(sourceUri)

            if (uri.scheme != "content") {
                throw IllegalArgumentException(
                    "Expected a content:// URI, got: $sourceUri"
                )
            }

            val destinationUri = Uri.parse(destinationPath)

            if (destinationUri.scheme != "file") {
                throw IllegalArgumentException(
                    "Expected a file:// destination URI, got: $destinationPath"
                )
            }

            val destination = File(
                requireNotNull(destinationUri.path) {
                    "Could not resolve destination path: $destinationPath"
                }
            )

            destination.parentFile?.mkdirs()

            val resolver = context.contentResolver

            val inputStream = resolver.openInputStream(uri)
                ?: throw IllegalStateException(
                    "Unable to open content URI: $sourceUri"
                )

            inputStream.use { input ->

                destination.outputStream().use { output ->

                    val buffer = ByteArray(1024 * 1024)

                    while (true) {
                        val bytesRead = input.read(buffer)

                        if (bytesRead == -1) {
                            break
                        }

                        output.write(buffer, 0, bytesRead)
                    }

                    output.flush()
                }
            }

            if (!destination.exists()) {
                throw IllegalStateException(
                    "Destination file was not created: ${destination.absolutePath}"
                )
            }

            destination.absolutePath
        }

        /**
         * Retrieves metadata for a model selected through Android's
         * Storage Access Framework.
         *
         * Example:
         *
         * content://com.android.providers.downloads.documents/document/msf%3A18903
         *
         * Returns the actual filename rather than the opaque document ID.
         */
        AsyncFunction("getContentUriMetadata") { uriString: String ->

            val uri = Uri.parse(uriString)

            if (uri.scheme != "content") {
                throw IllegalArgumentException(
                    "Expected a content:// URI, got: $uriString"
                )
            }

            val resolver =
                appContext.reactContext?.contentResolver
                    ?: throw IllegalStateException(
                        "ContentResolver is unavailable"
                    )

            var displayName: String? = null
            var sizeBytes: Long? = null

            resolver.query(
                uri,
                arrayOf(
                    OpenableColumns.DISPLAY_NAME,
                    OpenableColumns.SIZE
                ),
                null,
                null,
                null
            )?.use { cursor ->

                if (cursor.moveToFirst()) {

                    val nameIndex =
                        cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)

                    if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
                        displayName = cursor.getString(nameIndex)
                    }

                    val sizeIndex =
                        cursor.getColumnIndex(OpenableColumns.SIZE)

                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                        sizeBytes = cursor.getLong(sizeIndex)
                    }
                }
            }

            if (displayName.isNullOrBlank()) {
                throw IllegalStateException(
                    "Unable to determine the original filename from the selected model."
                )
            }

            mapOf(
                "name" to displayName,
                "sizeBytes" to sizeBytes
            )
        }

        // Get GGUF-extension bytes
        AsyncFunction("isGGUFFile") { fileUriString: String ->

            val fileUri = Uri.parse(fileUriString)

            if (fileUri.scheme != "file") {
                throw IllegalArgumentException(
                    "Expected a file:// URI, got: $fileUriString"
                )
            }

            val filePath = fileUri.path
                ?: throw IllegalArgumentException(
                    "Could not resolve file path: $fileUriString"
                )

            val file = File(filePath)

            if (!file.exists()) {
                throw IllegalArgumentException(
                    "File does not exist: $filePath"
                )
            }

            if (file.length() < 4) {
                return@AsyncFunction false
            }

            file.inputStream().use { input ->

                val header = ByteArray(4)

                val bytesRead = input.read(header)

                if (bytesRead != 4) {
                    return@AsyncFunction false
                }

                return@AsyncFunction (
                        header[0] == 0x47.toByte() && // G
                                header[1] == 0x47.toByte() && // G
                                header[2] == 0x55.toByte() && // U
                                header[3] == 0x46.toByte()    // F
                        )
            }
        }
    }
}