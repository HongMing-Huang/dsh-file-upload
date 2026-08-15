# Contributing

Thanks for your interest! PRs, issues and ideas are welcome.

## Development

```sh
pnpm install
pnpm typecheck   # strict TypeScript
pnpm build       # tsc (host) + esbuild (client bundle)
pnpm test        # node --test (unit + integration)
```

Requirements: Node.js ≥ 22.6 (native TypeScript type-stripping for tests).

## Integration tests

`test/integration.test.ts` exercises the MarkItDown CLI when one is
available. Tests skip gracefully when no CLI is found. To run them fully:

```sh
python3 -m venv .venv
.venv/bin/pip install 'markitdown[docx,pdf,xlsx,pptx]'
# the test picks up .venv/bin/markitdown automatically
```

## Project layout

```
src/
├── index.ts        # entry: apply + Config schema + assembly
├── detect.ts       # content sniffing (never trusts extensions)
├── convert.ts      # JS parsers + optional MarkItDown CLI backend
├── upload.ts       # upload route: loopback/session/size/dedup/TTL
├── tool.ts         # read_document: ctx.fs reads + paging + LRU cache
└── client/
    └── index.tsx   # paperclip button + drag overlay + attachment cards
```

## Design rules

- No official patches: extend through `ctx.webServer`, `ctx.tools`,
  `ctx.systemPrompt`, `ctx.sessions` and client slot events only.
- Never trust a file extension — sniff content bytes.
- Every tunable parameter must be a config field with a schema default.
- Keep the plugin dependency-light and offline-capable by default.
