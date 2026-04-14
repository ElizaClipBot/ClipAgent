import type { IAgentRuntime } from "@elizaos/core";
import type { ClipSuggestion } from "./youtube";
import { extractYoutubeUrl } from "./youtube";

export interface RoomClipCache {
  url: string;
  videoTitle: string;
  videoDuration: number;
  transcriptText: string;
  clips: ClipSuggestion[];
  updatedAt: number;
}

const store = new Map<string, RoomClipCache>();
const urlStore = new Map<string, { url: string; updatedAt: number }>();

export function setCache(roomId: string, data: RoomClipCache) {
  store.set(roomId, data);
  urlStore.set(roomId, { url: data.url, updatedAt: Date.now() });
}

export function getCache(roomId: string): RoomClipCache | undefined {
  return store.get(roomId);
}

export function rememberUrl(roomId: string, url: string) {
  urlStore.set(roomId, { url, updatedAt: Date.now() });
}

export function getRememberedUrl(roomId: string): string | undefined {
  return urlStore.get(roomId)?.url;
}

/**
 * Resolve a YouTube URL for the current turn. Order:
 *   1. URL in the current message
 *   2. URL cached for this room (set by a prior action)
 *   3. Scan recent memories in the room for a YouTube URL
 */
export async function resolveYoutubeUrl(
  runtime: IAgentRuntime,
  roomId: string,
  currentText: string
): Promise<string | undefined> {
  const inline = extractYoutubeUrl(currentText);
  if (inline) {
    rememberUrl(roomId, inline);
    return inline;
  }
  const cached = getRememberedUrl(roomId);
  if (cached) return cached;

  try {
    const memories = await runtime.getMemories({
      roomId: roomId as any,
      count: 30,
      tableName: "messages",
    } as any);
    for (const m of memories) {
      const text = (m as any)?.content?.text;
      if (typeof text !== "string") continue;
      const found = extractYoutubeUrl(text);
      if (found) {
        rememberUrl(roomId, found);
        return found;
      }
    }
  } catch {
    // ignore — runtime API shape varies
  }
  return undefined;
}
