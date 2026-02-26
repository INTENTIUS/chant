// Serializer
export { helmSerializer } from "./serializer";

// Plugin
export { helmPlugin } from "./plugin";

// Resources
export { Chart, Values, HelmTest, HelmNotes, HelmHook, HelmDependency, HelmMaintainer, HelmCRD } from "./resources";

// Intrinsics
export {
  HelmTpl,
  HELM_TPL_KEY,
  HELM_IF_KEY,
  HELM_RANGE_KEY,
  HELM_WITH_KEY,
  values,
  Release,
  ChartRef,
  include,
  required,
  helmDefault,
  toYaml,
  quote,
  printf,
  tpl,
  lookup,
  Capabilities,
  Template,
  filesGet,
  filesGlob,
  filesAsConfig,
  filesAsSecrets,
  ElseIf,
  If,
  Range,
  With,
} from "./intrinsics";
export type { HelmConditional } from "./intrinsics";

// Helpers
export { generateHelpers } from "./helpers";
export type { HelpersConfig } from "./helpers";

// Code generation pipeline
export { generate, writeGeneratedFiles } from "./codegen/generate";
export { packageLexicon } from "./codegen/package";
export type { PackageOptions, PackageResult } from "./codegen/package";

// Composites
export {
  HelmWebApp,
  HelmStatefulService,
  HelmCronJob,
  HelmMicroservice,
  HelmLibrary,
} from "./composites";
export type {
  HelmWebAppProps,
  HelmWebAppResult,
  HelmStatefulServiceProps,
  HelmStatefulServiceResult,
  HelmCronJobProps,
  HelmCronJobResult,
  HelmMicroserviceProps,
  HelmMicroserviceResult,
  HelmLibraryProps,
  HelmLibraryResult,
} from "./composites";

// Import pipeline
export { HelmParser } from "./import/parser";
export { HelmGenerator } from "./import/generator";
export { stripTemplateExpressions, classifyExpression } from "./import/template-stripper";
export type { StrippedExpression, StripResult, ExpressionKind } from "./import/template-stripper";

// LSP providers
export { helmCompletions } from "./lsp/completions";
export { helmHover } from "./lsp/hover";

// Docs generation
export { generateDocs } from "./codegen/docs";
