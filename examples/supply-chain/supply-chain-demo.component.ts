/**
 * The golden, runnable supply-chain example (#630).
 *
 * `chant run --components` discovers any exported `Component`-shaped value
 * from a `*.component.ts` file (packages/core/src/components/discover.ts) —
 * this file exports two:
 *
 *  - `supplyChainDemo` ("supply-chain-demo"): everything below runs with
 *    NO external tool installed. `generate-sbom` (artifactType: "dir") scans
 *    this directory's own `package-lock.json` via the hermetic
 *    `lockfileSbomGenerator` (packages/core/src/components/verbs/
 *    lockfile-sbom-generator.ts), now the `generate-sbom` capability's
 *    *default* backend (#630 — see packages/core/src/components/verbs/
 *    sbom-generator.ts's `defaultSbomGenerator`). `extract-config-bom` then
 *    derives a second BOM from a synthesized IaC template's declared
 *    resources — a pure structural walk, also tool-free. This is the
 *    "clone and run it" proof: `npm install && npm run supply-chain`.
 *
 *  - `supplyChainDemoSigned` ("supply-chain-demo-signed"): the same two BOM
 *    steps, PLUS `sign` / `attest-provenance` / `verify` / `vuln-gate` —
 *    every one of those needs a real tool on PATH (cosign for
 *    sign/attest-provenance/verify, syft/grype for a real
 *    scan-vulnerabilities backend) and is clearly marked below. Composed as
 *    a separate component (not appended to `supply-chain-demo`) so the
 *    hermetic path never accidentally depends on a tool being present —
 *    "skips cleanly" here is "run a different component," not a flag.
 *
 * See examples/supply-chain/README.md for the walkthrough and
 * docs/components/supply-chain.mdx for the full capability reference.
 */

import { phase, type Component } from "@intentius/chant/components/component";

// ── a tiny synthesized "template" this component's config-BOM describes ────
//
// A real component's build phase would get this from chant's own synthesis
// step (chant build, see packages/core/src/build.ts) — a CloudFormation/K8s/
// etc. JSON document already on disk. This example hand-writes one literal
// document so `extract-config-bom` has real `Resources` to walk without
// requiring an actual cloud lexicon/build step, keeping the whole example
// hermetic and dependency-free. `inventoryTemplate` (packages/core/src/
// components/verbs/config-bom.ts) only cares about the `{ Resources: {
// name: { Type, Properties } } }` shape — the same shape every lexicon
// serializer's `SerializerResult.primary` already produces.
const SYNTHESIZED_TEMPLATE = JSON.stringify({
  Resources: {
    DemoBucket: { Type: "AWS::S3::Bucket", Properties: { BucketName: "supply-chain-demo" } },
    DemoQueue: { Type: "AWS::SQS::Queue", Properties: { QueueName: "supply-chain-demo-events" } },
  },
});

/**
 * "supply-chain-demo" — hermetic, tool-free. Composes:
 *   1. `generate-sbom` (artifactType: "dir") over this directory, scanning
 *      `package-lock.json` (checked into this example — real npm-resolved
 *      deps: is-odd, left-pad, is-number) via the now-default
 *      `lockfileSbomGenerator`. Produces a real SPDX document.
 *   2. `extract-config-bom` over the literal synthesized template above.
 *      Produces a second SPDX document describing declared infra resources.
 *
 * Run: `npm run supply-chain` (== `chant run --components supply-chain-demo
 * --env local`), from inside this directory, with NOTHING besides `npm
 * install` — no cosign, no syft, no Docker, no network call once installed.
 */
export const supplyChainDemo: Component = {
  name: "supply-chain-demo",
  archetype: "producer-library",
  dependsOn: [],
  deploy: [
    phase("Sbom", [
      {
        kind: "generate-sbom",
        artifactType: "dir",
        // The directory to scan for a package-lock.json/pom.xml — this
        // example's own project root, where package-lock.json lives.
        path: ".",
        format: "spdx",
      },
    ]),
    phase("ConfigBom", [
      {
        kind: "extract-config-bom",
        path: "supply-chain-demo.template.json",
        content: SYNTHESIZED_TEMPLATE,
        format: "spdx",
        // Also write the config-BOM document to disk (mirroring
        // generate-sbom's forDir, which always writes sbom.<format>.json
        // alongside the scanned directory) — outDir "." here matches the
        // `path` field's default archive-write; omitted, extract-config-bom
        // is archive-only (see ./config-bom.ts's ExtractConfigBomInput doc).
        outDir: ".",
      },
    ]),
  ],
};

/**
 * "supply-chain-demo-signed" — the same two hermetic BOM steps, plus the
 * tool-gated supply-chain security stack: `sign` / `attest-provenance` /
 * `verify` / `vuln-gate`. Every step from "Sign" onward NEEDS A REAL TOOL ON
 * PATH:
 *
 *   - `sign` / `attest-provenance` / `verify` -> cosign, and throw the
 *     specific `ToolNotAvailableError` naming it when missing
 *     (https://docs.sigstore.dev/cosign/system_config/installation).
 *   - `vuln-gate` scans via the injectable `VulnScanner`
 *     (packages/core/src/components/verbs/vuln-scan.ts) — a real backend
 *     shells out to grype/trivy (`createToolVulnScanner`), but the
 *     `vuln-gate` capability `chant run --components` actually registers
 *     (starter-plugin.ts) still defaults to `notImplementedVulnScanner`, so
 *     this step throws `VulnScannerNotImplementedError` even with
 *     grype/syft on PATH — wiring the starter plugin's `vuln-gate` to a real
 *     scanner by default is a separate, not-yet-done follow-up (out of
 *     scope for #630, which only changes `generate-sbom`'s default). Kept
 *     in the composition anyway so the step SHAPE — sbom wiring, policy
 *     fill-in from chant.config.ts — is accurate and copy-pasteable; a
 *     project that wants this step to actually pass today must inject its
 *     own registry (see `RunComponentsOptions.registry`,
 *     packages/core/src/components/cli-support.ts) wired to
 *     `createVulnGateCapability(createToolVulnScanner())`.
 *
 * Run: `npm run supply-chain:full` once cosign is installed (vuln-gate will
 * still throw `VulnScannerNotImplementedError` — see above). This component
 * is NOT what `npm install && npm run supply-chain` exercises — that only
 * runs the hermetic `supply-chain-demo` above. Kept as a separate component
 * (rather than folded into one long composition) so a newcomer's first run
 * never fails on a step it never asked to use.
 *
 * `imageRef` below is a placeholder digest (no real image exists in this
 * hermetic example) — swap in a real `"@Publish.uri"` from a `docker-build`
 * -> `publish-image` composition (see docs/components/supply-chain.mdx's
 * "First-signing walkthrough") once you have an artifact to sign for real.
 */
const PLACEHOLDER_DIGEST = "example.registry/supply-chain-demo@sha256:0000000000000000000000000000000000000000000000000000000000000000";

export const supplyChainDemoSigned: Component = {
  name: "supply-chain-demo-signed",
  archetype: "producer-library",
  dependsOn: [],
  deploy: [
    phase("Sbom", [
      { kind: "generate-sbom", artifactType: "dir", path: ".", format: "spdx" },
    ]),
    phase("ConfigBom", [
      {
        kind: "extract-config-bom",
        path: "supply-chain-demo.template.json",
        content: SYNTHESIZED_TEMPLATE,
        format: "spdx",
      },
    ]),
    // ↓↓↓ needs cosign on PATH ↓↓↓
    phase("Sign", [
      { kind: "sign", imageRef: PLACEHOLDER_DIGEST }, // keyless — no key config needed, see chant.config.ts's `signing` block
    ]),
    phase("Attest", [
      {
        kind: "attest-provenance",
        imageRef: PLACEHOLDER_DIGEST,
        provenance: { sourceRef: "local-demo", artifactDigest: PLACEHOLDER_DIGEST },
        builderId: "https://github.com/actions/runner",
      },
    ]),
    // `verify` defaults `requireProvenance: true` (packages/core/src/
    // components/verbs/verify.ts) — it checks attest-provenance's SLSA
    // attestation as well as the signature, so `verify` alone requires BOTH
    // `sign` and `attest-provenance` to have already run against this digest.
    phase("Verify", [
      {
        kind: "verify",
        imageRef: PLACEHOLDER_DIGEST,
        // policy.expectedIssuer/expectedIdentity are filled from
        // chant.config.ts's `signing` block by #629's config-defaults pass
        // (packages/core/src/components/config-defaults.ts) when omitted here.
        policy: {},
      },
    ]),
    // ↓↓↓ needs syft + grype on PATH (scan-vulnerabilities' real backend) ↓↓↓
    phase("VulnGate", [
      {
        kind: "vuln-gate",
        // Wire the hermetic SBOM this same component already generated —
        // vuln-gate scans it via the injected VulnScanner (default: shells
        // out to grype) unless `findings` is supplied directly.
        sbom: "@Sbom.sbom",
        // policy is filled from chant.config.ts's `vulnPolicy` block by the
        // same #629 config-defaults pass when omitted here.
        policy: {},
      },
    ]),
  ],
};
