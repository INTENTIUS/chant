// Serializer
export { gitlabSerializer } from "./serializer";

// Plugin
export { gitlabPlugin } from "./plugin";

// Intrinsics
export { reference, ReferenceIntrinsic } from "./intrinsics";

// CI/CD Variables
export { CI } from "./variables";

// Generated entities — export everything from generated index
// After running `chant generate`, this re-exports all CI entity classes
export * from "./generated/index";

// Spec utilities (for tooling)
export { fetchCISchema, fetchSchemas, GITLAB_SCHEMA_VERSION } from "./codegen/fetch";
export { parseCISchema, gitlabShortName, gitlabServiceName } from "./codegen/parse";
export type { GitLabParseResult, ParsedResource, ParsedProperty, ParsedPropertyType, ParsedEnum } from "./codegen/parse";

// Code generation pipeline
export { generate, writeGeneratedFiles } from "./codegen/generate";
export { packageLexicon } from "./codegen/package";
export type { PackageOptions, PackageResult } from "./codegen/package";
