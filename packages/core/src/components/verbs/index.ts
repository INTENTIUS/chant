/**
 * The starter verb set, grouped by family, per epic #551 and
 * docs/components/capabilities.mdx. The pilot AWS leaves — `docker-build`,
 * `publish-image`, `load-image-on-host`, `cfn-deploy`, `ecs-update-service`,
 * `code-deploy`, `wait-for-stack`, `wait-steady-state`, `wait-cluster-healthy`
 * — are real implementations over the injectable `CloudExecutor` (#557/#564,
 * epic #551, see ./cloud-executor.ts); every other verb remains a typed stub
 * (../capability.ts). `generate-sbom` (#606) is a real implementation over
 * the injectable, artifact-type-keyed `SbomGenerator` (./sbom-generator.ts),
 * defaulted to a "not implemented" backend (mirroring `noopReferrerLookup`)
 * until a real scanner integration is wired in.
 */

export * from "./build-archive";
export * from "./build";
export * from "./sbom-generator";
export * from "./sbom";
export * from "./publish";
export * from "./apply";
export * from "./job-submission";
export * from "./host-delivery";
export * from "./wait-verify";
export * from "./safety";
export * from "./shell";
export * from "./cloud-executor";
