import { Bot, Context, InputFile } from "grammy";
import { v4 as uuid } from "uuid";
import fs from "fs/promises";
import { config, validateConfig } from "./config";
import {
  downloadVideo,
  getTranscript,
  cleanupSession,
} from "./downloader";
import { analyzeForViralClips, formatTime } from "./analyzer";
import { generateClips, GeneratedClip } from "./clipper";

// ─── Validate & Boot ────────────────────────────────────────
validateConfig();
const bot = new Bot(config.telegramToken);

// Regex untuk detect YouTube URLs
const YOUTUBE_REGEX =
  /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i;

// Track active sessions supaya user ga spam
const activeSessions = new Set<number>();

// ─── /start ─────────────────────────────────────────────────
bot.command("start", async (ctx) => {
  await ctx.reply(
    `🎬 *Viral Clipper Bot*\n\n` +
      `Kirim link YouTube dan aku akan:\n` +
      `1. Download videonya\n` +
      `2. Transcribe audionya\n` +
      `3. Analisis pakai AI momen mana yang paling viral\n` +
      `4. Potong jadi ${config.maxClips} clip pendek\n` +
      `5. Kirim hasilnya ke kamu!\n\n` +
      `Langsung kirim aja link YouTube-nya 👇`,
    { parse_mode: "Markdown" }
  );
});

// ─── /help ──────────────────────────────────────────────────
bot.command("help", async (ctx) => {
  await ctx.reply(
    `📖 *Cara Pakai:*\n\n` +
      `1. Copy link YouTube\n` +
      `2. Paste & kirim ke sini\n` +
      `3. Tunggu prosesnya (bisa 2-5 menit)\n` +
      `4. Terima clip-clip viral-mu!\n\n` +
      `⚙️ *Settings:*\n` +
      `• Max ${config.maxClips} clips per video\n` +
      `• Durasi clip: ${config.minClipDuration}-${config.maxClipDuration} detik\n\n` +
      `⚠️ *Limitasi:*\n` +
      `• Hanya YouTube yang di-support\n` +
      `• Video max 30 menit\n` +
      `• 1 proses per user pada satu waktu`,
    { parse_mode: "Markdown" }
  );
});

// ─── Handle YouTube Link ────────────────────────────────────
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const match = text.match(YOUTUBE_REGEX);

  if (!match) {
    // Bukan YouTube link, ignore atau kasih hint
    if (text.includes("http")) {
      await ctx.reply("⚠️ Saat ini hanya YouTube yang di-support. Kirim link YouTube ya!");
    }
    return;
  }

  const userId = ctx.from.id;

  // Cek apakah user sudah punya proses berjalan
  if (activeSessions.has(userId)) {
    await ctx.reply("⏳ Kamu masih punya proses yang berjalan. Tunggu selesai dulu ya!");
    return;
  }

  const youtubeUrl = match[0];
  const sessionId = uuid();

  activeSessions.add(userId);

  try {
    // ── Step 1: Download ──
    console.log(`\n━━━ [pipeline] Session ${sessionId} ━━━`);
    console.log(`[pipeline] Step 1/4: Download → ${youtubeUrl}`);
    const statusMsg = await ctx.reply("📥 Downloading video... 0%");

    let lastTgPercent = -10;
    const videoInfo = await downloadVideo(youtubeUrl, sessionId, (ev) => {
      if (ev.kind === "download" && ev.percent - lastTgPercent >= 10) {
        lastTgPercent = ev.percent;
        editMessage(
          ctx,
          statusMsg.message_id,
          `📥 Downloading video... ${ev.percent.toFixed(0)}%\n` +
            `⚡ ${ev.speed ?? "-"} | ⏳ ETA ${ev.eta ?? "-"}`
        );
      } else if (ev.kind === "merging") {
        editMessage(ctx, statusMsg.message_id, "📥 Merging video + audio streams...");
      }
    });

    // Validasi durasi (max 30 menit)
    if (videoInfo.duration > 1800) {
      await ctx.reply("⚠️ Video terlalu panjang (max 30 menit). Coba video yang lebih pendek.");
      return;
    }

    await editMessage(ctx, statusMsg.message_id,
      `📥 Downloaded: *${escapeMarkdown(videoInfo.title)}*\n` +
      `⏱ Durasi: ${formatTime(videoInfo.duration)}\n\n` +
      `🎤 Getting transcript...`
    );

    // ── Step 2: Get Transcript (YouTube auto-captions) ──
    console.log("[pipeline] Step 2/4: Transcript");
    const transcriptResult = await getTranscript(youtubeUrl, videoInfo.filePath);
    const transcript = transcriptResult.segments;

    const methodLabel: Record<string, string> = {
      "youtube-captions": "YouTube Auto-Captions ⚡",
    };

    if (transcript.length === 0) {
      await ctx.reply("⚠️ Tidak bisa men-transcribe video ini. Mungkin tidak ada dialog/narasi.");
      return;
    }

    await editMessage(ctx, statusMsg.message_id,
      `📥 Downloaded: *${escapeMarkdown(videoInfo.title)}*\n` +
      `⏱ Durasi: ${formatTime(videoInfo.duration)}\n` +
      `📝 Transcript: ${transcript.length} segments (via ${methodLabel[transcriptResult.method]})\n\n` +
      `🧠 Analyzing with AI for viral moments...`
    );

    // ── Step 3: AI Analysis ──
    console.log("[pipeline] Step 3/4: AI Analysis");
    const clipSuggestions = await analyzeForViralClips(
      transcript,
      videoInfo.title,
      videoInfo.duration
    );

    if (clipSuggestions.length === 0) {
      await ctx.reply("🤔 AI tidak menemukan momen yang cukup viral. Coba video lain!");
      return;
    }

    // Tampilkan apa yang AI temukan
    const suggestionsText = clipSuggestions
      .map(
        (c, i) =>
          `*Clip ${i + 1}:* ${escapeMarkdown(c.title)}\n` +
          `  ⏱ ${formatTime(c.startTime)} → ${formatTime(c.endTime)}\n` +
          `  🔥 Viral Score: ${c.viralScore}/10\n` +
          `  💡 ${escapeMarkdown(c.reason)}`
      )
      .join("\n\n");

    await editMessage(ctx, statusMsg.message_id,
      `🧠 *AI menemukan ${clipSuggestions.length} momen viral:*\n\n` +
      `${suggestionsText}\n\n` +
      `✂️ Generating clips...`
    );

    // ── Step 4: Generate Clips ──
    console.log("[pipeline] Step 4/4: Generate Clips");
    const generatedClips = await generateClips(videoInfo.filePath, clipSuggestions);

    if (generatedClips.length === 0) {
      await ctx.reply("❌ Gagal generate clips. Coba lagi nanti.");
      return;
    }

    await editMessage(ctx, statusMsg.message_id,
      `✅ *${generatedClips.length} clips generated!*\n\nSending...`
    );

    // ── Step 5: Send Clips ──
    for (let i = 0; i < generatedClips.length; i++) {
      const clip = generatedClips[i];
      await sendClip(ctx, clip, i + 1, generatedClips.length);
    }

    // Summary message
    const allHashtags = [
      ...new Set(clipSuggestions.flatMap((c) => c.hashtags)),
    ];
    await ctx.reply(
      `🎉 *Done!* ${generatedClips.length} viral clips dari "${escapeMarkdown(videoInfo.title)}"\n\n` +
      `📌 Suggested hashtags:\n${allHashtags.map((h) => `#${h}`).join(" ")}\n\n` +
      `Kirim link YouTube lain untuk generate lebih banyak clips! 🔥`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("Pipeline error:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    await ctx.reply(`❌ Error: ${errMsg}\n\nSilahkan coba lagi.`);
  } finally {
    // Cleanup
    activeSessions.delete(userId);
    await cleanupSession(sessionId);
  }
});

// ─── Helper: Send a single clip ─────────────────────────────
async function sendClip(
  ctx: Context,
  clip: GeneratedClip,
  index: number,
  total: number
) {
  const fileSizeMB = (clip.fileSize / (1024 * 1024)).toFixed(1);

  const caption =
    `🎬 *Clip ${index}/${total}: ${escapeMarkdown(clip.title)}*\n\n` +
    `🔥 Viral Score: ${"⭐".repeat(Math.min(clip.viralScore, 5))} (${clip.viralScore}/10)\n` +
    `⏱ Durasi: ${clip.duration}s | 📦 ${fileSizeMB} MB\n` +
    `💡 ${escapeMarkdown(clip.reason)}\n\n` +
    `${clip.hashtags.map((h) => `#${h}`).join(" ")}`;

  // Telegram limit 50MB untuk video
  if (clip.fileSize > 50 * 1024 * 1024) {
    await ctx.reply(`⚠️ Clip ${index} terlalu besar (${fileSizeMB}MB). Skipping...`);
    return;
  }

  await ctx.replyWithVideo(new InputFile(clip.filePath), {
    caption,
    parse_mode: "Markdown",
    supports_streaming: true,
  });
}

// ─── Helper: Edit message safely ────────────────────────────
async function editMessage(ctx: Context, messageId: number, text: string) {
  try {
    await ctx.api.editMessageText(ctx.chat!.id, messageId, text, {
      parse_mode: "Markdown",
    });
  } catch {
    // Ignore edit errors (e.g., message not modified)
  }
}

// ─── Helper: Escape Markdown special chars ──────────────────
function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

// ─── Error handling ─────────────────────────────────────────
bot.catch((err) => {
  console.error("Bot error:", err);
});

// ─── Start bot ──────────────────────────────────────────────
async function main() {
  // Buat temp directory
  const { mkdir } = await import("fs/promises");
  await mkdir(config.tempDir, { recursive: true });

  console.log("🤖 Viral Clipper Bot is starting...");
  console.log(`   Max clips: ${config.maxClips}`);
  console.log(`   Clip duration: ${config.minClipDuration}-${config.maxClipDuration}s`);

  await bot.start({
    onStart: () => console.log("✅ Bot is running!"),
  });
}

main().catch(console.error);
