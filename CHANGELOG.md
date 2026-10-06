# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.4] - 2026-10-06

### Added

- **DeepSeek official vision in the discovery chain**: the image-description
  chain now auto-detects the official `deepseek-v4-flash-vision-exp`
  multimodal API (https://api-docs.deepseek.com/guides/vision/) using the
  `DEEPSEEK_API_KEY` already present in the dsh credentials — zero extra
  setup for DeepSeek users, and verified against a live screenshot (quality
  far above OCR). Chain order: explicit `visionEndpoint` → local Ollama →
  DeepSeek official vision → OpenAI standard.

### Fixed

- **Codex-style references everywhere**: every upload — images included — now
  inserts a clean `@relative/path` reference (relative to the session
  workspace). Absolute host paths no longer leak into the composer or the
  message; the removal card still deletes via the absolute path internally.
- **`read_document` made a fully-read document look truncated**: the line count
  came from `markdown.split('\n')`, which leaves a phantom empty element for the
  trailing newline almost every file ends with. A five-line file was reported as
  six, so a caller that had already read every line was told there was another
  page, paged again, and received an empty line — one wasted tool call and one
  wasted cache round per read. One trailing empty element is now dropped, which
  also keeps a file that genuinely ends in a blank line reported correctly.
- **`read_document` output now answers "is there more?" and labels its source**:
  the rendered envelope ends with a footer in the shipped `read` tool's idiom —
  `(End of file - total N lines)` or
  `(Showing lines X-Y of N lines. Use offset=Z to continue.)` — inside a
  `<content>` wrapper, instead of a bare `offset N, M/T lines` header that could
  not distinguish a truncated read from a complete one. The same wrapper states
  that the block is untrusted file content to be treated as data and never as
  instructions. An uploaded PDF or DOCX may have been authored by someone other
  than the user, and this is the only place that tells the model so; the system
  prompt now says the same thing. (Verification note: HTML comments and hidden
  elements are already stripped by the conversion engine, so the markup channel
  was never a live injection path here — this closes the gap where a *visible*
  instruction in a third-party document arrived with no signal that it was data.)
- **`ParseCache` was unimportable from a test**: it used TypeScript constructor
  parameter properties, which Node's `--experimental-strip-types` cannot erase,
  so `pnpm test` could not load `src/tool.ts` at all — which is why the module
  that renders everything the model reads had no tests. Rewritten as explicit
  fields, and `test/tool.test.ts` now covers the line counting and every footer
  case (10 tests).
- **Linting, formatting, and the dead code it found**: the project had no
  linter or formatter at all (`no-linter` was one of three standing structure
  warnings). `biome.json` configures both to match the style the code already
  uses — 2-space indent, single quotes, no semicolons — with
  `noControlCharactersInRegex` off, because the binary magic-number tables in
  `detect.ts` and the filename sanitizers legitimately match control
  characters, and `noExplicitAny` off for the same reason. `pnpm lint` and
  `pnpm format` wrap it, and `@biomejs/biome` is the only new devDependency
  (zero transitive dependencies).
- **Dead code the new linter exposed**: `detect.ts` carried a 55-entry
  `TEXT_EXTS` set that nothing read (so file extensions never influenced text
  detection, as documented), two `ZIP_HEAD` duplicates declared but unused, and
  an unused `UTF8_BOM` — the BOM check uses `fatal` UTF-8 decoding instead.
  `upload.ts` imported `decodeText` without calling it. `index.ts` typed an
  unused callback parameter, and two test files carried unused imports and an
  unused local. All removed; none changed behaviour (43 tests still pass).


  workspace). Absolute host paths no longer leak into the composer or the
  message; the removal card still deletes via the absolute path internally.
- **No more fallback text**: the old "图片以文件形式上传(<绝对路径>);未生成讲解…"
  text block is gone. An image with no available vision endpoint uploads as a
  plain `@reference` only (the agent can still OCR via `read_document`).
- **Image content support**: text-only routes insert
  `[图片: name] 图片讲解: <description>` before the reference **only when** a
  vision description was actually generated; multimodal routes and any
  registered `read_image` tool (official or a vision bridge) are detected at
  upload time and keep the pure-reference path.
- **`read_image` tool detection added** to the image-mode gate: a registered
  `read_image` tool (e.g. from a vision bridge) now counts as native image
  support, not just the routed model's `inputModalities`.
- Docs (README/README.zh) updated to describe the reference-first behavior
  and the official DeepSeek vision model.
- **Installation blocked by a stale peer range**: the DSH peers were pinned at
  `^0.1.0-rc.6` while the shipped runtime is `0.2.0-rc.2`, so
  `dsh plugin … add dsh-file-upload` refused with
  `installation rejected: Plugin dsh-file-upload@0.5.3 is incompatible with
  dsh 0.2.0-rc.2` before pnpm ever ran and nothing was downloaded. Ranges are
  now `>=0.1.0-rc.6 <0.3.0` for `@deepseek-ai/dsh-fs`, `-tools` and
  `-credentials`, and `>=3.18.1` for `@deepseek-ai/schemastery`. The APIs this
  plugin calls (`fs.resolve` / `fs.stat` / `fs.readBytes`, `FsTarget`,
  `FsVersion`, the `FsInfo` shape) are unchanged across that window, checked
  against the `0.2.0-rc.2` runtime; installation was then exercised end to end
  and the composed row read back with `--dump-config`.
- **Row id collided with a shipped row**: the bundle inserted its row as
  `id: file-upload`, the id `@deepseek-ai/dsh-web-app` already uses for the
  shipped browser upload transport
  (`@deepseek-ai/dsh-client-file-upload`, providing `ctx.fileUpload`). Two rows
  under one id make every id-targeted override ambiguous — the
  `plugins.row.config` key, `plugin_manager`'s enable/disable writer, and a
  user's own override layer would each address both rows at once. The id is now
  `dsh-file-upload`, which also makes `cordis.patch.yml` honour its own stated
  rule that the row id match the node half's exported cordis `name`. README,
  README.zh and `examples/local-override.yml` were updated to match; the
  example also dropped the `inlineTextLimit` / `previewTextLimit` keys removed
  back in 0.5.3 and gained the vision keys it had been missing.
- **`INSTALL.md` added**: the verified install paths (registry and local
  `link:`), what the manager writes to the profile manifest, a no-boot
  verification recipe using `--dump-config`, and troubleshooting for an
  incompatible-peer refusal or an unreachable registry.
- **`dsh.client.inject` named a package that does not exist**: the client
  declaration injected `@deepseek-ai/dsh-client-runtime`, which is absent from
  the shipped runtime, while the browser half actually imports
  `@deepseek-ai/dsh-client-ui-primitives` and registers slots on
  `conversation.input.left` / `conversation.input.dock`, an `@` source through
  `inputTriggers`, and reads the `conversation` state. The declaration now lists
  the real packages (`dsh-client-ui-conversation`, `dsh-client-ui-input-trigger`,
  `dsh-client-ui-primitives`), matching the official pattern where a UI plugin
  injects the primitives rather than the React runtime. The miss was silent
  rather than fatal — the browser loader ignores an inject name it cannot find —
  but it produced no ordering edge and no row retention for the packages the
  client actually needs. `dsh.manifestVersion: 1` is now declared too.
- **Upload progress and cancellation**: the client now posts through
  `XMLHttpRequest` instead of `fetch` — the only way to observe
  `upload.onprogress` in a browser — so a card appears the moment an upload
  starts and fills in live (`progress` 0..1, percentage in the card). The
  card's × now aborts an in-flight request (leaving the session does too)
  instead of letting it run to completion, and a cancelled upload is dropped
  silently: no error banner, and no `@reference` — a reference is still
  inserted **only** after a 2xx response, never on cancel or failure. A failed
  upload keeps its card marked `上传失败` with the error in the banner.
- **Orphan files after a client disconnect**: `handlePost` now notices the
  browser going away (`close` before the response is finished, or a destroyed
  response) and skips the disk write entirely — or removes the file it just
  wrote — instead of leaving an unreferenced file behind until the TTL sweep.
  This also covers a cancel during the image-explanation call, which runs
  outside the concurrency gate and can take up to a minute. Response codes
  (403/413/415/429/400/500) and their messages are unchanged, the concurrency
  slot is still released on every path, and a deduplicated file that already
  backs an earlier successful upload is never deleted.
- **The upload error banner never showed its text**: `subscribeErrors`
  notified listeners with no argument, so the dock stored `undefined` and the
  banner then read `.text` off it, throwing during render. Listeners now
  receive the current error.
- **The paperclip and both remove buttons rendered nothing**: the client
  imported `IconPaperclipOutline16` and `IconCloseOutline16`, names the
  primitives package does not export. The runtime ships size-graded families
  (`…Regular` ≈16px, `…Medium` ≈20px), so both imports resolved to `undefined`
  and React rendered empty buttons with no error anywhere. They are now
  `IconPaperclipOutlineRegular` / `IconCloseOutlineRegular`, matching how the
  official client plugins use them. The same pass dropped a `side` prop that
  `Tooltip` does not accept.
- **`pnpm typecheck` never checked the browser half**: `tsconfig.json` included
  only `**/*.ts`, while the client is `.tsx`, so `src/client/**` — the largest
  file in the repository — had never been in the program. All three defects
  above are what turning that check on surfaced. It now includes `src/**/*.tsx`
  with `jsx` and the DOM libs. Enabling it first required declaring the one
  external dependency the browser half has: `src/client/primitives.d.ts`, a
  deliberately minimal stub, because the primitives ship inside the DSH runtime
  and publish no `.d.ts` of their own. The single merged config means the host
  half now also sees DOM libs; that is the accepted trade for not maintaining a
  second tsconfig, and a host file reaching for a DOM global is a bug the
  runtime tests already catch.

## [0.5.3] - 2026-08-21

### Removed

- **Dead config** `inlineTextLimit` / `previewTextLimit`: the 0.5.0 redesign
  (Codex-style path references only, no text inlining) left these options
  wired through schema, validation, and handler options but never used.
  Removed from config surface, upload handler, tests, and docs.
- **Stale artifact** `lib/asr.js`: leftover from the 0.4.x voice/ASR pipeline,
  no longer built from source and referenced nowhere; dropped from the package.

### Fixed

- **README/README.zh usage steps contradicted the 0.5 behavior** — "small text
  files land directly in the composer" was a 0.4.x leftover; now documents the
  actual behavior (attachment card + `@relative/path` reference, raw content
  never dumped into the chat).
- **Client stylesheet now lives in the plugin fiber**: injected via
  `ctx.effect` and removed when the client half stops or updates, instead of a
  one-way `<style>` tag.

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
