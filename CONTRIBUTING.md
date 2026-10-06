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

## Releasing

Ordered so a mistake is caught before it reaches the registry. All commands run
from the repository root.

**1. Know what you are about to publish.**

```sh
git status --short                  # must be clean
node -e "console.log(require('./package.json').version)"
npm view dsh-file-upload version    # what users get today
```

If the local version is not ahead of the published one, there is nothing to
release.

**2. Run the gate.**

```sh
node .dsh/structure-guard/scripts/guard.mjs verify .
```

`verify` = structure audit + typecheck + test + build, and must print
`verify: ok`. `0 error` is the blocking part; the remaining `warn`s are tracked
in `ARCHITECTURE.md` and do not block.

**3. Inspect the artifact, not the source tree.**

`prepublishOnly` runs `npm run build && npm test` on publish, but packing first
shows exactly what will be uploaded:

```sh
rm -rf /tmp/pack-check && mkdir -p /tmp/pack-check
pnpm pack --pack-destination /tmp/pack-check
tar -tzf /tmp/pack-check/dsh-file-upload-*.tgz | sort
```

Expect `cordis.patch.yml`, the docs, `lib/index.js` (host half),
`lib/client.js` (browser half), `lib/*.d.ts` and `package.json`. **A missing
`lib/client.js` ships a broken browser half while the Host half still installs**
— the failure mode is a plugin that loads with no UI.

Then check the manifest fields that decide whether the package is usable:

```sh
tar -xzOf /tmp/pack-check/dsh-file-upload-*.tgz package/package.json \
  | node -e "const p=JSON.parse(require('fs').readFileSync(0));console.log(p.version, JSON.stringify(p.dsh), JSON.stringify(p.peerDependencies), p.types)"
```

- `dsh.bundle.patch` must point at a file actually present in the tarball.
- `dsh.client.platform` must be `web`, and every name in `dsh.client.inject`
  must exist in the runtime.
- the peer ranges must admit the DSH runtime you target — this is the field that
  silently blocks every install when it drifts.

**4. Prove an install before publishing.** Rehearse in a throwaway `DSH_HOME`
so your real profile is untouched:

```sh
export DSH_HOME=/tmp/dsh-release-check
rm -rf "$DSH_HOME" && mkdir -p "$DSH_HOME/profiles/scratch"
printf '%s\n' '{"name":"dsh-profile-scratch","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}' > "$DSH_HOME/profiles/scratch/package.json"
printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$DSH_HOME/profiles/scratch/pnpm-workspace.yaml"
printf '[]\n' > "$DSH_HOME/profiles/scratch/cordis.yml"

dsh plugin --profile scratch add "$PWD"
dsh --profile scratch --dump-config | grep -A6 'id: dsh-file-upload'
rm -rf "$DSH_HOME"
```

Expect `exit 0`, the package selected in `dsh.profile.bundles`, and the row with
its config in the composed tree. An `incompatible with dsh …` refusal means the
peer range is wrong — fix it rather than shipping, and do not paper over it with
a version exemption.

**5. Publish and verify.**

```sh
npm publish                  # prepublishOnly builds + tests
npm view dsh-file-upload version dist-tags peerDependencies
cd /tmp && rm -rf verify-pub && mkdir verify-pub && cd verify-pub
npm pack dsh-file-upload@<version> && tar -tzf *.tgz | sort
git tag -a v<version> -m "v<version>" && git push origin v<version>
```

### Field notes

- **Peer ranges are the sharp edge.** `^0.1.0-rc.6` never matches `0.2.x`, and
  npm's prerelease rules make that easy to miss. When DSH moves, re-check the
  ranges and confirm the APIs called here still exist before widening them.
- **A row id is a namespace.** The bundle row id must stay unique across every
  layer of a composed profile; `file-upload` already belongs to a shipped row.
- **The two halves fail differently.** The Host half loads on boot and says so;
  the browser half is a separate bundle that can be missing or mis-declared
  while the install still reports success.
