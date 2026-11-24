# EdgeAnalyzer — System Setup & Execution Guide 🚀📱💻

This document provides complete instructions for setting up, running, and verifying the **EdgeAnalyzer** distributed multimodal AI system, including the **Desktop Compute Daemon**, **Langfuse Telemetry Stack**, and **Mobile Application**.

## 📚 Technical Specifications & Architecture

For deep design details, database schemas, hybrid RAG algorithms, and distributed telemetry outbox contracts, consult the dedicated architecture documents:

* 📱 **Mobile Application Design & Architecture**: [`MOBILE_APP_DESIGN.md`](./app-code/MOBILE_APP_DESIGN.md)

* 💻 **Desktop Compute Daemon & Admin UI**: [`DESKTOP_DAEMON_DESIGN.md`](./desktop-daemon/DESKTOP_DAEMON_DESIGN.md)

## ⚙️ Prerequisites & Environment Setup

### 1. Desktop Compute Node (PC)

* **OS**: Linux, macOS, or Windows 10/11 (with WSL2)

* **Node.js**: `v22.5.0` or higher (Required for native `node:sqlite` support)

* **Docker & Docker Compose**: Required for self-hosted Langfuse telemetry suite

* **Ollama Engine**: Local Ollama installation running on port `11434` with at least one text model pulled (e.g., `llama3.1`, `phi3.5:latest`)

### 2. Mobile Device (Android)

* **OS**: Android 10+ (API Level 29+) running on an OpenCL-compatible GPU (Qualcomm Snapdragon recommended)

* **USB Debugging**: Enabled on the physical Android device connected via USB/Wi-Fi

* **Network**: Mobile device and Desktop PC must be connected to the **same Local Area Network (LAN)**

## 🚀 Step 1: Start Self-Hosted Langfuse & Desktop Daemon

Open a terminal on your desktop computer and navigate to `desktop-daemon/`:

```
cd desktop-daemon

```

### A. Launch Telemetry Container Infrastructure

Start PostgreSQL and the Langfuse Telemetry Web UI in detached mode:

```
docker compose -f docker-compose.langfuse.yml up -d

```

* *Wait \~20 seconds for database migrations to settle.*

* **Langfuse Admin Portal**: Open <http://localhost:3000> in your browser.

  * **Email**: `<Your setup Email>`

  * **Password**: `<Your setup Password>`

### B. Launch the Desktop Compute Daemon

Verify Node.js version and launch the TypeScript daemon in development mode:

```
# Ensure Node version is v22.5+
node -v

# Install dependencies if running for the first time
npm install

# Start the daemon
npm run dev

```

The daemon will start:

* **WebSocket RPC Mesh Server**: `ws://0.0.0.0:8080`

* **HTTP Admin & Queue API**: `http://localhost:8080`

* Automatic SQLite WAL database initialization inside `desktop-daemon/db/` (`desktop_queue.db` & `desktop_telemetry.db`).

## 📱 Step 2: Build & Run the Mobile App (`app-code`)

Open a second terminal window and navigate to `app-code/`:

```
cd app-code

```

### A. Initial Dependency Installation (First Time Only)

If dependencies or prebuild files are missing, run:

```
npm install
npx expo prebuild --platform android

```

### B. Launch Development Build on Physical Device

Ensure your physical Android phone is connected via USB with `adb devices` recognizing it:

```
npx expo run:android --device

```

> **Note on Hot Reloading**: If you have already compiled the C++/Kotlin native bindings (`llama.rn` and SAF modules) in a previous build, you do not need to re-run `npx expo run:android`. Simply run `npx expo start` and press `r` in the Metro terminal to reload TypeScript changes.

## ✅ Step 3: End-to-End Verification Checklist

### 1. Check Local SQLite Databases & Web API

* Inspect the `desktop-daemon/db/` folder to confirm `desktop_queue.db` and `desktop_telemetry.db` are created and functioning in WAL mode.

* Open <http://localhost:8080/api/mesh/queue/status> in your desktop browser to inspect real-time GPU queue depth and node performance.

### 2. Verify Distributed Mesh Compute Target

1. Open **EdgeAnalyzer** on your mobile device.

2. Tap the **Compute Target Switcher** pill at the top of the interface.

3. Select your Desktop GPU Node (e.g., `Desktop Node (RTX 4090 / Ollama)`).

4. Prompt the assistant: `"What is the weather right now?"`

5. Watch the Desktop Daemon terminal output:

   * Task enqueues with `priority = 1` $\rightarrow$ transitions to `PROCESSING`.

   * Model requests tool execution (`{"tool": "weather"}`).

   * Desktop transitions row to `AWAITING_TOOL` and yields the GPU slot.

   * Mobile device executes GPS/Weather lookup locally and issues `mcp.resume_task`.

   * Desktop promotes task back to `QUEUED` with `priority = 2` and streams the final synthesis.

### 3. Inspect Distributed Waterfall Traces

* **On Mobile**: Tap the **📊 Telemetry Inspector** icon in the app header or navigate to **📊 Telemetry Inspector** in the drawer.

  * Inspect the turn's multi-span waterfall (`client.context_assembly`, `desktop.queue_wait`, `desktop.ollama_inference`, `client.tool_exec:weather`).

  * Verify TTFT (Time To First Token) and generation rates ($\text{tok/s}$).

  * Verify the green badge: `🟢 Synced with Langfuse`.

* **On Desktop (Langfuse Web UI)**:

  * Open <http://localhost:3000> $\rightarrow$ Navigate to **Traces**.

  * Click on the session ID to view the complete OpenTelemetry GenAI flamegraph, prompt tokens, completion tokens, and VRAM consumption metrics.

## 🛠️ Troubleshooting & Common Fixes

| Issue | Root Cause | Solution | 
| ----- | ----- | ----- | 
| **`node:sqlite` module not found** | Node.js version is lower than `v22.5.0` | Upgrade Node.js via NVM (`nvm install 22.5.0 && nvm use 22.5.0`) | 
| **Mobile app cannot discover Desktop Node** | Devices are on different network subnets or firewall is blocking port 8080 | Ensure both devices share the same Wi-Fi network. Allow TCP/UDP port `8080` in your desktop firewall | 
| **Telemetry stays in pending state (`0/X Synced`)** | Desktop daemon telemetry bridge endpoint unreachable | Tap **⚡ Force Sync** in the mobile Telemetry Inspector, or restart the desktop daemon | 
| **Android build fails on SAF module** | Native prebuild cache out of sync | Run `npx expo prebuild --clean` followed by `npx expo run:android --device` | 
