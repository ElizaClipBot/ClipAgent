import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  ModelType,
} from "@elizaos/core";
import { v4 as uuid } from "uuid";
import {
  extractYoutubeUrl,
  getYouTubeTranscript,
  getVideoMetadata,
  transcriptToText,
  cleanupSession,
  formatTime,
} from "../youtube/youtube";
import { resolveYoutubeUrl, getRememberedUrl } from "../youtube/cache";

const EXPLAIN_KEYWORDS =
  /\b(what|about|summari[sz]e|describe|explain|transcri(be|pt|ption)|jelaskan|isi(nya)?|tentang|apa)\b/i;

export const explainYoutubeAction: Action = {
  name: "EXPLAIN_YOUTUBE_VIDEO",
  similes: [
    "SUMMARIZE_YOUTUBE",
    "DESCRIBE_YOUTUBE",
    "WATCH_YOUTUBE",
    "TRANSCRIBE_YOUTUBE",
  ],
  description:
    "When the user shares a YouTube link and asks what the video is about, explain / summarize / describe / transcribe it — fetch the YouTube captions and produce a concise summary of the content.",

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content?.text ?? "";
    if (extractYoutubeUrl(text)) return true;
    // Follow-up questions about a previously-shared video ("what was it about?").
    return EXPLAIN_KEYWORDS.test(text) && !!getRememberedUrl(message.roomId);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options,
    callback?: HandlerCallback
  ) => {
    const text = message.content?.text ?? "";
    const url = await resolveYoutubeUrl(runtime, message.roomId, text);
    if (!url) {
      await callback?.({ text: "I didn't see a YouTube link. Paste one and I'll break it down for you." });
      return { success: false, text: "no url" };
    }

    const sessionId = uuid();
    try {
      await callback?.({ text: "📼 Pulling the transcript from YouTube..." });

      const [meta, segments] = await Promise.all([
        getVideoMetadata(url),
        getYouTubeTranscript(url, sessionId),
      ]);

      if (segments.length === 0) {
        await callback?.({ text: "This video has no captions available — I can't transcribe it." });
        return { success: false, text: "no captions" };
      }

      const transcript = transcriptToText(segments, true);
      const truncated = transcript.length > 16000 ? transcript.slice(0, 16000) + "\n...[truncated]" : transcript;

      const prompt = `You are summarizing a YouTube video from its transcript (captions).

Title: ${meta.title}
Duration: ${formatTime(meta.duration)}

Transcript (with timestamps):
${truncated}

Write a clear, concise explanation of this video for the user, in the user's language if obvious (English or Indonesian). Structure:
1. One-sentence TL;DR.
2. 3-6 bullet points covering the key topics/arguments, referencing rough timestamps where useful.
3. A short closing line on who the video is for or the main takeaway.

Keep it under ~200 words and sound natural in a Telegram chat.`;

      const summary = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });

      await callback?.({
        text: `🎬 *${meta.title}* (${formatTime(meta.duration)})\n\n${summary}`,
      });
      return { success: true, text: "ok" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await callback?.({ text: `❌ Couldn't explain the video: ${msg}` });
      return { success: false, text: "error", error: msg };
    } finally {
      await cleanupSession(sessionId);
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "what's this video about? https://youtu.be/dQw4w9WgXcQ" },
      },
      {
        name: "ElizaClip",
        content: {
          text: "Let me pull the captions and summarize it.",
          actions: ["EXPLAIN_YOUTUBE_VIDEO"],
        },
      },
    ],
  ],
};
