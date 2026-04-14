# ElizaClip

**Personal AI agent that turns long YouTube videos into viral Shorts — chat with it on Telegram or the web, and it posts directly to your channel.**

Built on [ElizaOS](https://elizaos.com), runs on [Nosana](https://nosana.com) decentralized GPUs, inference by Qwen3.5-9B-FP8.

![ElizaOS](./assets/NosanaXEliza.jpg)

---

## What It Does

Paste a YouTube URL and ElizaClip will:

1. **Explain** the video — pulls the transcript and summarizes it.
2. **Clip** it — an LLM scans the transcript for the most viral moments, then `ffmpeg` cuts them into vertical 1080×1920 Shorts (≤59s).
3. **Rate** the clips — scores each 1–10 for viral potential with reasoning.
4. **Upload** straight to your YouTube channel as a Short, formatted with `#Shorts` title, hashtags, and privacy settings.

Two surfaces, one brain:
- **Telegram bot** — chat naturally, share links, ask for clips.
- **Web UI** (`ElizaClipFrontend/`) — clip dashboard with SSE streaming, previews, and one-click upload.

Both surfaces share the same agent runtime, the same memory (pglite), and the same character. Switching between them is seamless.

---

## Architecture

```
┌──────────────┐     ┌──────────────┐
│   Telegram   │     │   Web UI     │
│  (plugin)    │     │  (Next.js)   │
└──────┬───────┘     └──────┬───────┘
       │                    │
       ▼                    ▼
   ┌────────────────────────────┐
   │    ElizaOS Runtime         │    ← one process, shared memory
   │  ┌──────────────────────┐  │
   │  │ elizaclip plugin     │  │
   │  │  • EXPLAIN_YOUTUBE   │  │
   │  │  • CLIP_YOUTUBE      │  │
   │  │  • RATE_CLIPS        │  │
   │  │  • UPLOAD_YOUTUBE    │  │
   │  │  • /chat /stream ... │  │── HTTP routes for web UI
   │  └──────────────────────┘  │
   └──────────────┬─────────────┘
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
  ┌──────────┐        ┌────────────┐
  │ Qwen3.5  │        │ yt-dlp +   │
  │ on Nosana│        │ ffmpeg     │
  └──────────┘        └────────────┘
```

---

## Project Structure

```
ElizaClip/
├── characters/
│   └── agent.character.json        # Personality, system prompt, plugin list
├── src/
│   ├── index.ts                    # Plugin entry — registers actions + HTTP routes
│   ├── actions/
│   │   ├── explain-youtube.ts      # Summarize a video from its transcript
│   │   ├── clip-youtube.ts         # LLM picks viral moments → ffmpeg cuts clips
│   │   ├── rate-clips.ts           # Score generated clips 1–10
│   │   └── upload-youtube.ts       # Publish a clip to YouTube as a Short
│   ├── youtube/
│   │   ├── youtube.ts              # yt-dlp download, transcript, ffmpeg clipper
│   │   ├── cache.ts                # Per-room clip cache (JSON on disk)
│   │   └── json.ts                 # Robust LLM-JSON extractor
│   └── http/
│       └── web-api.ts              # Routes: /chat /stream /clips /upload
├── scripts/
│   ├── qwen-proxy.ts               # Local proxy that fronts the Nosana Qwen endpoint
│   └── youtube-oauth.ts            # One-shot helper to mint a YouTube refresh token
├── Dockerfile                      # Container image for Nosana deployment
├── docker-start.sh                 # Boots Qwen proxy + agent
├── nosana-job.json                 # Nosana deployment job definition (gitignored)
└── .env.example
```

---

## Prerequisites

- Node.js 23+
- `bun` and `pnpm` (`npm i -g bun pnpm`)
- `ffmpeg` and `yt-dlp` on `$PATH`
- A Telegram bot token — create one via [@BotFather](https://t.me/botfather)
- A YouTube OAuth app (Client ID / Secret / refresh token) — only needed for upload

---

## Local Setup

```bash
git clone <your-fork>
cd ElizaClip

cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN + YOUTUBE_* (see below)

pnpm install
bun run dev        # starts ElizaOS on :3000
```

### Environment variables

See [.env.example](.env.example) for the full list. The essentials:

```env
# LLM — Nosana-hosted Qwen
OPENAI_API_KEY=nosana
OPENAI_BASE_URL=http://127.0.0.1:3939/v1     # the local Qwen proxy
OPENAI_LARGE_MODEL=Qwen3.5-9B-FP8
OPENAI_SMALL_MODEL=Qwen3.5-9B-FP8

# Embeddings — Nosana-hosted
OPENAI_EMBEDDING_URL=https://4yiccatpyxx773jtewo5ccwhw1s2hezq5pehndb6fcfq.node.k8s.prd.nos.ci/v1
OPENAI_EMBEDDING_API_KEY=nosana
OPENAI_EMBEDDING_MODEL=Qwen3-Embedding-0.6B
OPENAI_EMBEDDING_DIMENSIONS=1024

# Telegram
TELEGRAM_BOT_TOKEN=...

# YouTube OAuth (for upload) — see "YouTube OAuth" section below
YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
YOUTUBE_REFRESH_TOKEN=...

SERVER_PORT=3000
```

### YouTube OAuth (first time only)

1. In [Google Cloud Console](https://console.cloud.google.com/), create OAuth credentials for a **Desktop app**, enable **YouTube Data API v3**.
2. Put the Client ID / Secret in `.env`.
3. Mint a refresh token:
   ```bash
   bun run scripts/youtube-oauth.ts
   ```
   Follow the URL, paste back the code — it prints a `YOUTUBE_REFRESH_TOKEN`. Add it to `.env`.

---

## Usage

### Telegram

Talk to your bot:

- *"What's this about?"* + YouTube link → summary
- *"Make 3 viral shorts from https://youtu.be/…"* → generates vertical 9:16 clips
- *"Rate the clips"* → scores 1–10 with reasoning
- *"Upload clip 1 to my YouTube"* → publishes as a private Short

### Web UI

The agent exposes HTTP routes under `/api/agents/<agentId>/plugins/elizaclip/*`:

| Route            | Method | Purpose                         |
|------------------|--------|---------------------------------|
| `/chat`          | POST   | Send a user message             |
| `/stream`        | GET    | Server-Sent Events of replies   |
| `/clips`         | GET    | List generated clips            |
| `/clips/file/:i` | GET    | Stream a clip (Range supported) |
| `/upload`        | POST   | Publish clip `index` to YouTube |

The companion frontend in `../ElizaClipFrontend` wraps these routes in a Next.js UI. Start it with `bun run dev` (runs on :3001, proxies `/agent/*` → `:3000`).

### Memory is shared

Both surfaces write to the same pglite database. Tell the bot your name in Telegram and the web UI remembers it — conversations stay continuous across clients.

---

## Deploy to Nosana

Build and push the image:

```bash
docker build -t <dockerhub-user>/elizaclip:latest .
docker push <dockerhub-user>/elizaclip:latest
```

Create a Nosana job definition (keep secrets out of git — this file is gitignored):

```json
{
  "version": "0.1",
  "type": "container",
  "meta": { "trigger": "dashboard" },
  "ops": [
    {
      "type": "container/run",
      "id": "elizaclip",
      "args": {
        "image": "<dockerhub-user>/elizaclip:latest",
        "expose": [{ "port": 3000 }],
        "env": {
          "TELEGRAM_BOT_TOKEN": "…",
          "OPENAI_API_KEY": "nosana",
          "OPENAI_BASE_URL": "http://127.0.0.1:3939/v1",
          "OPENAI_LARGE_MODEL": "Qwen3.5-9B-FP8",
          "OPENAI_SMALL_MODEL": "Qwen3.5-9B-FP8",
          "OPENAI_EMBEDDING_URL": "https://4yiccatpyxx773jtewo5ccwhw1s2hezq5pehndb6fcfq.node.k8s.prd.nos.ci/v1",
          "OPENAI_EMBEDDING_API_KEY": "nosana",
          "OPENAI_EMBEDDING_MODEL": "Qwen3-Embedding-0.6B",
          "OPENAI_EMBEDDING_DIMENSIONS": "1024",
          "YOUTUBE_CLIENT_ID": "…",
          "YOUTUBE_CLIENT_SECRET": "…",
          "YOUTUBE_REFRESH_TOKEN": "…",
          "SERVER_PORT": "3000",
          "NODE_ENV": "production"
        }
      }
    }
  ]
}
```

Deploy via the [Nosana Dashboard](https://dashboard.nosana.com/deploy) or CLI:

```bash
nosana job post --file ./nosana-job.json --market nvidia-3090 --timeout 300
```

The container boots [docker-start.sh](docker-start.sh), which spawns the local Qwen proxy (`scripts/qwen-proxy.ts`) on `127.0.0.1:3939` and then `pnpm start`. The proxy fronts the Nosana-hosted inference endpoint so the OpenAI plugin can hit a stable localhost URL.

---

## How Actions Work

Each action is a small ElizaOS [Action](https://elizaos.github.io/eliza/docs/core/actions): a `validate()` that decides when to fire, and a `handler()` that does the work and calls `callback()` to reply.

**Example — `CLIP_YOUTUBE_VIDEO`:**

1. `validate`: message contains clip keyword and a YouTube URL (or one remembered for this room).
2. `handler`:
   - `yt-dlp` downloads ≤720p mp4
   - Fetch captions (English → Indonesian fallback)
   - LLM (`ModelType.TEXT_LARGE`) picks 3 viral moments + titles + hashtags, returns JSON
   - `ffmpeg` renders each clip as vertical 1080×1920 with a blurred background for letterboxing, audio re-encoded to AAC 128k
   - Writes `GeneratedClip[]` to the per-room cache (disk-backed, survives restarts)
   - Sends each clip back as a video message

The cache ([src/youtube/cache.ts](src/youtube/cache.ts)) is keyed by `roomId`, so Telegram chats and web rooms have independent clip lists but share the agent's memory and character.

---

## Development Tips

- **`elizaos start` has no hot reload** — restart the process after edits, or use `elizaos dev`.
- **Plugin routes mount at `/api/agents/:id/plugins/<plugin-name>/<route>`.** ElizaOS prefixes with the plugin name, so my `/chat` route lives at `…/plugins/elizaclip/chat`.
- **Clip files are served with HTTP Range support** (206 Partial Content). Browsers and Safari need this to seek in `<video>` tags.
- **The Qwen proxy must be running before the agent starts.** Locally: `bun run proxy` in one shell, `bun run dev` in another. In Docker, `docker-start.sh` handles order.

---

## Security Notes

- **`nosana-job.json` is gitignored** because it contains your Telegram and YouTube secrets. Never commit it.
- Rotate the YouTube refresh token after any suspected exposure at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- Nosana job definitions are publicly readable on-chain — treat the env block like a pastebin. Use short-lived tokens where possible.

---

## Resources

- [ElizaOS docs](https://elizaos.github.io/eliza/docs)
- [Nosana Dashboard](https://dashboard.nosana.com)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) · [ffmpeg](https://ffmpeg.org)
- [YouTube Data API v3](https://developers.google.com/youtube/v3)

---

## License

MIT — see [LICENSE](./LICENSE).

**Built with ElizaOS · Deployed on Nosana · Powered by Qwen3.5**
