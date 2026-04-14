import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  ModelType,
} from "@elizaos/core";
import { getCache } from "../youtube/cache";
import { extractJson } from "../youtube/json";
import { formatTime } from "../youtube/youtube";

const RATE_KEYWORDS = /\b(rate|rating|score|skor|nilai|review)\b/i;
const CLIP_REF = /\b(clip|clips|short|shorts|reel|reels)\b/i;

export const rateClipsAction: Action = {
  name: "RATE_CLIPS",
  similes: ["SCORE_CLIPS", "REVIEW_CLIPS", "EVALUATE_CLIPS"],
  description:
    "When the user asks to rate, score, or review the clips that were just generated, re-evaluate the cached clip suggestions and return per-clip ratings.",

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content?.text ?? "";
    if (!RATE_KEYWORDS.test(text) || !CLIP_REF.test(text)) return false;
    return !!getCache(message.roomId);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options,
    callback?: HandlerCallback
  ) => {
    const cache = getCache(message.roomId);
    if (!cache) {
      await callback?.({ text: "No clips to rate yet — send me a YouTube link and ask for clips first." });
      return { success: false, text: "no cache" };
    }

    const clipsList = cache.clips
      .map(
        (c, i) =>
          `Clip ${i + 1}: "${c.title}" (${formatTime(c.startTime)}–${formatTime(c.endTime)}, ${c.endTime - c.startTime}s)\nReason: ${c.reason}`
      )
      .join("\n\n");

    const prompt = `You are a viral short-form video critic. Re-rate the clips below that were extracted from the video "${cache.videoTitle}".

For each clip, judge on these criteria (1-10 each):
- hook: strength of the first 3 seconds
- payoff: satisfying resolution / shareability
- clarity: understandable without full video context
- emotion: emotional pull (funny/surprising/inspiring/quotable)

CANDIDATE CLIPS
${clipsList}

Return ONLY valid JSON (no markdown, no prose):
{
  "ratings": [
    {
      "index": <1-based clip number>,
      "hook": <1-10>,
      "payoff": <1-10>,
      "clarity": <1-10>,
      "emotion": <1-10>,
      "overall": <1-10>,
      "verdict": "<one short sentence, honest>"
    }
  ],
  "bestClip": <1-based index of the strongest clip>,
  "summary": "<1-2 sentences overall>"
}`;

    try {
      const raw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
      const parsed = extractJson(raw);
      const ratings = Array.isArray(parsed.ratings) ? parsed.ratings : [];

      const lines = ratings.map((r: any) => {
        const clip = cache.clips[(r.index || 1) - 1];
        const title = clip?.title ?? `Clip ${r.index}`;
        return (
          `🎬 *Clip ${r.index}: ${title}*\n` +
          `  Hook ${r.hook}/10 · Payoff ${r.payoff}/10 · Clarity ${r.clarity}/10 · Emotion ${r.emotion}/10\n` +
          `  ⭐ Overall: ${r.overall}/10 — ${r.verdict}`
        );
      });

      const best = parsed.bestClip ? `\n🏆 Best clip: #${parsed.bestClip}` : "";
      const summary = parsed.summary ? `\n\n📝 ${parsed.summary}` : "";

      await callback?.({
        text: `📊 Clip ratings for *${cache.videoTitle}*:\n\n${lines.join("\n\n")}${best}${summary}`,
      });
      return { success: true, text: "ok" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({ text: `❌ Couldn't rate the clips: ${msg}` });
      return { success: false, text: "error", error: msg };
    }
  },

  examples: [
    [
      { name: "{{user1}}", content: { text: "rate the clips you just made" } },
      { name: "ElizaClip", content: { text: "Reviewing them now.", actions: ["RATE_CLIPS"] } },
    ],
  ],
};
