# Installing dsh-file-upload

Two ways in: the published package from a registry, or this working copy as a
local link. Both end with the same thing — the package added to the profile's
dependencies and selected in `dsh.profile.bundles`, so its `cordis.patch.yml`
becomes one patch layer of the profile.

## 1. From a registry (normal users)

```sh
dsh plugin --profile desktop add dsh-file-upload
# then restart the app so the new layer is composed
```

`<profile>` is the profile you boot (`desktop` for the DeepSeek Harness
desktop app, `web` for `dsh web`, `tui`, …).

The `dsh plugin …` command is a thin wrapper that runs pnpm inside
`$DSH_HOME/profiles/<profile>`, so it inherits that profile's registry,
proxy and auth configuration. Anything pnpm accepts works:

```sh
dsh plugin --profile desktop add dsh-file-upload@0.5.3
dsh plugin --profile desktop add github:HongMing-Huang/dsh-file-upload
dsh plugin --profile desktop remove dsh-file-upload
```

Prefer the Web UI's **Plugins** page or the `plugin_manager` tool when you want
the same operations with validation, install logs, progress and cancellation —
they call the same service and additionally check the repository, the peer
ranges and the build-script approvals before pnpm runs.

## 2. From this working copy (development)

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-file-upload
```

pnpm records a `link:` dependency, so the profile runs the files in this
checkout. **Run `pnpm build` first** — the profile loads `lib/`, not `src/`.

## What gets written

`$DSH_HOME/profiles/<profile>/package.json`:

```json
{
  "dependencies": { "dsh-file-upload": "link:/absolute/path/to/dsh-file-upload" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-file-upload"] } }
}
```

A bundle at the **end** of `bundles` wins configuration precedence, which is
why a freshly enabled bundle changes the composed tree even when nothing else
did. Disabling keeps the dependency and drops the selection; removing does both.

## Verify the install without booting the app

Compose the profile tree and read it back — no server, no browser:

```sh
dsh --profile <profile> --dump-config | grep -A6 dsh-file-upload
```

You should see the row and its config:

```yaml
# == dsh-file-upload
- id: dsh-file-upload
  name: dsh-file-upload
  config:
    uploadMaxBytes: 26214400
    ...
```

To rehearse an install without touching your real profile, point `DSH_HOME` at
a scratch directory and create a throwaway profile in it:

```sh
export DSH_HOME=/tmp/dsh-scratch
mkdir -p "$DSH_HOME/profiles/scratch"
printf '%s\n' '{"name":"dsh-profile-scratch","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}' > "$DSH_HOME/profiles/scratch/package.json"
printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$DSH_HOME/profiles/scratch/pnpm-workspace.yaml"
printf '[]\n' > "$DSH_HOME/profiles/scratch/cordis.yml"
dsh plugin --profile scratch add /absolute/path/to/dsh-file-upload
dsh --profile scratch --dump-config | grep -A6 dsh-file-upload
```

## Troubleshooting

### `installation rejected: Plugin … is incompatible with dsh …`

The plugin declares peer ranges against the DSH runtime packages
(`@deepseek-ai/dsh-fs`, `-tools`, `-credentials`). When the runtime is outside
those ranges the manager refuses **before** pnpm runs, so nothing is downloaded
and no build script executes.

Check what you actually have:

```sh
dsh --version
```

This plugin accepts `>=0.1.0-rc.6 <0.3.0` (it is developed against
`0.2.0-rc.2`). If you are on a runtime outside that window, either update the
plugin, or accept the risk explicitly — exact version pair only:

```sh
dsh plugin --profile <profile> allow-version dsh-file-upload@0.5.3 \
  --dsh-version <runtime-version> --accept-risk
```

Treat an exemption as a stopgap and not a fix: it authorises code whose API
assumptions were never checked against that runtime.

### `ERR_PNPM_META_FETCH_FAIL` / registry unreachable

The profile's configured registry is down or blocked. Diagnose and override:

```sh
dsh plugin --profile <profile> config get registry
dsh plugin --profile <profile> add dsh-file-upload --registry https://registry.npmjs.org
```

Installing from a local path (section 2) does not consult any registry, so it
is the fastest way to tell a registry problem from a package problem.

Note that a local **path** install and a local **tarball** install are not the
same test: a path install records a `link:` and reuses the dependency tree it
already has, while a tarball install makes pnpm resolve the package's own
dependencies from a registry. If `add ./dsh-file-upload-0.5.4.tgz` fails with
`ERR_PNPM_META_FETCH_FAIL` while `add /path/to/repo` succeeds, the registry is
the problem — the tarball itself is fine.

#### …only under pnpm 11, and only if a `socks5h://` proxy is exported

DSH bundles its own pnpm (11.x) and runs it inside the profile. pnpm 10 and 11
do not read the proxy variables the same way, and pnpm 11 fails with a generic
`fetch failed` when a SOCKS proxy is exported in the lowercase variables while
an HTTP proxy is exported in the uppercase ones — a shape `all_proxy`-style
setups commonly produce:

```sh
HTTPS_PROXY=http://127.0.0.1:1082     # pnpm 11 can use this
https_proxy=socks5h://127.0.0.1:1082  # pnpm 11 cannot
```

Diagnose by comparing the two pnpm majors directly:

```sh
pnpm view dsh-file-upload version                      # pnpm 10 on PATH
npx --yes pnpm@11.7.0 view dsh-file-upload version     # what DSH bundles
```

If only the second one fails, export the HTTP form for the install and drop the
SOCKS ones:

```sh
env -u https_proxy -u all_proxy -u ALL_PROXY \
  HTTP_PROXY=http://127.0.0.1:1082 HTTPS_PROXY=http://127.0.0.1:1082 \
  dsh plugin --profile <profile> add dsh-file-upload
```

This is a property of the machine's proxy environment, not of the plugin.

### The upload button does not appear after installing

The Host half loads on boot; the **browser** half is a separately built bundle
(`lib/client.js`). Check, in order:

1. the app was restarted after the install;
2. `pnpm build` was run in the checkout, so `lib/client.js` exists and is newer
   than `src/client/index.tsx`;
3. `dsh --profile <profile> --dump-config` really contains the row.

### Row id

This plugin's row id is **`dsh-file-upload`** (the package name), matching the
node half's exported cordis `name`. It is deliberately *not* the generic
`file-upload`: `@deepseek-ai/dsh-web-app` already ships a row with that id for
the browser upload transport (`@deepseek-ai/dsh-client-file-upload`, which
provides `ctx.fileUpload`). Two rows sharing one id would make every
id-targeted override — your own override layer included — address both at once.

## Peers DSH supplies

Nothing in `peerDependencies` has to be installed by hand: `dsh-base` /
`dsh-web-app` already mount `fs`, `tools`, `credentials`, `sessions`,
`systemPrompt` and `webServer`. `react` comes from the client runtime.
