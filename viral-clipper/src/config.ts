import "dotenv/config";
import path from "path";

// Root project directory (untuk resolve venv path)
const projectRoot = path.resolve(__dirname, "..");

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN!,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
  maxClips: parseInt(process.env.MAX_CLIPS || "3", 10),
  maxClipDuration: parseInt(process.env.MAX_CLIP_DURATION || "60", 10),
  minClipDuration: parseInt(process.env.MIN_CLIP_DURATION || "15", 10),
  tempDir: path.resolve(process.env.TEMP_DIR || "./tmp"),
  // Path ke whisper binary di dalam venv project
  whisperBin: process.env.WHISPER_BIN || path.join(projectRoot, "venv", "bin", "whisper"),
  // Gradio Whisper API URL (hosted Whisper Large V3)
  gradioWhisperUrl: process.env.GRADIO_WHISPER_URL || "https://5ye5ukld3vozxjuved6uxaxd5ueqepmh5fwb4lgbjiue.node.k8s.prd.nos.ci",
};

// Validasi config saat startup
export function validateConfig() {
  if (!config.telegramToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  if (!config.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }
}
