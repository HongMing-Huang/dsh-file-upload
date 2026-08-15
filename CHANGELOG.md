# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/HongMing-Huang/dsh-file-upload/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/HongMing-Huang/dsh-file-upload/releases/tag/v0.1.0
