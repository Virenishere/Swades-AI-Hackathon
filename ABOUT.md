# 🎙️ Swades AI Hackathon — Real-time Audio Transcription System

A **fault-tolerant, real-time audio transcription system** with **speaker diarization**, built using a modern full-stack architecture.

This system records audio in **3-second chunks**, ensures **zero data loss** using browser storage (OPFS), and supports **multiple transcription providers** for flexibility in speed, cost, and accuracy.



## 🚀 Features

- ⚡ Real-time transcription (3-second chunk processing)
- 🧠 Dual provider support:
  - **Groq Whisper** (`large-v3`, `turbo`)
  - **Deepgram** (`nova-3`, `nova-2`)
- 👥 Speaker diarization:
  - Native (Deepgram)
  - Timestamp-based fallback (Groq)
- 💾 Fault-tolerant design (OPFS-based chunk persistence)
- 🔁 Automatic recovery on reload
- 📜 Persistent transcription history (PostgreSQL)
- 🔄 Switch providers/models dynamically from UI
- 🎯 Minimal and functional UI

---

## 🏗️ Tech Stack

| Layer        | Technology |
|-------------|------------|
| Monorepo     | Turborepo + Bun |
| Frontend     | Next.js (App Router) |
| Backend      | Hono.js |
| Database     | PostgreSQL + Drizzle ORM |
| Transcription | Groq SDK, Deepgram SDK |
| Browser APIs | MediaRecorder, OPFS |

---

## 📁 Project Structure

```

Swades-AI-Hackathon/
├── apps/
│   ├── server/          # Hono.js API
│   └── web/             # Next.js frontend
└── packages/
├── db/              # Database schema & queries (Drizzle)
├── env/             # Environment validation
├── ui/              # Shared UI components
└── config/          # Shared TypeScript config

````

---

## 🧠 Architecture Overview

### 1. Browser Layer
- Records audio using `MediaRecorder`
- Stores chunks in **OPFS** (Origin Private File System)
- Sends chunks to backend via API

### 2. Backend (Hono.js)
- Receives audio chunks
- Routes request to selected provider:
  - Groq or Deepgram
- Processes transcription + speaker segmentation
- Stores results in PostgreSQL

### 3. Transcription Layer
- **Groq Whisper** → Fast & cost-effective
- **Deepgram** → Accurate with native diarization

### 4. Database Layer
- Stores transcription chunks and metadata
- Enables history retrieval

---

## 🎯 Transcription Providers

| Provider   | Model                  | Strength              | Diarization |
|------------|------------------------|----------------------|-------------|
| Groq       | whisper-large-v3 / turbo | Speed + Cost         | Basic (fallback) |
| Deepgram   | nova-3 / nova-2        | Accuracy + Speaker ID | Native (recommended) |

👉 **Recommendation:** Use **Deepgram** when speaker identification is important.

---

## ⚙️ Setup Instructions

### 1. Install Dependencies

```bash
cd apps/server
bun add @deepgram/sdk
````

---

### 2. Environment Variables

Create `.env` inside `apps/server/`

```env
DATABASE_URL=postgresql://admin:password@localhost:5432/swades_ai

# Groq
GROQ_API_KEY=your_groq_api_key

# Deepgram
DEEPGRAM_API_KEY=your_deepgram_api_key

CORS_ORIGIN=http://localhost:3001

# Default provider (optional)
DEFAULT_TRANSCRIPTION_PROVIDER=deepgram
```

---

### 3. Database Setup

```bash
bun run db:generate
bun run db:push
```

---

### 4. Run Development Server

```bash
bun run dev
```

---

## 🔌 API Endpoints

### `POST /api/transcribe`

**Request (multipart/form-data):**

* `audio` → WebM blob
* `provider` → `"groq"` or `"deepgram"`
* `model` → model name
* `chunkId` → unique identifier

**Response:**

```json
{
  "text": "...",
  "segments": [
    {
      "speaker": "Speaker 1",
      "text": "...",
      "start": 0,
      "end": 3.5
    }
  ],
  "language": "en",
  "provider": "deepgram"
}
```

---

### `GET /api/transcribe/history`

Returns stored transcription history.

---

## 👥 Speaker Diarization Logic

* **Deepgram**

  * Uses `diarize=true` and `utterances=true`
  * Returns accurate speaker labels per segment

* **Groq**

  * Uses timestamp-gap heuristic
  * New speaker detected if gap > 1 second

---

## 🖥️ Frontend Features

* 🎛️ Provider selector (Groq / Deepgram)
* 🧠 Model selector (dynamic)
* 🎙️ Start/Stop recording
* 📊 Live transcription display
* 📜 History view

### Example Output

```
Speaker 1: Hello, how are you? [00:00 - 00:04]
Speaker 2: I'm doing great! [00:05 - 00:09]
```

---

## ⚠️ Key Constraints

* Audio chunks **must be saved to OPFS before upload**
* Delete chunks only after successful response
* Handle retries for failed uploads
* Maintain provider abstraction in backend
* Ensure recovery on reload

---




