import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { ClipSuggestion, formatTime } from "./analyzer";

const execAsync = promisify(exec);

export interface GeneratedClip {
  filePath: string;
  title: string;
  reason: string;
  viralScore: number;
  hashtags: string[];
  duration: number;
  fileSize: number; // bytes
}

/**
 * Potong video menjadi beberapa clip berdasarkan saran AI.
 *
 * Menggunakan FFmpeg dengan:
 * - Re-encode untuk memastikan clip dimulai dari keyframe
 * - Optimasi untuk social media (H.264, AAC)
 * - Optional: auto-crop ke 9:16 untuk vertical shorts
 */
export async function generateClips(
  videoPath: string,
  clips: ClipSuggestion[],
  options: { vertical?: boolean } = {}
): Promise<GeneratedClip[]> {
  const outputDir = path.dirname(videoPath);
  const results: GeneratedClip[] = [];

  console.log(`[clipper] Generating ${clips.length} clips...`);

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const duration = clip.endTime - clip.startTime;
    const outputFile = path.join(outputDir, `clip_${i + 1}.mp4`);
    const percent = Math.round((i / clips.length) * 100);
    console.log(
      `[clipper] (${i + 1}/${clips.length}, ${percent}%) "${clip.title}" | ${formatTime(clip.startTime)}→${formatTime(clip.endTime)} (${duration}s)`
    );

    // Build FFmpeg command
    const filters: string[] = [];

    // Kalau mau vertical (9:16), crop dari center
    if (options.vertical) {
      filters.push(
        // Crop ke 9:16 aspect ratio dari center
        `crop=ih*9/16:ih:(iw-ih*9/16)/2:0`,
        // Scale ke 1080x1920
        `scale=1080:1920:flags=lanczos`
      );
    } else {
      // Scale max 1080p, keep aspect ratio
      filters.push(`scale='min(1080,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:flags=lanczos`);
    }

    const filterStr = filters.length > 0 ? `-vf "${filters.join(",")}"` : "";

    const cmd = [
      `ffmpeg -y`,
      `-ss ${clip.startTime}`,          // seek position (sebelum input = fast seek)
      `-i "${videoPath}"`,
      `-t ${duration}`,                  // durasi clip
      filterStr,
      `-c:v libx264`,                    // H.264 codec
      `-preset fast`,                    // encoding speed
      `-crf 23`,                         // quality (18-28, lower = better)
      `-c:a aac`,                        // AAC audio
      `-b:a 128k`,                       // audio bitrate
      `-movflags +faststart`,            // optimize for streaming
      `-avoid_negative_ts make_zero`,    // fix timestamp issues
      `"${outputFile}"`,
    ].join(" ");

    try {
      await execAsync(cmd, { maxBuffer: 10 * 1024 * 1024 });

      const stats = await fs.stat(outputFile);

      results.push({
        filePath: outputFile,
        title: clip.title,
        reason: clip.reason,
        viralScore: clip.viralScore,
        hashtags: clip.hashtags,
        duration,
        fileSize: stats.size,
      });
      console.log(`[clipper] ✅ Clip ${i + 1} done (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      console.error(`[clipper] ❌ Failed clip ${i + 1}:`, err);
      // Continue with other clips
    }
  }

  console.log(`[clipper] ✅ All done: ${results.length}/${clips.length} clips generated`);
  return results;
}

/**
 * Generate thumbnail dari frame tertentu dalam clip
 */
export async function generateThumbnail(
  videoPath: string,
  timeOffset: number = 2 // ambil frame di detik ke-2
): Promise<string> {
  const thumbPath = videoPath.replace(/\.[^.]+$/, "_thumb.jpg");

  const cmd = [
    `ffmpeg -y`,
    `-ss ${timeOffset}`,
    `-i "${videoPath}"`,
    `-vframes 1`,
    `-q:v 2`,
    `"${thumbPath}"`,
  ].join(" ");

  await execAsync(cmd);
  return thumbPath;
}
