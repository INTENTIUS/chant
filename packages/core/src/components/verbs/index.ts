/**
 * The starter verb set, grouped by family, per epic #551 and
 * docs/components/capabilities.mdx. The pilot AWS leaves — `docker-build`,
 * `publish-image`, `cfn-deploy`, `ecs-update-service`, `code-deploy`,
 * `wait-for-stack`, `wait-steady-state`, `wait-cluster-healthy` — are real
 * implementations over the injectable `CloudExecutor` (#557, epic #551, see
 * ./cloud-executor.ts); every other verb remains a typed stub (../capability.ts).
 */

export * from "./build";
export * from "./publish";
export * from "./apply";
export * from "./job-submission";
export * from "./host-delivery";
export * from "./wait-verify";
export * from "./safety";
export * from "./shell";
export * from "./cloud-executor";
