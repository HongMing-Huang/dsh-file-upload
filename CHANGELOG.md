# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/HongMing-Huang/dsh-file-upload/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/HongMing-Huang/dsh-file-upload/releases/tag/v0.3.0
[0.2.0]: https://github.com/HongMing-Huang/dsh-file-upload/releases/tag/v0.2.0
[0.1.0]: https://github.com/HongMing-Huang/dsh-file-upload/releases/tag/v0.1.0
