import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadStream } from "node:fs";
import { env } from "../env.js";
import { openai, recordAiCost, type AiCallContext } from "./provider.js";

const execFileAsync = promisify(execFile);

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface TranscriptionResult {
  engine: "whisper_local" | "whisper_api";
  language: string | null;
  fullText: string;
  segments: TranscriptionSegment[];
  processingTimeMs: number;
}

/**
 * Meeting transcription. Prefers a local whisper.cpp binary
 * (WHISPER_CPP_PATH + WHISPER_CPP_MODEL_PATH) for zero marginal cost;
 * falls back to the OpenAI Whisper API when local is unavailable.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  fileName: string,
  ctx: AiCallContext
): Promise<TranscriptionResult> {
  const startedAt = Date.now();
  if (env.whisperCppPath && env.whisperCppModelPath) {
    return transcribeLocal(audioBuffer, fileName, startedAt);
  }
  return transcribeViaApi(audioBuffer, fileName, ctx, startedAt);
}

async function transcribeLocal(
  audioBuffer: Buffer,
  fileName: string,
  startedAt: number
): Promise<TranscriptionResult> {
  const dir = await mkdtemp(join(tmpdir(), "ge-whisper-"));
  const inputPath = join(dir, fileName);
  const outBase = join(dir, "out");
  await writeFile(inputPath, audioBuffer);
  try {
    await execFileAsync(
      env.whisperCppPath,
      ["-m", env.whisperCppModelPath, "-f", inputPath, "-oj", "-of", outBase],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60 * 1000 }
    );
    const json = JSON.parse(await readFile(`${outBase}.json`, "utf8"));
    const segments: TranscriptionSegment[] = (json.transcription ?? []).map(
      (s: { offsets: { from: number; to: number }; text: string }) => ({
        start: s.offsets.from / 1000,
        end: s.offsets.to / 1000,
        text: String(s.text).trim(),
      })
    );
    return {
      engine: "whisper_local",
      language: json.result?.language ?? null,
      fullText: segments.map((s) => s.text).join(" ").trim(),
      segments,
      processingTimeMs: Date.now() - startedAt,
    };
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(`${outBase}.json`).catch(() => {});
  }
}

async function transcribeViaApi(
  audioBuffer: Buffer,
  fileName: string,
  ctx: AiCallContext,
  startedAt: number
): Promise<TranscriptionResult> {
  const dir = await mkdtemp(join(tmpdir(), "ge-whisper-api-"));
  const inputPath = join(dir, fileName);
  await writeFile(inputPath, audioBuffer);
  try {
    const res = await openai().audio.transcriptions.create({
      model: "whisper-1",
      file: createReadStream(inputPath),
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });
    const verbose = res as unknown as {
      language?: string;
      text: string;
      segments?: { start: number; end: number; text: string }[];
    };
    // Whisper API pricing is per-minute; approximate via duration metadata
    const durationMinutes =
      verbose.segments && verbose.segments.length > 0
        ? verbose.segments[verbose.segments.length - 1].end / 60
        : 1;
    await recordAiCost(
      { ...ctx, feature: "transcription" },
      "openai",
      "whisper-1",
      Math.ceil(durationMinutes * 1000),
      0
    );
    return {
      engine: "whisper_api",
      language: verbose.language ?? null,
      fullText: verbose.text,
      segments: (verbose.segments ?? []).map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text.trim(),
      })),
      processingTimeMs: Date.now() - startedAt,
    };
  } finally {
    await unlink(inputPath).catch(() => {});
  }
}
