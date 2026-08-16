# dsh-file-upload

**File-message plugin for DeepSeek Harness (dsh).** Claude-desktop-style drag-and-drop and paperclip uploads, content sniffing, fully bundled document → Markdown conversion (MarkItDown engine, 20+ formats, image OCR), text inlining into the composer, voice-to-text input, and a `read_document` tool for agents.

[![npm](https://img.shields.io/npm/v/dsh-file-upload)](https://www.npmjs.com/package/dsh-file-upload)
[![CI](https://github.com/HongMing-Huang/dsh-file-upload/actions/workflows/ci.yml/badge.svg)](https://github.com/HongMing-Huang/dsh-file-upload/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

English | [中文](README.zh.md)

> **Zero-config, install-and-use.** Every feature works out of the box with
> sensible defaults — no Python, no downloads, no picking backends. The only
> optional knob is an ASR key for audio-file transcription, and even that is
> auto-detected from the standard `OPENAI_API_KEY` credential.

## Features

- **Upload** — composer paperclip button plus a global drag-and-drop overlay ("release to attach"), multi-file support.
- **Attachment cards** — color-coded type badges (PDF red / DOC blue / XLS green / TXT gray / ZIP purple / JSON gold) with name and size; removable.
- **Text inlining (Claude style)** — small text files (code, JSON, CSV, logs, config) are inserted **directly into the composer** via the official `slash/input-insert-text` event, so the model sees the content immediately; larger text files insert a path reference with a preview.
- **Document → Markdown, fully bundled** — the MarkItDown engine ships inside the plugin (Microsoft MarkItDown TypeScript port, `markitdown-node`): PDF / DOCX / PPTX / XLSX / HTML / CSV / JSON / XML / RSS / Atom / ZIP / Jupyter / image OCR / audio transcription. **No Python, no downloads, no setup.**
- **Image OCR by default** — uploaded images are readable through `read_document` (Tesseract, 110+ languages); no vision plugin required.
- **Voice input** — record from the mic and transcribe straight into the composer (browser Web Speech API, zero dependencies); audio files upload as file attachments.
- **`read_document` tool for agents** — line-numbered paging (`offset`/`limit`), byte-budgeted LRU cache (invalidated on file change), size pre-checks, reads through `ctx.fs` (inherits sandbox and fs-observation policy).
- **Security** — loopback-only uploads, sanitized file names, session-isolated storage (`.dsh-uploads/<sessionId>`), sha256 content dedup, bounded concurrency, TTL sweep.

## Install

```sh
dsh plugin --profile web add dsh-file-upload
# restart dsh web
```

## Usage

1. Click the paperclip in the composer toolbar, or drag files anywhere over the window;
2. Small text files land directly in the composer; documents appear as attachment cards and their path is sent with the message;
3. The agent reads documents with `read_document <path>` — converted to Markdown on demand, pageable with `offset`/`limit`.

### MarkItDown (fully bundled — no downloads, no setup)

**The MarkItDown capability ships inside the plugin. Works out of the box: no Python, no pip, no downloads, no build-script approval.**

- **Bundled engine** — the Microsoft MarkItDown TypeScript port (`markitdown-node`) is a regular dependency covering **20+ formats**: PDF, DOCX, PPTX, XLSX, HTML, CSV, JSON, XML, RSS, Atom, ZIP, Jupyter notebooks, images (OCR via Tesseract, 110+ languages), and audio transcription (via LLM, needs model credentials).
- **Images** — OCR to text by default through the bundled engine.
- **Offline** — all parsing runs locally, no network calls.

> Optional upgrade: if an official MarkItDown CLI already exists on your machine (or is set via `markitdownBin`), the plugin prefers it (adds EPUB and more); without one the bundled engine is always available.

```yaml
- id: file-upload
  config:
    markitdownBin: /path/to/your/markitdown   # optional; empty = bundled engine only
```

Startup log (bundled mode):

```
[dsh-file-upload] Document → Markdown ready: bundled MarkItDown engine (20+ formats, image OCR) — fully packaged, no downloads, no Python.
```

### How images are handled (auto-adapted to your model)

The plugin **detects your session's model capability at upload time** and tells the agent the right way to read the image:

| Detected route | What happens |
|---|---|
| **Multimodal model** (declares `image` input, e.g. GPT-4o / Qwen-VL / Claude / Gemini) | upload response carries `imageMode: native`; the message tells the agent to use the official `read_image` tool — the image enters model context directly |
| **Text-only model** (or unknown) | `imageMode: ocr`; the agent uses `read_document` on the image path — the bundled engine runs OCR (Tesseract, 110+ languages) and returns a text description |

The detection mirrors the official `read_image` route gate (`ctx.llm.resolveModelInfo` + `inputModalities`), so it never claims image support that the routed model does not declare.

### Voice input (zero-config)

- **Record** — the mic button in the composer works immediately (browser Web Speech API, no setup); the transcript lands in the composer as editable text, review it before sending.
- **Audio files** — uploaded audio is transcribed **automatically** when an OpenAI-compatible ASR key is available: the plugin auto-detects the standard `OPENAI_API_KEY` credential (no configuration needed) and uses `https://api.openai.com/v1/audio/transcriptions`; the transcript travels with the message. Without a key, audio uploads still work as regular file attachments.
- Override the endpoint/model only if you need to (e.g. a self-hosted ASR):

```yaml
- id: file-upload
  config:
    asrEndpoint: ''               # empty = auto (standard OpenAI endpoint when a key is present)
    asrApiKeyEnv: OPENAI_API_KEY  # env var holding the ASR key
    asrModel: whisper-1
```

## Configuration

> All fields have sensible defaults — you can install and use the plugin
> without touching any of them. Tune only what you need.

| Field | Default | Description |
|---|---|---|
| `uploadMaxBytes` | 25165824 (24 MB) | Max bytes per uploaded file |
| `allowedExtensions` | `[]` | Extension allowlist; empty = all allowed |
| `uploadTtlMs` | 604800000 (7 days) | Unreferenced upload lifetime |
| `sweepIntervalMs` | 3600000 (1 h) | Sweep period; 0 = disabled |
| `maxConcurrentUploads` | 4 | Concurrent upload limit |
| `inlineTextLimit` | 8192 (8 KB) | Text inlined into the composer up to this size |
| `previewTextLimit` | 2048 (2 KB) | Preview length for larger text files |
| `maxFileBytes` | 25165824 | Byte cap for one document read |
| `readLimit` | 2000 | Max lines returned by one `read_document` call |
| `sheetRowLimit` | 200 | Rows kept per XLSX sheet |
| `maxSheets` | 5 | Sheets read per workbook |
| `cacheEntries` | 16 | Parse-cache entry count |
| `cacheMaxBytes` | 67108864 (64 MB) | Parse-cache byte budget |
| `markitdownBin` | `''` | Optional MarkItDown CLI path; empty = auto-detect PATH |
| `markitdownTimeoutMs` | 120000 | Timeout for one CLI invocation |
| `maxRecordSec` | 60 | Max voice recording length (seconds) |
| `asrEndpoint` | `''` | Optional OpenAI-compatible ASR endpoint for audio files |
| `asrApiKeyEnv` | `OPENAI_API_KEY` | Env var holding the ASR API key |
| `asrModel` | `whisper-1` | ASR model name |

## Development

```sh
pnpm install
pnpm build     # tsc (host) + esbuild (client bundle)
pnpm test      # node --test
```

## Architecture

```
src/
├── index.ts        # entry: apply + Config schema + assembly
├── detect.ts       # content sniffing (never trusts extensions)
├── convert.ts      # MarkItDown engine + optional CLI backend
├── upload.ts       # upload route: loopback/session/size/dedup/TTL
├── asr.ts          # audio transcription (OpenAI-compatible endpoint)
├── tool.ts         # read_document: ctx.fs reads + paging + LRU cache
└── client/
    └── index.tsx   # paperclip + drag overlay + mic + attachment cards
```

Dual-face plugin: `dsh.bundle` (host) + `dsh.client` (web UI). No official patches — everything uses official seams (`ctx.webServer`, `ctx.tools`, `ctx.systemPrompt`, `ctx.sessions`, `slash/input-insert-text`, `slash/input-insert-reference`).

## Security

- Uploads are loopback-only and same-origin checked.
- File names are sanitized (control chars, path separators, dot segments, leading dots stripped).
- Storage is session-isolated under the session's own workspace; unknown sessions get 403.
- sha256 content dedup, bounded concurrency (429 on overload), TTL sweep.
- Text extraction parses bytes, never trusts extensions; binaries are handed to the agent by path only.

## License

MIT
