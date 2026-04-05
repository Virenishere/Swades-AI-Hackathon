"use client"

import { useEffect, useRef, useState } from "react"
import { Mic, Square } from "lucide-react"

import { Button } from "@my-better-t-app/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@my-better-t-app/ui/components/card"
import { LiveWaveform } from "@/components/ui/live-waveform"

// ─── Types ────────────────────────────────────────────────────────────────────

type Segment = {
  speaker: string
  text: string
  start: number
  end: number
}

type TranscribeResponse = {
  text: string
  segments: Segment[]
  language: string | null
}

type DisplaySegment = Segment & { language: string | null }

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3000"
const CHECKPOINT_INTERVAL_MS = 5000

// ─── MIME helpers ─────────────────────────────────────────────────────────────

function detectMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "audio/mp4"

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ]
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? "audio/mp4"
}

function mimeToExt(mime: string): string {
  if (mime.includes("mp4")) return "mp4"
  if (mime.includes("ogg")) return "ogg"
  return "webm"
}

function extToMime(ext: string): string {
  if (ext === "mp4") return "audio/mp4"
  if (ext === "ogg") return "audio/ogg;codecs=opus"
  return "audio/webm"
}

// ─── Upload ───────────────────────────────────────────────────────────────────

async function uploadFullRecording(
  blob: Blob,
  sessionId: string,
  model: string,
): Promise<TranscribeResponse> {
  const ext = mimeToExt(blob.type || "audio/webm")
  const fd = new FormData()
  fd.append("audio", blob, `recording.${ext}`)
  fd.append("model", model)
  fd.append("chunkId", sessionId)

  const res = await fetch(`${SERVER_URL}/api/transcribe`, {
    method: "POST",
    body: fd,
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string }
    throw new Error(`Server returned ${res.status}: ${body.detail ?? body.error ?? "unknown"}`)
  }
  return res.json() as Promise<TranscribeResponse>
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RecorderPage() {
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle")
  const [model, setModel] = useState("nova-2")
  const [segments, setSegments] = useState<DisplaySegment[]>([])
  const [stream, setStream] = useState<MediaStream | null>(null)

  // ── Refs ──────────────────────────────────────────────────────────────────
  const mediaRecRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const opfsRootRef = useRef<FileSystemDirectoryHandle | null>(null)
  const sessionIdRef = useRef<string>("")
  const seqRef = useRef(0)
  const modelRef = useRef(model)
  const mimeTypeRef = useRef("audio/webm")
  const extRef = useRef("webm")
  const intervalRef = useRef<NodeJS.Timeout | null>(null)
  const pendingWritesRef = useRef<Promise<void>[]>([])

  // Safe entries iterator (handles TS limitation)
  async function* getDirectoryEntries(dir: FileSystemDirectoryHandle) {
    // @ts-expect-error - entries() is supported in modern browsers but missing from some TS lib versions
    if (typeof dir.entries === "function") {
      // @ts-expect-error
      yield* dir.entries()
    } else {
      // Fallback using values() + manual name (less efficient but works)
      // @ts-expect-error
      for await (const handle of dir.values?.() ?? []) {
        // This is a very rough fallback – we skip name in this case
        yield ["unknown", handle] as [string, FileSystemHandle]
      }
    }
  }

  // ── Save checkpoint ───────────────────────────────────────────────────────
  async function saveCheckpoint(data: Blob): Promise<void> {
    if (!opfsRootRef.current) return

    const seq = String(seqRef.current++).padStart(6, "0")
    const name = `session-${sessionIdRef.current}-${seq}.${extRef.current}`

    const writePromise = (async () => {
      const fh = await opfsRootRef.current!.getFileHandle(name, { create: true })
      const w = await fh.createWritable()
      await w.write(data)
      await w.close()
    })()

    pendingWritesRef.current.push(writePromise)
  }

  // ── Process full recording ────────────────────────────────────────────────
  async function processFullRecording() {
    const root = opfsRootRef.current
    if (!root) {
      setPhase("idle")
      return
    }

    const sessionId = sessionIdRef.current
    const prefix = `session-${sessionId}-`
    const names: string[] = []

    for await (const [name] of getDirectoryEntries(root)) {
      if (typeof name === "string" && name.startsWith(prefix)) {
        names.push(name)
      }
    }

    names.sort()

    if (names.length === 0) {
      setPhase("idle")
      return
    }

    const parts: ArrayBuffer[] = []
    for (const name of names) {
      const fh = await root.getFileHandle(name)
      const file = await fh.getFile()
      parts.push(await file.arrayBuffer())
    }

    const fullBlob = new Blob(parts, { type: mimeTypeRef.current })

    try {
      const data = await uploadFullRecording(fullBlob, `session-${sessionId}`, modelRef.current)

      setSegments((prev) => [
        ...data.segments.map((s) => ({ ...s, language: data.language })),
        ...prev,
      ])

      for (const name of names) {
        await root.removeEntry(name).catch(() => null)
      }
    } catch (err) {
      console.error("Upload failed:", err)
    } finally {
      setPhase("idle")
    }
  }

  // ── Recovery on load ──────────────────────────────────────────────────────
  useEffect(() => {
    async function recover() {
      try {
        const root = await navigator.storage.getDirectory()
        opfsRootRef.current = root

        const sessions = new Map<string, Array<{ name: string; handle: FileSystemFileHandle }>>()

        for await (const [name, handle] of getDirectoryEntries(root)) {
          if (handle.kind !== "file") continue
          const m = (name as string).match(/^session-(\d+)-\d{6}\.\w+$/)
          if (!m) continue

          const sid = m[1]!
          if (!sessions.has(sid)) sessions.set(sid, [])
          sessions.get(sid)!.push({ name: name as string, handle: handle as FileSystemFileHandle })
        }

        // Recovery logic remains similar...
        for (const [sid, chunks] of sessions) {
          try {
            chunks.sort((a, b) => a.name.localeCompare(b.name))
            const parts: ArrayBuffer[] = []
            let ext = "webm"

            for (const { handle } of chunks) {
              const file = await handle.getFile()
              parts.push(await file.arrayBuffer())
              ext = file.name.split(".").pop() ?? "webm"
            }

            const blob = new Blob(parts, { type: extToMime(ext) })
            const data = await uploadFullRecording(blob, `session-${sid}`, "nova-2")

            setSegments((prev) => [
              ...data.segments.map((s) => ({ ...s, language: data.language })),
              ...prev,
            ])

            for (const { name } of chunks) {
              await root.removeEntry(name).catch(() => null)
            }
          } catch (err) {
            console.error("Recovery failed for session:", sid, err)
          }
        }
      } catch (err) {
        console.error("OPFS recovery failed:", err)
      }
    }

    recover()
  }, [])

  // ── Start / Stop recording (unchanged except minor safety) ────────────────
  async function startRecording() {
    try {
      const ms = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = ms
      setStream(ms)

      if (!opfsRootRef.current) {
        opfsRootRef.current = await navigator.storage.getDirectory()
      }

      sessionIdRef.current = Date.now().toString()
      seqRef.current = 0
      pendingWritesRef.current = []
      modelRef.current = model

      const mimeType = detectMimeType()
      mimeTypeRef.current = mimeType
      extRef.current = mimeToExt(mimeType)

      const mr = new MediaRecorder(ms, { mimeType })
      mediaRecRef.current = mr

      mr.ondataavailable = (e) => {
        if (e.data?.size > 0) saveCheckpoint(e.data)
      }

      mr.onstop = async () => {
        await Promise.all(pendingWritesRef.current)
        streamRef.current?.getTracks().forEach((t) => t.stop())
        setStream(null)
        processFullRecording()
      }

      mr.start()
      intervalRef.current = setInterval(() => {
        if (mr.state === "recording") mr.requestData()
      }, CHECKPOINT_INTERVAL_MS)

      setPhase("recording")
    } catch (err) {
      console.error("Failed to start recording:", err)
      setPhase("idle")
    }
  }

  function stopRecording() {
    setPhase("transcribing")

    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }

    if (mediaRecRef.current?.state === "recording") {
      mediaRecRef.current.stop()
    } else {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      setStream(null)
      processFullRecording()
    }
  }

  const speakerCount = new Set(segments.map((s) => s.speaker)).size

  return (
    <div className="container mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8">
      {/* Rest of your JSX remains exactly the same */}
      <Card>
        <CardHeader>
          <CardTitle>Audio Transcription</CardTitle>
          <CardDescription>
            Single session · OPFS checkpoints every 5s · full audio sent on stop
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          <div className="overflow-hidden rounded-sm border border-border/50 bg-muted/20 text-foreground">
            <LiveWaveform
              active={phase === "recording"}
              processing={phase === "transcribing"}
              stream={stream}
              height={80}
              barWidth={3}
              barGap={1}
              barRadius={2}
              sensitivity={1.8}
              smoothingTimeConstant={0.85}
              fadeEdges
              fadeWidth={32}
              mode="static"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Model</label>
            <select
              disabled={phase !== "idle"}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <optgroup label="Deepgram — accurate speaker detection">
                <option value="nova-2">nova-2 — best accuracy (default)</option>
                <option value="nova-2-general">nova-2-general — general purpose</option>
                <option value="base">base — fastest</option>
              </optgroup>
              <optgroup label="Groq Whisper — fast, gap-based speakers only">
                <option value="whisper-large-v3-turbo">whisper-large-v3-turbo — faster</option>
                <option value="whisper-large-v3">whisper-large-v3 — more accurate</option>
              </optgroup>
            </select>
          </div>

          <div className="flex items-center gap-4">
            <Button
              size="lg"
              variant={phase === "recording" ? "destructive" : "default"}
              className="gap-2 px-6"
              disabled={phase === "transcribing"}
              onClick={phase === "recording" ? stopRecording : startRecording}
            >
              {phase === "recording" ? (
                <>
                  <Square className="size-4" />
                  Stop &amp; Transcribe
                </>
              ) : (
                <>
                  <Mic className="size-4" />
                  Start Recording
                </>
              )}
            </Button>

            <span className="text-sm text-muted-foreground">
              {phase === "transcribing" ? (
                <span className="font-medium text-amber-500 animate-pulse">Transcribing…</span>
              ) : phase === "recording" ? (
                <span className="font-medium text-green-500">Recording</span>
              ) : (
                <span className="font-medium">Idle</span>
              )}
            </span>
          </div>
        </CardContent>
      </Card>

      {segments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Transcript</CardTitle>
            <CardDescription>
              {speakerCount} speaker{speakerCount !== 1 ? "s" : ""} detected
              &nbsp;·&nbsp;{segments.length} segment{segments.length !== 1 ? "s" : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {segments.map((seg, i) => (
              <div key={i} className="rounded-sm border border-border/50 bg-muted/20 p-3">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{seg.speaker}</span>
                  <span>
                    {seg.start.toFixed(1)}s – {seg.end.toFixed(1)}s
                  </span>
                  {seg.language && (
                    <span className="rounded bg-muted px-1 py-0.5 font-mono uppercase">
                      {seg.language}
                    </span>
                  )}
                </div>
                <p className="text-sm leading-relaxed">{seg.text}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}