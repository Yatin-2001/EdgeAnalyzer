package expo.modules.modelfile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
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
        @Volatile var activeModelCtx: Int = 4096
        @Volatile var activeModelSupportsVision: Boolean = false
        @Volatile var installedModelsJson: String = "[]"
        @Volatile var activeNodeId: String = ""
        @Volatile var activeNodeName: String = Build.MODEL ?: "Android Mesh Worker"

        // Fair FIFO single-slot gate strictly for inference routes (never blocks /api/mesh/telemetry)
        val inferenceSemaphore = Semaphore(1, true)
        val inferenceQueueDepth = AtomicInteger(0)

        data class InferenceSession(
            val onToken: (String) -> Unit,
            val onSseEvent: (eventName: String, jsonData: String) -> Unit,
            val latch: CountDownLatch
        )
        val activeSessions = ConcurrentHashMap<String, InferenceSession>()

        // Legacy MVP 3 bridge (POST /api/mesh/inference)
        @Volatile var onRequestInference: ((requestId: String, prompt: String) -> Unit)? = null

        // MVP 4 OpenAI-compatible bridge (POST /v1/edge/chat)
        @Volatile var onRequestEdgeChat: ((requestId: String, payloadJson: String) -> Unit)? = null
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
                ss.reuseAddress = true
                ss.bind(InetSocketAddress(PORT))
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

    private fun getBatteryPercentage(): Int {
        return try {
            val intent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            if (level >= 0 && scale > 0) (level * 100) / scale else 100
        } catch (_: Exception) {
            100
        }
    }

    private fun getThermalStateString(): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return try {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                when (pm.currentThermalStatus) {
                    PowerManager.THERMAL_STATUS_NONE,
                    PowerManager.THERMAL_STATUS_LIGHT -> "nominal"
                    PowerManager.THERMAL_STATUS_MODERATE -> "fair"
                    PowerManager.THERMAL_STATUS_SEVERE -> "serious"
                    PowerManager.THERMAL_STATUS_CRITICAL,
                    PowerManager.THERMAL_STATUS_EMERGENCY,
                    PowerManager.THERMAL_STATUS_SHUTDOWN -> "critical"
                    else -> "nominal"
                }
            } catch (_: Exception) {
                "nominal"
            }
        }
        return "nominal"
    }

    private fun buildModelsArray(): Pair<JSONArray, Boolean> {
            val result = JSONArray()
            val seen = HashSet<String>()
            var anyVision = activeModelSupportsVision
            val hasLoaded = activeModelName != "No Model Loaded" && activeModelName.isNotBlank()

            try {
                val installed = JSONArray(installedModelsJson)
                for (i in 0 until installed.length()) {
                    val item = installed.optJSONObject(i) ?: continue
                    val name = item.optString("name", "").trim()
                    if (name.isEmpty()) continue
                    val key = name.lowercase()
                    if (seen.contains(key)) continue
                    seen.add(key)

                    val modality = item.optString("modality", "text")
                    if (modality.equals("vision", ignoreCase = true)) {
                        anyVision = true
                    }
                    val isLoaded = hasLoaded && name.equals(activeModelName, ignoreCase = true)

                    result.put(JSONObject().apply {
                        put("name", name)
                        put("modality", modality)
                        put("parameter_size", "Dynamic")
                        put("size", item.optLong("size", 0L))
                        put("isLoaded", isLoaded)
                    })
                }
            } catch (_: Exception) {}

            if (hasLoaded && !seen.contains(activeModelName.lowercase())) {
                result.put(JSONObject().apply {
                    put("name", activeModelName)
                    put("modality", if (activeModelSupportsVision) "vision" else "text")
                    put("parameter_size", "Dynamic")
                    put("size", 0L)
                    put("isLoaded", true)
                })
            }

            return Pair(result, anyVision)
        }

    private fun handleClient(socket: Socket) {
        try {
            socket.soTimeout = 30000
            val inStream = socket.getInputStream()
            val out = socket.getOutputStream()

            // 1. Read HTTP headers byte-by-byte until \r\n\r\n
            val headerBuffer = ByteArrayOutputStream()
            var prev = -1
            var prevPrev = -1
            var prevPrevPrev = -1
            var b: Int
            while (inStream.read().also { b = it } != -1) {
                headerBuffer.write(b)
                if (prevPrevPrev == '\r'.code && prevPrev == '\n'.code && prev == '\r'.code && b == '\n'.code) {
                    break
                }
                prevPrevPrev = prevPrev
                prevPrev = prev
                prev = b
            }

            if (b == -1 && headerBuffer.size() == 0) return

            val headerStr = headerBuffer.toString("UTF-8")
            val headerLines = headerStr.split("\r\n")
            if (headerLines.isEmpty()) return

            val requestLine = headerLines[0]
            val parts = requestLine.split(" ")
            if (parts.size < 2) return

            val method = parts[0]
            val path = parts[1]

            // 2. Extract Content-Length in exact octets/bytes
            var contentLength = 0
            for (line in headerLines) {
                if (line.lowercase().startsWith("content-length:")) {
                    contentLength = line.substring(15).trim().toIntOrNull() ?: 0
                    break
                }
            }

            if (method == "OPTIONS") {
                sendHttpResponse(socket, out, 204, "No Content", "text/plain", "")
                return
            }

            // Route 1: Non-Blocking Telemetry & Capability Discovery (Never acquires inferenceSemaphore)
            if (method == "GET" && path.startsWith("/api/mesh/telemetry")) {
                val hasModel = activeModelName != "No Model Loaded"
                val (modelsArray, anyVision) = buildModelsArray()
                val hasAnyModel = hasModel || modelsArray.length() > 0
                val remoteClientIp = socket.inetAddress?.hostAddress?.replace("::ffff:", "") ?: ""
                val thermal = getThermalStateString()
                val battery = getBatteryPercentage()
                val currentQueueDepth = inferenceQueueDepth.get()

                val json = JSONObject().apply {
                    put("nodeId", activeNodeId)
                    put("nodeName", activeNodeName)
                    put("tier", "thick_mobile")
                    put("status", if (hasAnyModel) "ready" else "idle")
                    put("activeModel", if (hasModel) activeModelName else JSONObject.NULL)
                    put("nCtx", activeModelCtx)
                    put("queueDepth", currentQueueDepth)
                    put("thermalState", thermal)
                    put("batteryPct", battery)
                    put("gpu", "Qualcomm Adreno (OpenCL)")
                    put("clientIp", remoteClientIp)
                    put("capabilities", JSONObject().apply {
                        put("supportsTools", hasAnyModel)
                        put("supportsStructuredOutput", hasAnyModel)
                        put("supportsVision", anyVision)
                    })
                    put("models", modelsArray)
                }
                sendHttpResponse(socket, out, 200, "OK", "application/json", json.toString())
                return
            }

            // Route 2: MVP 4 OpenAI-Compatible Edge Chat Endpoint (POST /v1/edge/chat)
            if (method == "POST" && path.startsWith("/v1/edge/chat")) {
                val bodyStr = readExactBody(inStream, contentLength)
                val dispatcher = onRequestEdgeChat
                val (modelsArray, _) = buildModelsArray()
                val hasAnyModel = activeModelName != "No Model Loaded" || modelsArray.length() > 0

                // Pre-stream 503 rejection only if zero models exist on the phone
                if (dispatcher == null || !hasAnyModel) {
                   val errJson = JSONObject().apply {
                   put("message", "No models installed on host phone")
                        put("code", "NO_MODEL_LOADED")
                   }.toString()
                   sendHttpResponse(socket, out, 503, "Service Unavailable", "application/json", errJson)
                        return
                   }

                val thermal = getThermalStateString()
                if (thermal == "critical") {
                    val errJson = JSONObject().apply {
                        put("message", "Mobile worker is thermally throttled (critical)")
                        put("code", "THERMAL_CRITICAL")
                    }.toString()
                    sendHttpResponse(socket, out, 503, "Service Unavailable", "application/json", errJson)
                    return
                }

                // Serialize GPU execution (FIFO concurrency = 1)
                inferenceQueueDepth.incrementAndGet()
                var acquired = false
                try {
                    acquired = inferenceSemaphore.tryAcquire(90, TimeUnit.SECONDS)
                    if (!acquired) {
                        val errJson = JSONObject().apply {
                            put("message", "Mobile worker inference queue timed out")
                            put("code", "QUEUE_TIMEOUT")
                        }.toString()
                        sendHttpResponse(socket, out, 503, "Service Unavailable", "application/json", errJson)
                        return
                    }

                    val sseHeader = "HTTP/1.1 200 OK\r\n" +
                            "Content-Type: text/event-stream; charset=utf-8\r\n" +
                            "Cache-Control: no-cache\r\n" +
                            "Connection: close\r\n" +
                            "Access-Control-Allow-Origin: *\r\n\r\n"
                    synchronized(out) {
                        out.write(sseHeader.toByteArray(Charsets.UTF_8))
                        out.flush()
                    }

                    val requestId = "edge_${System.currentTimeMillis()}_${Thread.currentThread().id}"
                    val latch = CountDownLatch(1)

                    activeSessions[requestId] = InferenceSession(
                        onToken = { token ->
                            try {
                                val data = JSONObject().put("content", token).toString()
                                val frame = "event: delta\ndata: $data\n\n"
                                synchronized(out) {
                                    out.write(frame.toByteArray(Charsets.UTF_8))
                                    out.flush()
                                }
                            } catch (_: Exception) {}
                        },
                        onSseEvent = { eventName, jsonData ->
                            try {
                                val frame = "event: $eventName\ndata: $jsonData\n\n"
                                synchronized(out) {
                                    out.write(frame.toByteArray(Charsets.UTF_8))
                                    out.flush()
                                }
                            } catch (_: Exception) {}
                        },
                        latch = latch
                    )

                    // Inject current thermal state into payload for done metrics
                    val enrichedBody = try {
                        val parsed = JSONObject(bodyStr)
                        parsed.put("_workerThermalState", getThermalStateString())
                        parsed.put("_workerBatteryPct", getBatteryPercentage())
                        parsed.toString()
                    } catch (_: Exception) {
                        bodyStr
                    }

                    dispatcher.invoke(requestId, enrichedBody)

                    val finished = latch.await(180, TimeUnit.SECONDS)
                    activeSessions.remove(requestId)

                    if (!finished) {
                        val timeoutErr = JSONObject().apply {
                            put("message", "Mobile worker inference timed out")
                            put("code", "TIMEOUT")
                        }.toString()
                        synchronized(out) {
                            out.write("event: error\ndata: $timeoutErr\n\n".toByteArray(Charsets.UTF_8))
                            out.flush()
                        }
                    }

                    try {
                        socket.shutdownOutput()
                    } catch (_: Exception) {}
                } finally {
                    if (acquired) {
                        inferenceSemaphore.release()
                    }
                    inferenceQueueDepth.decrementAndGet()
                }
                return
            }

            // Route 3: Legacy MVP 3 SSE Streaming Inference (POST /api/mesh/inference)
            if (method == "POST" && path.startsWith("/api/mesh/inference")) {
                val bodyStr = readExactBody(inStream, contentLength)
                val reqJson = JSONObject(bodyStr)

                var promptPayload = reqJson.optString("prompt", "")
                if (promptPayload.isEmpty() && reqJson.has("messages")) {
                    promptPayload = "__MESSAGES_JSON__:" + reqJson.getJSONArray("messages").toString()
                }

                val dispatcher = onRequestInference
                if (dispatcher == null || activeModelName == "No Model Loaded") {
                    val header = "HTTP/1.1 200 OK\r\n" +
                            "Content-Type: text/event-stream\r\n" +
                            "Cache-Control: no-cache\r\n" +
                            "Connection: close\r\n" +
                            "Access-Control-Allow-Origin: *\r\n\r\n"
                    out.write(header.toByteArray(Charsets.UTF_8))
                    out.write("data: {\"token\":\"[Error: No active model loaded on host phone]\"}\n\n".toByteArray(Charsets.UTF_8))
                    out.write("data: [DONE]\n\n".toByteArray(Charsets.UTF_8))
                    out.flush()
                    try { socket.shutdownOutput() } catch (_: Exception) {}
                    return
                }

                inferenceQueueDepth.incrementAndGet()
                var acquired = false
                try {
                    acquired = inferenceSemaphore.tryAcquire(90, TimeUnit.SECONDS)
                    if (!acquired) {
                        sendHttpResponse(socket, out, 503, "Service Unavailable", "text/plain", "Worker busy")
                        return
                    }

                    val header = "HTTP/1.1 200 OK\r\n" +
                            "Content-Type: text/event-stream\r\n" +
                            "Cache-Control: no-cache\r\n" +
                            "Connection: close\r\n" +
                            "Access-Control-Allow-Origin: *\r\n\r\n"
                    synchronized(out) {
                        out.write(header.toByteArray(Charsets.UTF_8))
                        out.flush()
                    }

                    val requestId = "req_${System.currentTimeMillis()}_${Thread.currentThread().id}"
                    val latch = CountDownLatch(1)

                    activeSessions[requestId] = InferenceSession(
                        onToken = { token ->
                            try {
                                val chunk = "data: " + JSONObject().put("token", token).toString() + "\n\n"
                                synchronized(out) {
                                    out.write(chunk.toByteArray(Charsets.UTF_8))
                                    out.flush()
                                }
                            } catch (_: Exception) {}
                        },
                        onSseEvent = { _, _ -> },
                        latch = latch
                    )

                    dispatcher.invoke(requestId, promptPayload)

                    latch.await(120, TimeUnit.SECONDS)
                    activeSessions.remove(requestId)

                    synchronized(out) {
                        out.write("data: [DONE]\n\n".toByteArray(Charsets.UTF_8))
                        out.flush()
                    }
                    try {
                        socket.shutdownOutput()
                    } catch (_: Exception) {}
                } finally {
                    if (acquired) {
                        inferenceSemaphore.release()
                    }
                    inferenceQueueDepth.decrementAndGet()
                }
                return
            }

            sendHttpResponse(socket, out, 404, "Not Found", "text/plain", "Not Found")
        } catch (e: Exception) {
            Log.e(TAG, "Client socket error: ${e.message}", e)
        } finally {
            try { socket.close() } catch (_: Exception) {}
        }
    }

    private fun readExactBody(inStream: java.io.InputStream, contentLength: Int): String {
        if (contentLength <= 0) return "{}"
        val bodyBytes = ByteArray(contentLength)
        var totalBytesRead = 0
        while (totalBytesRead < contentLength) {
            val count = inStream.read(bodyBytes, totalBytesRead, contentLength - totalBytesRead)
            if (count == -1) break
            totalBytesRead += count
        }
        return String(bodyBytes, 0, totalBytesRead, Charsets.UTF_8)
    }

    private fun sendHttpResponse(socket: Socket, out: OutputStream, code: Int, status: String, contentType: String, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val response = "HTTP/1.1 $code $status\r\n" +
                "Content-Type: $contentType\r\n" +
                "Content-Length: ${bytes.size}\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Content-Type, Authorization\r\n" +
                "Connection: close\r\n\r\n"
        synchronized(out) {
            out.write(response.toByteArray(Charsets.UTF_8))
            out.write(bytes)
            out.flush()
        }
        try {
            socket.shutdownOutput()
        } catch (_: Exception) {}
    }

    private fun stopWorker() {
        Log.d(TAG, "stopWorker called")
        isRunning = false
        try { serverSocket?.close() } catch (_: Exception) {}
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