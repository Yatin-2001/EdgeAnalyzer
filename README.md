# EdgeAnalyzer 📱⚡

**EdgeAnalyzer** is an open-source, on-device multimodal AI assistant
for Android. Built with React Native, Expo, and `llama.cpp` bindings, it
enables local inference for large language models (LLMs),
vision-language models (VLMs), and embeddings directly on supported
mobile hardware.

The MVP is designed around four principles:

-   **Local-first inference** --- model inference runs on-device.
-   **Memory-aware execution** --- model loading and vision
    preprocessing are optimized for mobile GPU/RAM constraints.
-   **Agentic tools** --- the local model can iteratively invoke device
    and network tools.
-   **Persistent local state** --- conversations, models, facts, and
    search indexes remain on-device.

------------------------------------------------------------------------

## 1. System Overview & Core Stack

  --------------------------------------------------------------------------
Area                    Technology                 Purpose
  ----------------------- -------------------------- -----------------------
Framework               React Native 0.81.5 / Expo Android application and
SDK 54                     UI

Inference Runtime       `llama.rn` / `llama.cpp`   Local GGUF inference
through native C++/JNI
bindings

GPU Acceleration        OpenCL / Adreno            Hardware acceleration
for supported
Snapdragon devices

Vision Preprocessing    Google ML Kit +            OCR and memory-bounded
`expo-image-manipulator`   image preprocessing

Database                `expo-sqlite` / SQLite 3   Local persistence, WAL,
FTS5, and vector
metadata

Secure Storage          `expo-secure-store` /      Encrypted API-key
Android Keystore           storage

Native Storage Bridge   Custom `ModelFileModule`   Android SAF URI
handling and GGUF
verification
  --------------------------------------------------------------------------

------------------------------------------------------------------------

## 2. Directory Structure

``` text
EdgeAnalyzer/
├── app/
│   ├── _layout.tsx                     # Root layout, Safe Area Provider & Global Theme
│   └── index.tsx                       # Main Chat Controller, Multi-Session Drawer & Navigation
├── modules/
│   └── model-file/                     # Custom Native Android Module
│       ├── android/                    # Native implementation for SAF resolution & GGUF validation
│       ├── index.ts                    # TypeScript module bridge
│       └── src/
│           └── ModelFileModule.ts      # Native bindings
├── src/
│   ├── components/
│   │   ├── ConversationDrawer.tsx      # Historical conversation threads
│   │   ├── ModelRegistryModal.tsx      # Text GGUF / Vision Pair importer
│   │   └── SearchSettingsModal.tsx     # Search API-key configuration
│   ├── database/
│   │   ├── db.ts                       # SQLite initializer, WAL and FTS5 setup
│   │   └── repository.ts               # CRUD queries and persistence operations
│   ├── models/
│   │   └── types.ts                    # Shared model and data contracts
│   ├── screens/
│   │   └── StudioScreen.tsx            # Ephemeral multimodal vision workspace
│   ├── services/
│   │   ├── ContextManager.ts           # Token sliding-window context assembly
│   │   ├── DocumentInspectorService.ts # OCR + image downscaling pipeline
│   │   ├── EmbeddingService.ts         # Dedicated embedding engine
│   │   ├── LLMService.ts               # llama.rn lifecycle, streaming and sampling
│   │   ├── ModelManager.ts             # Permanent model storage and slot management
│   │   ├── SecureStorageService.ts     # Encrypted API-key management
│   │   ├── SemanticMemoryService.ts    # Fact extraction and vector indexing
│   │   └── ToolOrchestrator.ts         # Agent loop and tool invocation
│   └── tools/
│       ├── CalculatorTool.ts            # Sandboxed arithmetic evaluator
│       ├── DeviceLocationTool.ts       # On-device GPS resolver
│       ├── ToolRegistry.ts              # Central tool execution registry
│       ├── types.ts                    # Tool definitions and payload schemas
│       ├── WeatherTool.ts              # Open-Meteo REST API wrapper
│       └── WebSearchTool.ts            # Tavily / Brave Search client
```

------------------------------------------------------------------------

## 3. Core Architectural Pipelines

### A. Hybrid OCR-VLM Pipeline

The vision pipeline separates text extraction from visual understanding.
Full-resolution OCR is performed locally, while the image sent to the
vision projector is downscaled to limit memory consumption.

``` mermaid
flowchart TD
    IMAGE["Incoming Image Asset"]

    IMAGE --> OCR["Google ML Kit OCR<br/>Full-resolution text extraction"]
    IMAGE --> RESIZE["expo-image-manipulator<br/>Longest edge ≤ 448px<br/>JPEG quality 0.75"]

    OCR --> GROUND["Grounding Context Assembly"]
    RESIZE --> GROUND

    GROUND --> TURN1["Turn 1: Grounding Prompt<br/>OCR text + 448px image"]
    TURN1 --> VLM["Vision Model + mmproj<br/>llama.rn / llama.cpp"]

    VLM --> TEXTCTX["Turn 2+<br/>Text-only conversational context"]
    TEXTCTX --> LLM["Text Inference"]
```

**Design goal:** keep the expensive multimodal step limited to the
initial grounding turn. Subsequent turns can use the established textual
context without repeatedly passing the image through the vision
projector.

------------------------------------------------------------------------

### B. Hardware & VRAM Memory Budget

Model loading options in `LLMService.ts` follow these MVP constraints:

  -----------------------------------------------------------------------
Setting                 Value                   Reason
  ----------------------- ----------------------- -----------------------
`use_mlock`             `false`                 Avoids locking large
model allocations into
RAM

`n_gpu_layers`          `99`                    Attempts to offload all
supported layers to
Adreno/OpenCL

`n_threads`             `4`                     Limits CPU thread
contention

Text `n_ctx`            `4096`                  Context window for text
models

Text `n_batch`          `512`                   Text inference batch
size

Vision `n_ctx`          `2048`                  Reduced context for
vision workloads

Vision `n_batch`        `256`                   Reduced batch size for
vision workloads
  -----------------------------------------------------------------------

> These values are application-level tuning targets for the supported
> hardware rather than universal requirements for every Android device.

------------------------------------------------------------------------

### C. Sampling & Anti-Repetition Rules

To reduce repetition loops in small parameter models:

``` text
penalty_repeat:   1.18
penalty_present:  0.15
penalty_last_n:   64
```

Explicit stop-token arrays:

**Llama 3**

``` text
<|eot_id|>
<|end_of_text|>
```

**ChatML / Qwen / SmolVLM**

``` text
<|im_end|>
<|endoftext|>
<|im_start|>
```

------------------------------------------------------------------------

### D. Permanent Model Ingestion

Android Storage Access Framework (`content://`) URIs should not be used
as the long-term model path because access can become invalid after the
app process or permission state changes.

The ingestion flow is:

``` mermaid
flowchart LR
    PICK["Android SAF Picker"]
    URI["content:// URI"]
    NATIVE["ModelFileModule<br/>Native stream copy + GGUF verification"]
    STORAGE["App Document Storage<br/>models/<timestamp>_<filename>.gguf"]
    DB["SQLite Models Registry"]
    LLM["LLMService"]

    PICK --> URI
    URI --> NATIVE
    NATIVE --> STORAGE
    STORAGE --> DB
    DB --> LLM
```

**Rule:** the inference engine and database should reference the
permanent internal file rather than the original SAF URI.

For vision models, the companion `mmproj` is stored alongside the base
model and referenced by its permanent `file://` URI.

------------------------------------------------------------------------

## 4. Database Schema

Database file:

``` text
edge_analyzer.db
```

### a. `models` Table

  -----------------------------------------------------------------------
Column                  Type                    Description
  ----------------------- ----------------------- -----------------------
`id`                    `TEXT PRIMARY KEY`      UUID

`original_name`         `TEXT`                  Display filename

`original_uri`          `TEXT`                  Permanent internal
`file://` URI

`size_bytes`            `INTEGER`               Binary size in bytes

`is_default`            `INTEGER`               `1` if the default chat
model

`is_embedding`          `INTEGER`               `1` if permanently
locked as embedding
model

`modality`              `TEXT`                  `"text"` or `"vision"`

`mmproj_uri`            `TEXT`                  Permanent projector
`file://` URI

`mmproj_filename`       `TEXT`                  Companion projector
filename

`mmproj_size_bytes`     `INTEGER`               Projector size in bytes

`created_at`            `INTEGER`               Epoch timestamp in
milliseconds
  -----------------------------------------------------------------------

### b. `conversations` Table

Column              Type                 Description
  ------------------- -------------------- ------------------------------------
`id`                `TEXT PRIMARY KEY`   `conv_<timestamp>_<random>`
`title`             `TEXT`               Conversation title
`model_id`          `TEXT`               Associated model ID
`created_at`        `INTEGER`            Epoch timestamp in milliseconds
`updated_at`        `INTEGER`            Epoch timestamp in milliseconds
`system_prompt`     `TEXT`               System instructions for the thread
`is_custom_title`   `INTEGER`            `1` if renamed by the user

### c. `messages` & `messages_fts` Tables

Column              Type                 Description
  ------------------- -------------------- ----------------------------------------
`id`                `TEXT PRIMARY KEY`   `msg_<timestamp>_<role>`
`conversation_id`   `TEXT`               Foreign key to `conversations.id`
`role`              `TEXT`               `"system"`, `"user"`, or `"assistant"`
`content`           `TEXT`               Raw message content
`tokens_count`      `INTEGER`            Number of generated tokens
`created_at`        `INTEGER`            Epoch timestamp in milliseconds

`messages_fts` provides full-text search over messages. FTS
synchronization is maintained through repository transactions.

------------------------------------------------------------------------

## 5. Tool Orchestration Contract

`ToolOrchestrator` implements an iterative agent loop with a maximum of
**3 tool-execution steps**.

Models request tools using:

``` json
{
  "tool": "<tool_name>",
  "parameters": {
    "<param_key>": "<param_value>"
  }
}
```

### Supported Tools

a. `calculator` Safely evaluates arithmetic expressions using an AST evaluator

b. `weather` Queries Open-Meteo using coordinates or a geocoded city

c. `device_location` Resolves GPS coordinates through Expo Location

d. `web_search` Searches using Tavily or Brave Search
 

The high-level agent loop is:

``` mermaid
flowchart TD
    USER["User Query"]
    CONTEXT["ContextManager<br/>Conversation + Memory Context"]
    MODEL["Local LLM<br/>llama.rn"]
    DECISION{"Tool call?"}
    TOOL["ToolOrchestrator"]
    RESULT["Tool Result"]
    RESPONSE["Final Streaming Response"]

    USER --> CONTEXT
    CONTEXT --> MODEL
    MODEL --> DECISION

    DECISION -->|No| RESPONSE
    DECISION -->|Yes| TOOL
    TOOL --> RESULT
    RESULT --> CONTEXT

    RESPONSE --> USER
```

The loop is bounded to three tool-execution steps to prevent
uncontrolled local agent loops.

------------------------------------------------------------------------

## 6. Application Architecture

The following diagram summarizes the primary runtime relationships:

``` mermaid
flowchart TD

    UI["React Native / Expo UI<br/>Chat + Studio"]

    UI --> ROUTER["Application Controller"]

    ROUTER --> CHAT["Chat Flow"]
    ROUTER --> STUDIO["Ephemeral Studio"]

    %% Chat flow
    CHAT --> CONTEXT["ContextManager<br/>Sliding-window context"]
    CONTEXT --> MEMORY["SemanticMemoryService"]
    MEMORY --> EMBEDDING["EmbeddingService"]
    EMBEDDING --> DB["SQLite<br/>WAL + FTS5 + Vector Data"]

    MEMORY --> CONTEXT
    CONTEXT --> LLM["LLMService<br/>llama.rn / llama.cpp"]

    %% Vision flow
    STUDIO --> OCR["Google ML Kit OCR"]
    STUDIO --> IMAGE["ImageManipulator<br/>≤ 448px"]
    OCR --> GROUND["Grounding Context"]
    IMAGE --> GROUND
    GROUND --> LLM

    %% Inference
    LLM --> GPU["Adreno GPU<br/>OpenCL"]
    GPU --> MODEL["Local GGUF Model"]

    %% Tools
    LLM --> TOOL_DECISION{"Tool call?"}
    TOOL_DECISION -->|No| RESPONSE["Streaming Response"]
    TOOL_DECISION -->|Yes| TOOLS["ToolOrchestrator"]

    TOOLS --> CALC["Calculator"]
    TOOLS --> GPS["Device Location"]
    TOOLS --> WEATHER["Open-Meteo"]
    TOOLS --> SEARCH["Tavily / Brave"]

    CALC --> CONTEXT
    GPS --> CONTEXT
    WEATHER --> CONTEXT
    SEARCH --> CONTEXT

    %% Persistence
    RESPONSE --> MESSAGE_DB["SQLite<br/>Conversations + Messages"]
    MESSAGE_DB --> UI

    %% Model management
    UI --> MODELS["ModelManager"]
    MODELS --> SAF["Android SAF"]
    SAF --> NATIVE["ModelFileModule"]
    NATIVE --> FILES["Permanent App Storage<br/>GGUF + mmproj"]
    FILES --> LLM

    %% Secure storage
    SEARCH --> SECURE["SecureStorageService<br/>Android Keystore"]
```

### Runtime flow in one view

``` text
User
 │
 ▼
React Native / Expo UI
 │
 ├─────────────── Chat ─────────────────┐
 │                                      │
 │                               ContextManager
 │                                      │
 │                           ┌──────────┴──────────┐
 │                           │                     │
 │                    Conversation          Semantic Memory
 │                                               │
 │                                        EmbeddingService
 │                                               │
 │                                             SQLite
 │                                               │
 │                           ┌───────────────────┘
 │                           ▼
 │                    LLMService / llama.rn
 │                           │
 │                    llama.cpp / OpenCL
 │                           │
 │                    Adreno GPU
 │                           │
 │                     Local GGUF
 │                           │
 │                    ┌──────┴──────┐
 │                    │             │
 │                 Response       Tool Call
 │                    │             │
 │                    │       ToolOrchestrator
 │                    │       ┌─────┼─────┬─────┐
 │                    │       ▼     ▼     ▼     ▼
 │                    │    Calc    GPS Weather Search
 │                    │       └─────┬─────┬─────┘
 │                    │             │     │
 │                    └─────────────┴─────┘
 │
 └────────────── Studio ────────────────┐
                                        │
                                  ML Kit OCR
                                        │
                                  Image Resize
                                        │
                                  Grounding Prompt
                                        │
                                        └──► LLMService
```

------------------------------------------------------------------------

## 7. Benchmarks & Hardware Performance

Tested on:

-   Snapdragon 8 Elite Gen 5 / Adreno GPU

| Model | Task | TTFT | Generation Speed | RAM / VRAM |
| :--- | :--- | :---: | :---: | :---: |
| **Llama 3.2 3B (Q4_K_M)** | Text / Tool Chat | **~127 ms** | **~24.5 tok/s** | ~1.8 GB |
| **SmolVLM 500M (Q8_0 + mmproj)** | Document / Scene QA | **~240 ms** | **~38.0 tok/s** | ~850 MB |
| **Qwen2-VL 2B (Q4_K_M + mmproj)** | Deep Visual Analysis | **~410 ms** | **~16.2 tok/s** | ~2.1 GB |
| **Google ML Kit OCR** | Full-Res Text Extraction | **~25 ms** | Instantaneous | ~45 MB |

> Benchmark values are device-, model-, quantization-, prompt-, and
> workload-dependent. Treat them as MVP measurements rather than
> universal performance guarantees.

------------------------------------------------------------------------

## 8. Recommended Models

Compatible GGUF binaries can be obtained from model repositories such as
Hugging Face.

### Text & Reasoning Models

-   **Llama 3.2 3B Instruct**
    -   Recommended quantizations: `Q4_K_M`, `Q8_0`
    -   General chat, memory recall, and tool calling
-   **Llama 3.2 1B Instruct**
    -   Recommended quantization: `Q4_K_M`
    -   Lower-memory and faster workloads

### Vision Models

Vision models require a base GGUF model and a compatible companion
`mmproj`.

#### SmolVLM 500M Instruct

``` text
Base:
smolvlm-500m-instruct-q8_0.gguf

Projector:
mmproj-smolvlm-500m-f16.gguf
```

#### Qwen2-VL 2B Instruct

``` text
Base:
qwen2-vl-2b-instruct-q4_k_m.gguf

Projector:
mmproj-qwen2-vl-2b-f16.gguf
```

> Base-model and `mmproj` compatibility must be verified for the exact
> model conversion and `llama.cpp`/`llama.rn` version being used.

------------------------------------------------------------------------

## 9. Getting Started

### Prerequisites

-   Node.js version - 22.23.2
-   Android Studio
-   Android SDK API 34+
-   Android device with OpenCL support for GPU acceleration
-   A compatible GGUF model for local inference

### Installation

1.  **Clone the repository**

``` bash
git clone https://github.com/your-username/EdgeAnalyzer.git
cd EdgeAnalyzer
```

2.  **Install dependencies**

``` bash
npm install
```

3.  **Generate native Android files**

``` bash
npx expo prebuild --platform android
```

4.  **Run on a connected Android device**

``` bash
npx expo run:android
```

> `expo prebuild` regenerates native project files from the Expo
> configuration. If you make changes to native configuration or add a
> package with a config plugin, rerun prebuild before rebuilding the
> development client.

------------------------------------------------------------------------

## 10. Usage

### Import Models

Open the app and use the **⚙ Settings** icon in the top header to
import:

-   A text `.gguf` model
-   A vision model pair consisting of:
    -   Base `.gguf`
    -   Companion `mmproj`

Imported models are copied from the Android Storage Access Framework
into permanent application storage.

### Chat & Tools

Try:

-   **Calculator:** `What is 15.4 * 89.2?`
-   **Weather:** `What is the weather in Tokyo right now?`
-   **Web search:** `What is the current exchange rate for USD to EUR?`

Depending on the model and prompt, the local agent can select the
appropriate tool.

### Studio

Switch to **🎨 Studio** to capture or upload:

-   Documents
-   Receipts
-   Screenshots
-   Scene photos

The Studio uses the hybrid OCR + VLM pipeline for visual analysis.

------------------------------------------------------------------------

## 11. Security & Privacy

EdgeAnalyzer is designed around local-first processing.

-   Model inference occurs on-device.
-   Conversation and memory data are stored locally in SQLite.
-   API keys for supported search providers are stored using secure
    storage backed by Android Keystore.
-   Imported GGUF files are copied into application-private storage
    rather than relying on long-lived SAF `content://` URIs.
-   Network access is used only by tools that explicitly require
    external services, such as weather and web search.

------------------------------------------------------------------------

## 12. Design Constraints & MVP Rules

The following rules are intentional MVP design decisions:

1.  **Never use a raw SAF `content://` URI as the permanent model
    path.**
2.  **Keep vision images bounded to a 448px longest edge before VLM
    inference.**
3.  **Use a dedicated embedding engine rather than competing with the
    primary chat model for inference state.**
4.  **Keep tool execution bounded to three iterations per user
    request.**
5.  **Prefer local inference and local persistence.**
6.  **Avoid memory-locking large model allocations on Android.**
7.  **Keep text and vision inference configurations separate because
    their memory characteristics differ.**
8.  **Use explicit stop tokens for the supported model chat templates.**

------------------------------------------------------------------------

## 13. Project Status

**MVP 1.0**

The architecture described here represents the current MVP design and
implementation direction. Performance values, supported models, native
configuration, and tool integrations may evolve as device coverage and
model compatibility expand.

------------------------------------------------------------------------

## 📄 License

This project is licensed under the MIT License. See the `LICENSE` file
for details.
