import { exec, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { config } from "./config";

const execAsync = promisify(exec);

export type ProgressEvent =
  | { kind: "info"; title: string; duration: number }
  | { kind: "download"; percent: number; speed?: string; eta?: string }
  | { kind: "merging" }
  | { kind: "done"; filePath: string };

export type ProgressCallback = (event: ProgressEvent) => void;

// ─── Types ──────────────────────────────────────────────────

export interface VideoInfo {
  title: string;
  duration: number; // in seconds
  filePath: string;
  thumbnailUrl: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  segments: TranscriptSegment[];
  method: "youtube-captions";
}

// ─── Video Download ─────────────────────────────────────────

export async function downloadVideo(url: string, sessionId: string, onProgress?: ProgressCallback): Promise<VideoInfo> {
  const outputDir = path.join(config.tempDir, sessionId);
  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, "source.%(ext)s");

  // Step 1: Get video info (tanpa download)
  console.log("[download] Fetching video metadata...");
  const infoCmd = `yt-dlp --dump-json --no-download "${url}"`;
  const { stdout: infoJson } = await execAsync(infoCmd, { maxBuffer: 10 * 1024 * 1024 });
  const info = JSON.parse(infoJson);

  console.log(`[download] Title: ${info.title} | Duration: ${info.duration}s`);
  onProgress?.({ kind: "info", title: info.title || "Untitled", duration: info.duration || 0 });

  // Step 2: Download video (max 720p, format mp4) dengan progress streaming
  const args = [
    "-f",
    "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best",
    "--merge-output-format",
    "mp4",
    "-o",
    outputPath,
    "--no-playlist",
    "--no-overwrites",
    "--socket-timeout",
    "30",
    "--newline",
    "--progress",
    "--progress-template",
    "PROGRESS %(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s",
    url,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("yt-dlp", args);
    let lastLoggedPercent = -5;

    proc.stdout.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const m = trimmed.match(/^PROGRESS\s+([\d.]+)%\s+(\S+)\s+(\S+)/);
        if (m) {
          const percent = parseFloat(m[1]);
          const speed = m[2];
          const eta = m[3];
          if (percent - lastLoggedPercent >= 5 || percent >= 100) {
            console.log(`[download] ${percent.toFixed(1)}% | speed ${speed} | eta ${eta}`);
            lastLoggedPercent = percent;
          }
          onProgress?.({ kind: "download", percent, speed, eta });
        } else if (trimmed.includes("[Merger]") || trimmed.includes("Merging")) {
          console.log("[download] Merging video + audio streams...");
          onProgress?.({ kind: "merging" });
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.error(`[download:stderr] ${msg}`);
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited with code ${code}`));
    });
  });

  // Cari file hasil download
  const files = await fs.readdir(outputDir);
  const videoFile = files.find((f) => f.startsWith("source."));
  if (!videoFile) {
    throw new Error("Video download failed — file not found");
  }

  const filePath = path.join(outputDir, videoFile);
  console.log(`[download] ✅ Done: ${filePath}`);
  onProgress?.({ kind: "done", filePath });

  return {
    title: info.title || "Untitled",
    duration: info.duration || 0,
    filePath,
    thumbnailUrl: info.thumbnail || "",
  };
}

// ─── Main Transcript Function (YouTube auto-captions only) ──

export async function getTranscript(url: string, _videoPath: string): Promise<TranscriptResult> {
  console.log("[transcript] Fetching YouTube auto-captions...");
  const segments = await getYouTubeCaptions(url, _videoPath);

  if (segments.length === 0) {
    throw new Error("Video ini tidak punya YouTube captions (manual/auto). Coba video lain.");
  }

  console.log(`[transcript] ✅ YouTube Captions: ${segments.length} segments`);
  return { segments, method: "youtube-captions" };
}

// ─── Layer 1: YouTube Captions ──────────────────────────────

async function getYouTubeCaptions(url: string, videoPath: string): Promise<TranscriptSegment[]> {
  const outputDir = path.dirname(videoPath);
  const subsFile = path.join(outputDir, "subs");

  // Download subtitle: prefer manual subs, fallback to auto-generated
  const cmd = [`yt-dlp`, `--skip-download`, `--write-sub`, `--write-auto-sub`, `--sub-lang "en"`, `--sub-format "vtt"`, `-o "${subsFile}"`, `"${url}"`].join(
    " ",
  );

  console.log("[transcript] Running yt-dlp to fetch captions...");
  try {
    await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });
  } catch (err: any) {
    console.log("[transcript] yt-dlp partial failure (expected):", err.message);
  }

  // Cari file subtitle yang ter-download
  const files = await fs.readdir(outputDir);
  const subFile =
    files.find((f) => f.startsWith("subs.en") && f.endsWith(".vtt")) ||
    files.find((f) => f.startsWith("subs.id") && f.endsWith(".vtt")) ||
    files.find((f) => f.startsWith("subs.") && f.endsWith(".vtt"));

  if (!subFile) {
    throw new Error("No captions available for this video");
  }

  console.log(`[transcript] Parsing caption file: ${subFile}`);

  const raw = await fs.readFile(path.join(outputDir, subFile), "utf-8");
  const segments = parseVtt(raw);

  return mergeShortSegments(segments, 3);
}

// ─── VTT Parser ─────────────────────────────────────────────
//
// VTT cue format:
//   00:00:12.345 --> 00:00:15.678
//   caption text (may span multiple lines)
//
// YouTube auto-captions often duplicate text across overlapping cues
// (rolling karaoke-style). We dedupe adjacent cues with identical text.

function parseVtt(raw: string): TranscriptSegment[] {
  const lines = raw.split(/\r?\n/);
  const cueTime = /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
  const segments: TranscriptSegment[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(cueTime);
    if (!m) continue;

    const start = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000;
    const end = parseInt(m[5]) * 3600 + parseInt(m[6]) * 60 + parseInt(m[7]) + parseInt(m[8]) / 1000;

    const textLines: string[] = [];
    i++;
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }

    const text = textLines
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();

    if (!text) continue;

    const prev = segments[segments.length - 1];
    if (prev && prev.text === text) {
      prev.end = end;
      continue;
    }

    segments.push({ start, end, text });
  }

  return segments;
}

// ─── Shared Helpers ─────────────────────────────────────────

/**
 * Merge segment-segment pendek jadi chunk lebih besar.
 * YouTube captions sering per 1-2 kata — terlalu granular untuk AI.
 */
function mergeShortSegments(segments: TranscriptSegment[], minDurationSec: number): TranscriptSegment[] {
  if (segments.length === 0) return [];

  const merged: TranscriptSegment[] = [];
  let current = { ...segments[0] };

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const currentDuration = current.end - current.start;

    if (currentDuration < minDurationSec) {
      current.end = seg.end;
      current.text += " " + seg.text;
    } else {
      merged.push(current);
      current = { ...seg };
    }
  }

  merged.push(current);
  return merged;
}

/**
 * Cleanup temporary files
 */
export async function cleanupSession(sessionId: string): Promise<void> {
  const sessionDir = path.join(config.tempDir, sessionId);
  try {
    await fs.rm(sessionDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
