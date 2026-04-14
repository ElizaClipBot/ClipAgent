# 🎬 Viral Clipper Bot

Telegram bot yang menganalisis video YouTube dan otomatis generate clip-clip pendek yang berpotensi viral menggunakan AI.

## Cara Kerja

```
User kirim link YouTube
        │
        ▼
  ┌─────────────┐
  │  yt-dlp     │  Download video (max 720p)
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  FFmpeg     │  Extract audio → WAV 16kHz mono
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  Whisper    │  Speech-to-text dengan timestamp
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  Claude AI  │  Analisis transcript, pilih momen viral
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  FFmpeg     │  Potong video jadi clip-clip
  └──────┬──────┘
         │
         ▼
  Kirim clips ke user via Telegram
```

## Prerequisites

Pastikan sudah terinstall di server/mesin kamu:

| Tool | Install | Cek |
|------|---------|-----|
| **Node.js** ≥18 | https://nodejs.org | `node --version` |
| **yt-dlp** | `pip install yt-dlp` | `yt-dlp --version` |
| **FFmpeg** | `sudo apt install ffmpeg` / `brew install ffmpeg` | `ffmpeg -version` |
| **Whisper** | `pip install openai-whisper` | `whisper --help` |

## Setup

### 1. Clone & Install

```bash
git clone <repo-url> viral-clipper
cd viral-clipper
npm install
```

### 2. Buat Telegram Bot

1. Buka Telegram, cari **@BotFather**
2. Kirim `/newbot`
3. Ikuti instruksi, kamu akan dapat **Bot Token**
4. Copy token tersebut

### 3. Dapat Anthropic API Key

1. Buka https://console.anthropic.com
2. Buat API key
3. Copy key tersebut

### 4. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` dan isi:

```
TELEGRAM_BOT_TOKEN=7123456789:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 5. Run

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start
```

## Usage

1. Buka Telegram, cari bot kamu
2. Kirim `/start`
3. Kirim link YouTube apapun
4. Tunggu 2-5 menit (tergantung durasi video)
5. Terima clip-clip viral! 🔥

## Configuration

| Variable | Default | Keterangan |
|----------|---------|------------|
| `MAX_CLIPS` | 3 | Jumlah clips yang digenerate |
| `MAX_CLIP_DURATION` | 60 | Durasi max per clip (detik) |
| `MIN_CLIP_DURATION` | 15 | Durasi min per clip (detik) |
| `TEMP_DIR` | ./tmp | Folder temporary files |

## Deploy ke VPS

### Dengan PM2 (recommended)

```bash
npm install -g pm2
npm run build
pm2 start dist/index.js --name viral-clipper
pm2 save
pm2 startup  # auto-start saat reboot
```

### Dengan Docker

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg \
    && pip3 install yt-dlp openai-whisper --break-system-packages \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist ./dist
COPY .env .

CMD ["node", "dist/index.js"]
```

```bash
docker build -t viral-clipper .
docker run -d --name viral-clipper --restart unless-stopped viral-clipper
```

## Estimasi Biaya

| Komponen | Biaya |
|----------|-------|
| Telegram Bot | Gratis |
| Whisper | Gratis (local, tapi butuh GPU/CPU) |
| Claude API | ~$0.01-0.05 per video (tergantung panjang transcript) |
| VPS | ~$5-20/bulan (butuh min 4GB RAM untuk Whisper) |

## Tips

- **GPU**: Whisper JAUH lebih cepat dengan GPU (NVIDIA + CUDA). Tanpa GPU, transcription video 10 menit bisa 5-10 menit.
- **Whisper Model**: Pakai `small` untuk balance speed/quality. Ganti ke `tiny` kalau mau lebih cepat, atau `medium` kalau mau lebih akurat.
- **Video Panjang**: Untuk video >15 menit, pertimbangkan chunking transcript sebelum kirim ke Claude.

## Troubleshooting

| Error | Solusi |
|-------|--------|
| `yt-dlp: command not found` | `pip install yt-dlp` |
| `ffmpeg: command not found` | `sudo apt install ffmpeg` |
| `whisper: command not found` | `pip install openai-whisper` |
| Video gagal download | Update yt-dlp: `pip install -U yt-dlp` |
| Telegram file too large | Clip >50MB otomatis di-skip |
| Out of memory (Whisper) | Ganti model ke `tiny` atau `base` |

## License

MIT
