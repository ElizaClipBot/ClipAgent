import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
import { TranscriptSegment } from "./downloader";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

export interface ClipSuggestion {
  startTime: number;   // detik
  endTime: number;     // detik
  title: string;       // judul clip
  reason: string;      // kenapa ini viral-worthy
  viralScore: number;  // 1-10
  hashtags: string[];  // suggested hashtags
}

/**
 * Analisis transcript dan identifikasi momen-momen yang berpotensi viral.
 *
 * Claude akan melihat keseluruhan transcript lalu memilih
 * beberapa segment yang paling menarik untuk dijadikan clip pendek.
 */
export async function analyzeForViralClips(
  transcript: TranscriptSegment[],
  videoTitle: string,
  videoDuration: number
): Promise<ClipSuggestion[]> {
  // Format transcript jadi readable text dengan timestamp
  const formattedTranscript = transcript
    .map((seg) => `[${formatTime(seg.start)} - ${formatTime(seg.end)}] ${seg.text}`)
    .join("\n");

  const systemPrompt = `Kamu adalah seorang viral content strategist dan video editor profesional.
Tugasmu adalah menganalisis transcript video dan mengidentifikasi momen-momen yang paling berpotensi viral untuk dijadikan short-form clips (Reels, Shorts, TikTok).

Kriteria momen viral:
1. **Hook kuat** — 3 detik pertama clip harus langsung menarik perhatian
2. **Emosi tinggi** — momen lucu, mengejutkan, kontroversial, inspiratif, atau relatable
3. **Quotable** — ada kalimat/statement yang bisa jadi quote atau caption
4. **Self-contained** — clip bisa dipahami tanpa konteks video penuh
5. **Shareable** — orang akan ingin share ke teman mereka
6. **Cliffhanger/Payoff** — ada buildup dan resolusi dalam clip

ATURAN:
- Setiap clip harus berdurasi antara ${config.minClipDuration}-${config.maxClipDuration} detik
- Pilih tepat ${config.maxClips} clip terbaik
- Clip TIDAK BOLEH overlap satu sama lain
- Beri padding 2-3 detik sebelum momen inti agar konteks tidak terpotong
- startTime dan endTime harus dalam detik (angka bulat)
- Viral score 1-10, dimana 10 = pasti viral`;

  const userPrompt = `Berikut transcript video "${videoTitle}" (durasi: ${formatTime(videoDuration)}):

${formattedTranscript}

Analisis transcript di atas dan pilih ${config.maxClips} momen terbaik untuk dijadikan viral clips.

Respond dalam format JSON SAJA (tanpa markdown backticks), dengan struktur:
{
  "clips": [
    {
      "startTime": <number in seconds>,
      "endTime": <number in seconds>,
      "title": "<judul pendek yang catchy>",
      "reason": "<kenapa ini berpotensi viral, 1-2 kalimat>",
      "viralScore": <1-10>,
      "hashtags": ["tag1", "tag2", "tag3"]
    }
  ]
}`;

  console.log(`[analyzer] Sending ${transcript.length} segments to Claude for analysis...`);
  const t0 = Date.now();
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [
      { role: "user", content: userPrompt },
    ],
    system: systemPrompt,
  });

  console.log(`[analyzer] ✅ Claude responded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Extract text dari response
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  // Parse JSON — bersihkan kalau ada markdown backticks
  const cleaned = text.replace(/```json\s?|```/g, "").trim();
  const parsed = JSON.parse(cleaned);

  console.log(`[analyzer] Parsed ${(parsed.clips || []).length} clip suggestions`);

  // Validasi dan return
  return (parsed.clips || []).map((clip: any) => ({
    startTime: Math.max(0, Math.floor(clip.startTime)),
    endTime: Math.min(videoDuration, Math.ceil(clip.endTime)),
    title: clip.title || "Untitled Clip",
    reason: clip.reason || "",
    viralScore: Math.min(10, Math.max(1, clip.viralScore || 5)),
    hashtags: clip.hashtags || [],
  }));
}

/**
 * Format detik jadi HH:MM:SS
 */
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export { formatTime };
