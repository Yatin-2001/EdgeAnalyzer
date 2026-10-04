package expo.modules.modelfile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject

class EdgeComputeWorkerService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var serverSocket: ServerSocket? = null
    private val threadPool = Executors.newCachedThreadPool()
    @Volatile private var isRunning = false

    companion object {
        const val TAG = "EdgeComputeWorker"
        const val PORT = 8765
        const val CHANNEL_ID = "EdgeComputeWorkerChannel"
        const val NOTIFICATION_ID = 4040
        const val ACTION_START = "ACTION_START_WORKER"
        const val ACTION_STOP = "ACTION_STOP_WORKER"

        @Volatile var activeModelName: String = "No Model Loaded"

        data class InferenceSession(
            val onToken: (String) -> Unit,
            val latch: CountDownLatch
        )
        val activeSessions = ConcurrentHashMap<String, InferenceSession>()

        @Volatile var onRequestInference: ((requestId: String, prompt: String) -> Unit)? = null
    }

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "Service onCreate called")
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "onStartCommand action: ${intent?.action}")
        when (intent?.action) {
            ACTION_START -> startWorker()
            ACTION_STOP -> stopWorker()
        }
        return START_STICKY
    }

    private fun startWorker() {
        if (isRunning) {
            Log.d(TAG, "Worker already running on port $PORT")
            return
        }
        isRunning = true

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("EdgeAnalyzer Mesh Node (Active)")
            .setContentText("Port $PORT • Serving local GPU inference to mesh peers")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            Log.d(TAG, "startForeground completed successfully with DATA_SYNC")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to startForeground: ${e.message}", e)
        }

        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "EdgeAnalyzer::WorkerWakeLock").apply {
            acquire(12 * 60 * 60 * 1000L)
        }

        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "EdgeAnalyzer::WorkerWifiLock").apply {
            acquire()
        }

        threadPool.execute {
            try {
                val ss = ServerSocket()
                ss.reuseAddress = true // Allows immediate rebinding even in TIME_WAIT state
                ss.bind(java.net.InetSocketAddress(PORT))
                serverSocket = ss
                Log.d(TAG, "ServerSocket listening successfully on 0.0.0.0:$PORT")
                while (isRunning && serverSocket?.isClosed == false) {
                    val clientSocket = serverSocket?.accept() ?: break
                    threadPool.execute { handleClient(clientSocket) }
                }
            } catch (e: Exception) {
                Log.e(TAG, "ServerSocket error on port $PORT: ${e.message}", e)
            }
        }
    }

    private fun handleClient(socket: Socket) {
        try {
            socket.soTimeout = 15000 // 15-second read timeout
            val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
            val out = socket.getOutputStream()

            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return

            val method = parts[0]
            val path = parts[1]

            // Read headers to determine Content-Length
            var contentLength = 0
            var line: String?
            while (reader.readLine().also { line = it } != null) {
                if (line.isNullOrEmpty()) break
                if (line!!.lowercase().startsWith("content-length:")) {
                    contentLength = line!!.substring(15).trim().toIntOrNull() ?: 0
                }
            }

            // CORS Preflight
            if (method == "OPTIONS") {
                sendHttpResponse(socket, out, 204, "No Content", "text/plain", "")
                return
            }

            // Route 1: Telemetry & Model Discovery
            if (method == "GET" && path.startsWith("/api/mesh/telemetry")) {
                val hasModel = activeModelName != "No Model Loaded"
                val json = JSONObject().apply {
                    put("nodeName", "OnePlus 15")
                    put("tier", "thick_mobile")
                    put("status", if (hasModel) "ready" else "idle")
                    put("activeModel", if (hasModel) activeModelName else null)
                    put("gpu", "Qualcomm Adreno (OpenCL)")
                    put("models", org.json.JSONArray().apply {
                        if (hasModel) {
                            put(JSONObject().apply {
                                put("name", activeModelName)
                                put("parameter_size", "Dynamic")
                                put("size", 0L)
                            })
                        }
                    })
                }
                sendHttpResponse(socket, out, 200, "OK", "application/json", json.toString())
                return
            }

            // Route 2: SSE Streaming Inference
            if (method == "POST" && path.startsWith("/api/mesh/inference")) {
                val bodyChars = CharArray(contentLength)
                reader.read(bodyChars, 0, contentLength)
                val bodyStr = String(bodyChars)
                val reqJson = JSONObject(bodyStr)
                val prompt = reqJson.optString("prompt", "")

                val header = "HTTP/1.1 200 OK\r\n" +
                        "Content-Type: text/event-stream\r\n" +
                        "Cache-Control: no-cache\r\n" +
                        "Connection: keep-alive\r\n" +
                        "Access-Control-Allow-Origin: *\r\n\r\n"
                out.write(header.toByteArray(Charsets.UTF_8))
                out.flush()

                val dispatcher = onRequestInference
                if (dispatcher == null || activeModelName == "No Model Loaded") {
                    val fallback = "data: {\"token\":\"[Error: No active model loaded on host phone]\"}\n\n"
                    out.write(fallback.toByteArray(Charsets.UTF_8))
                    out.write("data: [DONE]\n\n".toByteArray(Charsets.UTF_8))
                    out.flush()
                    return
                }

                val requestId = "req_${System.currentTimeMillis()}"
                val latch = CountDownLatch(1)

                activeSessions[requestId] = InferenceSession(
                    onToken = { token ->
                        try {
                            val chunk = "data: " + JSONObject().put("token", token).toString() + "\n\n"
                            out.write(chunk.toByteArray(Charsets.UTF_8))
                            out.flush()
                        } catch (e: Exception) {}
                    },
                    latch = latch
                )

                dispatcher.invoke(requestId, prompt)

                latch.await(120, TimeUnit.SECONDS)
                activeSessions.remove(requestId)

                out.write("data: [DONE]\n\n".toByteArray(Charsets.UTF_8))
                out.flush()
                return
            }

            sendHttpResponse(socket, out, 404, "Not Found", "text/plain", "Not Found")
        } catch (e: Exception) {
            Log.e(TAG, "Client socket error: ${e.message}")
        } finally {
            try { socket.close() } catch (e: Exception) {}
        }
    }

    private fun sendHttpResponse(socket: Socket, out: OutputStream, code: Int, status: String, contentType: String, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val response = "HTTP/1.1 $code $status\r\n" +
                "Content-Type: $contentType\r\n" +
                "Content-Length: ${bytes.size}\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Content-Type\r\n" +
                "Connection: close\r\n\r\n"
        out.write(response.toByteArray(Charsets.UTF_8))
        out.write(bytes)
        out.flush()
        try {
            socket.shutdownOutput() // Clean FIN handshake to prevent client connection resets
        } catch (e: Exception) {}
    }

    private fun stopWorker() {
        Log.d(TAG, "stopWorker called")
        isRunning = false
        try { serverSocket?.close() } catch (e: Exception) {}
        wakeLock?.let { if (it.isHeld) it.release() }
        wifiLock?.let { if (it.isHeld) it.release() }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Compute Mesh Worker",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps the local Snapdragon compute worker active for client queries"
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopWorker()
        super.onDestroy()
    }
}