# supply-chain — the golden, runnable supply-chain example

This is the example [#630](https://github.com/INTENTIUS/chant/issues/630) exists
to add: a complete, clone-and-run chant project that produces a real SBOM and a
real config-BOM with **no external tool installed** — no `syft`, no `cosign`, no
Docker, no network call once `npm install` has run. It also shows the
tool-gated `sign`/`verify`/`vuln-gate` steps, clearly marked, for when you do
have `cosign`/`syft`/`grype` on `PATH`.

See [Supply-Chain Attestations](https://intentius.io/chant/components/supply-chain/)
for the full capability reference this example is the runnable counterpart to.

## What's here

| File | What it's for |
|---|---|
| `package.json` | the example's own npm project — `npm install` gets you `is-odd`/`left-pad` (real runtime deps to enumerate) plus `@intentius/chant` |
| `package-lock.json` | a **real** npm lockfile (not hand-written) — this is what `generate-sbom` scans |
| `supply-chain-demo.component.ts` | the component: `generate-sbom` (dir scan) → `extract-config-bom`, plus a second, tool-gated component with `sign`/`attest-provenance`/`verify`/`vuln-gate` |
| `chant.config.ts` | project-wide `sbom`/`signing`/`vulnPolicy` defaults, read by `chant run --components` since [#629](https://github.com/INTENTIUS/chant/issues/629) |

## Run it (hermetic — no tools needed)

```bash
npm install
npm run supply-chain
```

That's `chant run --components supply-chain-demo --env local` under the hood.
It runs two phases:

1. **`Sbom`** — `generate-sbom` with `artifactType: "dir"` scans this
   directory's `package-lock.json` via the hermetic
   `lockfileSbomGenerator` (packages/core/src/components/verbs/
   lockfile-sbom-generator.ts) — now `generate-sbom`'s *default* backend for
   `dir`/`zip`/`jar` artifacts (#630). No `syft`, no network: it's a pure
   `package-lock.json` parse. Writes `sbom.spdx.json` to this directory.
2. **`ConfigBom`** — `extract-config-bom` walks a small literal synthesized
   template (a stand-in for what `chant build` would normally produce) and
   emits a second BOM describing the declared infra resources. Writes
   `config-bom.spdx.json`.

Both are real SPDX 2.3 JSON documents — inspect them after running:

```bash
cat sbom.spdx.json | head -20
cat config-bom.spdx.json | head -20
```

`sbom.spdx.json`/`config-bom.spdx.json` are generated files (gitignored) —
delete them and re-run any time; the output is deterministic for identical
inputs (content-addressed, see `../../packages/core/src/components/verbs/
build-archive.ts`'s `contentDigest`).

## Run the tool-gated steps (needs cosign / syft / grype)

`supply-chain-demo-signed` (same file) layers `sign` → `attest-provenance` →
`verify` → `vuln-gate` on top of the same two hermetic BOM steps. Every one of
those four steps needs a real tool on `PATH`:

- `sign` / `attest-provenance` / `verify` → [cosign](https://docs.sigstore.dev/cosign/system_config/installation)
- `scan-vulnerabilities` (which `vuln-gate` scans through) → [syft](https://github.com/anchore/syft) + [grype](https://github.com/anchore/grype)

```bash
npm run supply-chain:full
```

Without those tools installed this fails with a `ToolNotAvailableError` naming
exactly what's missing — never a silent skip or a fake pass. That's why it's a
separate component (`supply-chain-demo-signed`), not appended to the hermetic
one: your first `npm run supply-chain` should never fail on a tool you didn't
ask to use.

`imageRef` in the signed component is a placeholder digest — there's no real
built image in this hermetic example. Swap in a real `"@Publish.uri"` from a
`docker-build` → `publish-image` composition (see the docs page's "First-signing
walkthrough") once you have an artifact to actually sign.

## `chant.config.ts` — project-wide defaults, actually read

Since [#629](https://github.com/INTENTIUS/chant/issues/629), `chant run
--components` resolves `chant.config.ts`'s `sbom`/`signing`/`vulnPolicy`
sections and fills them into any step that didn't already set the field
itself — a component author no longer hand-codes `format`/`oidcIssuer`/
`policy` into every step when the project already declares a default. This
example's `chant.config.ts` sets all three sections; `supply-chain-demo-signed`'s
`verify`/`vuln-gate` steps deliberately leave `policy: {}` to demonstrate the
config fill-in (open `chant.config.ts` and compare against what the run
produces with `--json`).

## Files this run produces (gitignored)

- `sbom.spdx.json` — the software SBOM, from `generate-sbom`
- `config-bom.spdx.json` — the config-BOM, from `extract-config-bom`

Both are safe to delete and regenerate.
