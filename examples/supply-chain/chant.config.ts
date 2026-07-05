// Project-wide supply-chain defaults, read by `chant run --components`
// (#629's config-defaults pass, packages/core/src/components/config-defaults.ts)
// and filled into any `generate-sbom`/`sign`/`attest-provenance`/`verify`/
// `vuln-gate` step in supply-chain-demo.component.ts that doesn't already set
// the field itself. Nothing here is read by the hermetic
// `supply-chain-demo` component (generate-sbom/extract-config-bom take no
// signing/vuln config) — it's `supply-chain-demo-signed`'s sign/verify/
// vuln-gate steps that pick these up, once cosign/syft/grype are installed.
export default {
  // `extract-config-bom` parses a synthesized CloudFormation template, so it is
  // contributed by the aws lexicon (#684); loading it here lets the component's
  // ConfigBom phase resolve that verb. `generate-sbom`/`sign`/etc. are agnostic
  // and come from core.
  lexicons: ["aws"],
  sbom: {
    // Every generate-sbom step in this example composes its own format, but a
    // project can drop that per-step field entirely once this default is set.
    format: "spdx",
  },
  signing: {
    // Keyless is chant's default (no key to generate/rotate) — see
    // docs/components/supply-chain.mdx's "Why keyless signing". Both fields
    // below are required by `verify`'s IdentityPolicy; replace them with your
    // own CI's OIDC issuer + workflow ref before running `sign`/`verify` for
    // real. Left as example.com placeholders here because this project has no
    // real GitHub Actions workflow to name.
    oidcIssuer: "https://token.actions.githubusercontent.com",
    identity: "https://github.com/intentius-example/supply-chain/.github/workflows/release.yml@refs/heads/main",
  },
  vulnPolicy: {
    // Beginner-safe defaults (see resolveVulnPolicy in packages/core/src/config.ts):
    // block only critical + fixable + not-VEX-suppressed findings, warn on high.
    failSeverity: "critical",
    fixableOnly: true,
    warnSeverity: "high",
  },
};
