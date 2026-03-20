// Serializer
export { dockerSerializer } from "./serializer";

// Plugin
export { dockerPlugin } from "./plugin";

// Interpolation intrinsic
export { env } from "./interpolation";
export type { EnvOptions, EnvIntrinsic } from "./interpolation";

// Context variables
export { DOCKER_VARS, COMPOSE_VARS } from "./variables";
export type { DockerVar, ComposeVar } from "./variables";

// Default labels
export { defaultLabels, defaultAnnotations, isDefaultLabels, isDefaultAnnotations } from "./default-labels";
export { DEFAULT_LABELS_MARKER, DEFAULT_ANNOTATIONS_MARKER } from "./default-labels";
export type { DefaultLabels, DefaultAnnotations } from "./default-labels";

// Generated entities — populated by `bun run generate`
export * from "./generated/index";

// Composites (to be added in Tier 2)
// export * from "./composites/index";

// Codegen pipeline (for external tooling)
export { generate, writeGeneratedFiles } from "./codegen/generate";
export { packageLexicon } from "./codegen/package";
export type { PackageOptions, PackageResult } from "./codegen/package";
