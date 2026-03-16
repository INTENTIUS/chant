// Serializer
export { githubSerializer } from "./serializer";

// Plugin
export { githubPlugin } from "./plugin";

// Expression system
export {
  Expression,
  github, runner, secrets, matrix, steps, needs, inputs, vars, env,
  always, failure, success, cancelled,
  contains, startsWith, toJSON, fromJSON, format,
  branch, tag,
} from "./expression";

// Context Variables
export { GitHub, Runner } from "./variables";

// Generated entities — export everything from generated index
// After running `chant generate`, this re-exports all entity classes
export * from "./generated/index";

// Composites
export {
  Checkout, SetupNode, SetupGo, SetupPython,
  CacheAction, UploadArtifact, DownloadArtifact,
  NodeCI,
  NodePipeline, BunPipeline, PnpmPipeline, YarnPipeline,
  PythonCI,
  DockerBuild,
  DeployEnvironment,
  GoCI,
} from "./composites/index";
export type {
  CheckoutProps, SetupNodeProps, SetupGoProps, SetupPythonProps,
  CacheActionProps, UploadArtifactProps, DownloadArtifactProps,
  NodeCIProps,
  NodePipelineProps,
  PythonCIProps,
  DockerBuildProps,
  DeployEnvironmentProps,
  GoCIProps,
} from "./composites/index";

// Spec utilities (for tooling)
export { fetchWorkflowSchema, fetchSchemas } from "./spec/fetch";
export { parseWorkflowSchema, githubShortName, githubServiceName } from "./codegen/parse";
export type { GitHubParseResult, ParsedResource, ParsedProperty, ParsedPropertyType, ParsedEnum } from "./codegen/parse";

// Code generation pipeline
export { generate, writeGeneratedFiles } from "./codegen/generate";
export { packageLexicon } from "./codegen/package";
export type { PackageOptions, PackageResult } from "./codegen/package";
