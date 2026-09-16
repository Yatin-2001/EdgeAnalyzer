package expo.modules.modelfile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

class EdgeComputeWorkerService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    companion object {
        const val CHANNEL_ID = "EdgeComputeWorkerChannel"
        const val NOTIFICATION_ID = 4040
        const val ACTION_START = "ACTION_START_WORKER"
        const val ACTION_STOP = "ACTION_STOP_WORKER"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startWorker()
            ACTION_STOP -> stopWorker()
        }
        return START_STICKY
    }

    private fun startWorker() {
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("EdgeAnalyzer Mesh Node")
            .setContentText("Serving mobile inference requests to thin clients...")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        startForeground(NOTIFICATION_ID, notification)

        // 1. Acquire WakeLock
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "EdgeAnalyzer::WorkerWakeLock").apply {
            acquire(12 * 60 * 60 * 1000L) // 12h safety ceiling
        }

        // 2. Acquire High-Performance Wi-Fi Lock
        val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "EdgeAnalyzer::WorkerWifiLock").apply {
            acquire()
        }
    }

    private fun stopWorker() {
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
                description = "Keeps the edge compute worker active for client queries"
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