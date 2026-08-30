// Serializer
export { gitlabSerializer } from "./serializer";

// Plugin
export { gitlabPlugin } from "./plugin";

// Typed Op step-builder wrapper (chant #1288 Stage 2) — gitlabPipeline with
// authoring-time types derived from this lexicon's own GitlabPipelineArgs
// (see lexicons/k8s/src/op/builders.ts's module doc for why this lives here
// rather than in core or the temporal barrel). Opt-in:
// `@intentius/chant-lexicon-temporal`'s same-named export is core's original
// untyped builder, unchanged, for cloud-agnostic authoring.
export { gitlabPipeline } from "./op/builders";

// Intrinsics
export { reference, ReferenceIntrinsic } from "./intrinsics";

// CI/CD Variables
export { CI } from "./variables";

// Generated entities — export everything from generated index
// After running `chant generate`, this re-exports all CI entity classes
export * from "./generated/index";

// Composites
export { DockerBuild, NodePipeline, BunPipeline, PnpmPipeline, PythonPipeline, ReviewApp, MrPlanReport } from "./composites/index";
export type { DockerBuildProps, NodePipelineProps, PythonPipelineProps, ReviewAppProps, MrPlanReportProps } from "./composites/index";

// Spec utilities (for tooling)
export { fetchCISchema, fetchSchemas, GITLAB_SCHEMA_VERSION } from "./codegen/fetch";
export { parseCISchema, gitlabShortName, gitlabServiceName } from "./codegen/parse";
export type { GitLabParseResult, ParsedResource, ParsedProperty, ParsedPropertyType, ParsedEnum } from "./codegen/parse";

// Code generation pipeline
export { generate, writeGeneratedFiles } from "./codegen/generate";
export { packageLexicon } from "./codegen/package";
export type { PackageOptions, PackageResult } from "./codegen/package";
