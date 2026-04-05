import { db, transcriptions } from "@my-better-t-app/db";
import { env } from "@my-better-t-app/env/server";
import { desc, eq } from "drizzle-orm";
import Groq, { toFile } from "groq-sdk";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

const app = new Hono();
const groq = new Groq({ apiKey: env.GROQ_API_KEY });

// Groq Whisper models — fast, accurate, but no diarization
const GROQ_MODELS = new Set(["whisper-large-v3", "whisper-large-v3-turbo"]);

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.get("/", (c) => {
  return c.text("OK");
});

// ─── Types ─────────────────────────────────────────────────────────────────────

type TaggedSegment = {
  speaker: string;
  text: string;
  start: number;
  end: number;
};

type TranscribeResult = {
  text: string;
  segments: TaggedSegment[];
  language: string | null;
};

// ─── Groq path ─────────────────────────────────────────────────────────────────
// Uses Whisper via Groq for transcription.
// Speaker detection is gap-based (no audio analysis) — best effort only.

type RawSegment = { start: number; end: number; text: string };

function tagSpeakersFromGaps(segments: RawSegment[]): TaggedSegment[] {
  let speaker = 0;
  return segments.map((seg, i) => {
    if (i > 0 && seg.start - segments[i - 1]!.end > 1.0) speaker++;
    return {
      speaker: `Speaker ${speaker + 1}`,
      text: seg.text.trim(),
      start: seg.start,
      end: seg.end,
    };
  });
}

async function transcribeWithGroq(
  buffer: Buffer,
  mimeType: string,
  model: string,
): Promise<TranscribeResult> {
  const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
  const file = await toFile(buffer, `audio.${ext}`, { type: mimeType });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = (await groq.audio.transcriptions.create({
    file,
    model,
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  })) as any;

  const rawSegments: RawSegment[] = response.segments ?? [];
  const segments = tagSpeakersFromGaps(rawSegments);

  return {
    text: response.text as string,
    segments,
    language: (response.language as string | null) ?? null,
  };
}

// ─── Deepgram path ─────────────────────────────────────────────────────────────
// Uses Nova-2 via Deepgram REST API.
// diarize=true → word-level speaker IDs from voice embeddings, not timing gaps.
// This is the accurate path — recommended for multi-speaker recordings.

type DeepgramWord = {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
};

type DeepgramResponse = {
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{
        transcript?: string;
        words?: DeepgramWord[];
      }>;
    }>;
  };
};

function buildSegmentsFromWords(words: DeepgramWord[]): TaggedSegment[] {
  if (!words.length) return [];

  const segments: TaggedSegment[] = [];
  let currentSpeaker = words[0]!.speaker ?? 0;
  let segmentWords: DeepgramWord[] = [words[0]!];

  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    const wordSpeaker = word.speaker ?? 0;

    if (wordSpeaker !== currentSpeaker) {
      segments.push({
        speaker: `Speaker ${currentSpeaker + 1}`,
        text: segmentWords.map((w) => w.punctuated_word ?? w.word).join(" ").trim(),
        start: segmentWords[0]!.start,
        end: segmentWords[segmentWords.length - 1]!.end,
      });
      currentSpeaker = wordSpeaker;
      segmentWords = [word];
    } else {
      segmentWords.push(word);
    }
  }

  if (segmentWords.length > 0) {
    segments.push({
      speaker: `Speaker ${currentSpeaker + 1}`,
      text: segmentWords.map((w) => w.punctuated_word ?? w.word).join(" ").trim(),
      start: segmentWords[0]!.start,
      end: segmentWords[segmentWords.length - 1]!.end,
    });
  }

  return segments;
}

async function transcribeWithDeeepgram(
  buffer: Buffer,
  mimeType: string,
  model: string,
): Promise<TranscribeResult> {
  const url = new URL("https://api.deepgram.com/v1/listen");
  url.searchParams.set("model", model);
  url.searchParams.set("diarize", "true");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("detect_language", "true");

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      "Content-Type": mimeType,
    },
    body: buffer,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Deepgram API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as DeepgramResponse;
  const channel = data.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];

  if (!alternative) return { text: "", segments: [], language: null };

  const words = (alternative.words ?? []) as DeepgramWord[];
  const segments = buildSegmentsFromWords(words);

  return {
    text: alternative.transcript ?? "",
    segments,
    language: channel?.detected_language ?? null,
  };
}

// ─── POST /api/transcribe ──────────────────────────────────────────────────────

app.post("/api/transcribe", async (c) => {
  try {
    const formData = await c.req.formData();
    const audio = formData.get("audio") as File | null;
    const chunkId = formData.get("chunkId") as string | null;
    const model = (formData.get("model") as string | null) ?? "nova-2";

    if (!audio) return c.json({ error: "audio is required" }, 400);
    if (!chunkId) return c.json({ error: "chunkId is required" }, 400);

    const arrayBuffer = await audio.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = audio.type || "audio/mp4";

    // Route to Groq (Whisper) or Deepgram (Nova-2) based on selected model
    const result = GROQ_MODELS.has(model)
      ? await transcribeWithGroq(buffer, mimeType, model)
      : await transcribeWithDeeepgram(buffer, mimeType, model);

    // Deduplicate: skip insert if chunkId already acked (handles retries)
    const existing = await db
      .select({ id: transcriptions.id })
      .from(transcriptions)
      .where(eq(transcriptions.chunkId, chunkId));

    if (existing.length === 0) {
      await db.insert(transcriptions).values({
        chunkId,
        text: result.text,
        segments: JSON.stringify(result.segments),
        model,
        language: result.language,
      });
    }

    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("transcription error:", message, err);
    return c.json({ error: "transcription failed", detail: message }, 500);
  }
});

// ─── GET /api/transcribe/history ──────────────────────────────────────────────

app.get("/api/transcribe/history", async (c) => {
  const rows = await db
    .select()
    .from(transcriptions)
    .orderBy(desc(transcriptions.createdAt));
  return c.json(rows);
});

export default app;
