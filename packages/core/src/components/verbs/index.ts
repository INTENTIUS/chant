/**
 * The starter verb set, grouped by family, per epic #551 and
 * docs/components/capabilities.mdx. The pilot AWS leaves — `docker-build`,
 * `publish-image`, `load-image-on-host`, `cfn-deploy`, `ecs-update-service`,
 * `code-deploy`, `wait-for-stack`, `wait-steady-state`, `wait-cluster-healthy`
 * — are real implementations over the injectable `CloudExecutor` (#557/#564,
 * epic #551, see ./cloud-executor.ts); every other verb remains a typed stub
 * (../capability.ts). `generate-sbom` (#606) is a real implementation over
 * the injectable, artifact-type-keyed `SbomGenerator` (./sbom-generator.ts);
 * `./lockfile-sbom-generator.ts` (#613) is a real, hermetic backend for it
 * (lockfile/manifest parsing, no external tool), and `./tool-sbom-generator.ts`
 * (#610) is a real, deep-scan backend for it (`syft`/`docker buildx --sbom`/
 * `cyclonedx-maven`/`cdxgen`, shelling out through the injectable
 * `ProcessRunner`, ./process-runner.ts). `extract-config-bom` (#613) parses a
 * synthesized CloudFormation template, so it moved to the aws lexicon (#684);
 * core keeps the agnostic SPDX/CycloneDX writer, ./bom-writer.ts, which both it
 * and `generate-sbom` share. ./component-bom.ts
 * (#614) composes a component's leaf BOMs into one component-level BOM over
 * that same writer, and ./reproducibility.ts (#614) records per-artifact
 * reproducibility + provenance on each `BuildArchiveEntry`. `publish-image`
 * (#610) also gained a best-effort OCI-referrer attach step (`oras attach`,
 * also via `ProcessRunner`) for a supplied SBOM/component BOM — see ./publish.ts.
 * `sign`/`attest-provenance` (#622, ./sign.ts) are real implementations over
 * the same injectable `ProcessRunner`: keyless-by-default `cosign sign`/
 * `cosign attest` for signature + SLSA provenance, reusing #614's
 * `ProvenanceLink` material. `verify` (#622, ./verify.ts) is the matching
 * deploy-time gate — `cosign verify`/`verify-attestation` against a
 * configured identity policy, mirroring ../../lint/policy.ts's `policyGate`.
 */

export * from "./build-archive";
export * from "./build";
export * from "./bom-writer";
export * from "./sbom-generator";
export * from "./sbom";
export * from "./lockfile-sbom-generator";
export * from "./tool-sbom-generator";
export * from "./component-bom";
export * from "./reproducibility";
export * from "./sign";
export * from "./verify";
export * from "./vuln-scan";
export * from "./vex";
export * from "./license-policy";
export * from "./vuln-gate";
export * from "./wait-verify";
export * from "./shell";
export * from "./ensure-secret";
export * from "./cloud-executor";
export * from "./process-runner";
