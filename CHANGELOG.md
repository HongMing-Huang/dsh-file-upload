# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.2] - 2026-08-19

### Added

- **Image explanations ("讲解图片")** for text-only routes: upload an image
  and the plugin automatically generates a description through a vision
  discovery chain — ① explicit `visionEndpoint`/`visionModel`, ② local
  Ollama auto-detected (picks a VL model such as DeepSeek-VL2, images stay
  local), ③ OpenAI standard endpoint with a key from the dsh credentials
  seam. The description travels with the message so the text-only DeepSeek
  API can reason about the image.
- Docs clarify that DeepSeek's official API has no vision input; the
  open-source DeepSeek-VL2 line is the "official vision" via local
  deployment (Ollama).
- New config: `visionEndpoint`, `visionModel`, `visionApiKeyEnv`,
  `visionMaxBytes`.

## [0.5.0] - 2026-08-19

### Changed

- **Codex-style file presentation**: uploaded files are referenced as
  `@relative/path` mentions — the raw file content is never dumped into the
  composer (removed text inlining).
- **Voice input removed** (mic button, Web Speech API, MediaRecorder
  fallback and the ASR transcription pipeline were unreliable in practice).
  Audio files still upload as ordinary attachments.
- **Mature image handling**: multimodal routes use the official `read_image`
  tool; text-only routes get an automatic **vision description** through an
  OpenAI-compatible endpoint (`gpt-4o-mini` default) with the key resolved
  from the dsh credentials seam — no OCR-quality issues.
- New config: `visionEndpoint`, `visionModel`, `visionApiKeyEnv`,
  `visionMaxBytes`; removed `asr*` / `maxRecordSec`.

## [0.4.3] - 2026-08-18

### Added

- **Codex-style `@` file mentions**: after upload, type `@` in the composer
  to pick any uploaded file by its relative path; the reference inserts as a
  mention (official `ReferenceInsert` outcome) and the agent reads it with
  `read_document`. Message history shows `@relative/path` text — same model
  as OpenAI Codex, no attachment cards.
- **Relative paths in upload responses** (`relativePath`, relative to the
  session workspace) used for `@` mentions and clipboard text.

### Fixed

- **TTL sweep now covers session workspaces**: the sweeper scans every live
  session's `.dsh-uploads` via `ctx.sessions.list()` (files previously never
  aged out outside the fallback dir).
- **Client attachment state is per-session** — no cross-session card leakage.
- **Image thumbnails** in the composer dock.
- **ftyp audio sniffing gated on media extensions** — plain text can no
  longer be misclassified as audio.

## [0.4.2] - 2026-08-16

### Added

- **Codex-style `@` mentions**: after upload, type `@` in the composer to
  pick any uploaded file by relative path; references insert as mentions and
  the agent reads them with `read_document` (message history shows the
  `@relative/path` text — same model as Codex, no attachment cards).
- **Relative paths**: the upload response carries the file's path relative to
  the session workspace, used for `@` mentions and clipboard text.
- **Image handling auto-adapts to the routed model**: at upload time the
  plugin resolves the session's provider/model through
  `ctx.llm.resolveModelInfo` and checks `inputModalities` — mirroring the
  official `read_image` route gate. Multimodal routes get `imageMode: native`
  (the message tells the agent to use the official `read_image` tool; the
  image enters model context directly); text-only or unknown routes get
  `imageMode: ocr` (the agent reads via `read_document`, bundled OCR).
- systemPrompt updated to describe both paths precisely.

### Changed

- ASR key resolved through the dsh credentials seam (`ctx.credentials.resolve`
  per upload: inherited env → `$DSH_HOME/.credentials.yaml` → project .env),
  so a Models-page key just works and hot-updates without restart. Standard
  OpenAI endpoint by default; `asrEndpoint` overrides.
- `@deepseek-ai/dsh-credentials` peer dependency; ASR integration tests.

### Changed

- **ASR key comes from the dsh credentials seam, not the plugin's own env
  requirement**: `ctx.credentials.resolve` (inherited env → `$DSH_HOME/
  .credentials.yaml` → project `.env`) resolves the ASR key **per upload**,
  so a key configured in the Models page just works and a changed key
  reaches the next upload without a restart. The standard OpenAI endpoint is
  used by default; `asrEndpoint` overrides it.
- `@deepseek-ai/dsh-credentials` added to peerDependencies.
- ASR integration tests (multipart request against a mock endpoint, auth
  header assertion, connection-failure rejection).

## [0.4.1] - 2026-08-16

### Changed

- **Zero-config ASR auto-detection**: when `asrEndpoint` is empty and the
  `asrApiKeyEnv` credential (default `OPENAI_API_KEY`) is present, the
  standard OpenAI endpoint (`https://api.openai.com/v1/audio/transcriptions`)
  activates automatically — audio-file transcription now works with no
  configuration at all.
- Startup logs report the resolved audio mode (auto-enabled endpoint or
  browser-only voice input).
- README (en/zh) states the zero-config promise: every feature works out of
  the box; all config fields have sensible defaults.

## [0.4.0] - 2026-08-15

### Added

- **Voice input**: mic button in the composer — Web Speech API live dictation
  inserts editable text into the composer; falls back to MediaRecorder audio
  upload when speech recognition is unavailable.
- **Audio sniffing**: WAV / MP3 / FLAC / OGG / M4A / WebM containers are
  recognized (`audio` sniffed type).
- **Audio file transcription**: when `asrEndpoint` (OpenAI-compatible
  `/audio/transcriptions`) is configured, uploaded audio is transcribed
  automatically and the transcript travels with the message; degrades to a
  plain file attachment on failure or when disabled.
- New config: `maxRecordSec`, `asrEndpoint`, `asrApiKeyEnv`, `asrModel`,
  `asrMaxBytes`.

### Changed

- README.md fully rewritten in English (previously contained Chinese
  leftovers); README.zh.md rewritten to match — no duplicated entries, all
  sections (features / usage / config / architecture / security) accurate.

## [0.3.0] - 2026-08-15

### Changed

- **Fully bundled MarkItDown, no downloads, no Python**: the auto-install
  (postinstall/venv/pip) design is removed. The markitdown-node engine
  (Microsoft MarkItDown TypeScript port, 20+ formats, image OCR, audio
  transcription via LLM) is the always-available backend, shipped as a
  regular dependency. An official MarkItDown CLI already present on the
  machine (config or PATH) is still detected and preferred when available.
- README (en/zh) rewritten around the bundled design.

## [0.2.0] - 2026-08-15

### Added

- **MarkItDown CLI is now bundled**: the official Microsoft MarkItDown CLI is
  auto-installed into an isolated venv (`$DSH_HOME/markitdown/venv`) by a
  `postinstall` script when Python >= 3.10 is present — no manual pip steps.
- Startup auto-discovery chain: explicit `markitdownBin` → PATH →
  auto-installed CLI (marker-based) → lazy one-time auto-install.
- `pnpm setup-markitdown` for manual reinstall/upgrade.
- Graceful degradation: no Python / failed install / blocked postinstall
  falls back to the bundled markitdown-node engine (20+ formats), so
  document → Markdown always works.

### Fixed

- Installer verifies the CLI via `--version` (first-run `--help` imports the
  full converter registry and could exceed the probe timeout).

## [0.1.0] - 2026-08-15

### Added

- Claude-desktop-style file upload: composer paperclip button and global
  drag-and-drop overlay ("release to attach"), multi-file support.
- Content sniffing that never trusts file extensions:
  text / PDF / DOCX / XLSX / image / archive / binary.
- Small text files (code, JSON, CSV, logs, config) are inlined straight into
  the composer via the official `slash/input-insert-text` event; larger text
  files insert a path reference with a preview.
- Document → Markdown conversion with two backends:
  - built-in JS parsers (text / PDF / DOCX / XLSX) with zero external tooling;
  - optional Microsoft MarkItDown CLI (auto-detected on PATH or configured),
    covering PPTX, HTML, EPUB, image OCR and audio transcription.
- `read_document` tool for the agent: line-numbered paging (offset/limit),
  reads through `ctx.fs` (inherits sandbox and fs-observation policy),
  byte-budgeted LRU conversion cache invalidated on file changes,
  size pre-checks.
- Security: loopback-only uploads, sanitized file names, session-isolated
  storage (`.dsh-uploads/<sessionId>`), sha256 content dedup, bounded
  concurrency, TTL sweep.
- Image guidance in the injected systemPrompt: official `read_image` first,
  MarkItDown OCR second, path reference as fallback.
- 26 tests: unit (sniffing, sanitization, encoding), integration against a
  real MarkItDown CLI, and HTTP handler tests (inline / 403 / 413 / DELETE).

### Fixed

- MarkItDown auto-detection now reaches `read_document` through a shared
  mutable tool config (no restart needed when found on PATH).
- GB18030-encoded files inline with correct decoding via TextDecoder.

[Unreleased]: https://github.com/HongMing-Huang/dsh-file-upload/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/HongMing-Huang/dsh-file-upload/releases/tag/v0.5.2
[0.5.0]: https://github.com/HongMing-Huang/dsh-file-upload/releases/tag/v0.5.0
[0.4.3]: https://github.com/HongMing-Huang/dsh-file-upload/releases/tag/v0.4.3
[0.4.2]: https://github.com/HongMing-Huang/dsh-file-upload/releases/tag/v0.4.2
[0.4.1]: https://github.com/HongMing-Huang/dsh-file-upload/releases/tag/v0.4.1
[0.4.0]: https://github.com/HongMing-Huang/dsh-file-upload/releases/tag/v0.4.0
[0.3.0]: https://github.com/HongMing-Huang/dsh-file-upload/releases/tag/v0.3.0
[0.2.0]: https://github.com/HongMing-Huang/dsh-file-upload/releases/tag/v0.2.0
[0.1.0]: https://github.com/HongMing-Huang/dsh-file-upload/releases/tag/v0.1.0
