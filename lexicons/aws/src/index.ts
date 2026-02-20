// Parameter
export { Parameter } from "./parameter";

// Serializer
export { awsSerializer } from "./serializer";

// Nested Stacks
export { nestedStack, isNestedStackInstance, NestedStackOutputRef, isNestedStackOutputRef, NESTED_STACK_MARKER } from "./nested-stack";
export type { NestedStackOptions, NestedStackInstance } from "./nested-stack";

// Re-export core child project, stack output, and lexicon output primitives
export { isChildProject, CHILD_PROJECT_MARKER } from "@intentius/chant/child-project";
export type { ChildProjectInstance } from "@intentius/chant/child-project";
export { stackOutput, isStackOutput, STACK_OUTPUT_MARKER } from "@intentius/chant/stack-output";
export type { StackOutput } from "@intentius/chant/stack-output";
export { output, isLexiconOutput } from "@intentius/chant/lexicon-output";
export type { LexiconOutput } from "@intentius/chant/lexicon-output";

// Plugin
export { awsPlugin } from "./plugin";

// Intrinsics
export {
  Sub,
  Ref,
  GetAtt,
  If,
  Join,
  Select,
  Split,
  Base64,
  SubIntrinsic,
  RefIntrinsic,
  GetAttIntrinsic,
  IfIntrinsic,
  JoinIntrinsic,
  SelectIntrinsic,
  SplitIntrinsic,
  Base64Intrinsic,
} from "./intrinsics";

// Pseudo-parameters
export {
  AWS,
  StackName,
  Region,
  AccountId,
  StackId,
  URLSuffix,
  NoValue,
  NotificationARNs,
  Partition,
} from "./pseudo";

// Generated resources — export everything from generated index
// After running `chant generate`, this re-exports all 1000+ resource classes
export * from "./generated/index";

// Spec utilities (for tooling)
export { fetchSchemaZip } from "./spec/fetch";
export type { CFNSchema, SchemaProperty, SchemaDefinition } from "./spec/fetch";
export { parseCFNSchema, cfnShortName, cfnServiceName } from "./spec/parse";
export type { SchemaParseResult, ParsedResource, ParsedProperty, ParsedAttribute, ParsedPropertyType, ParsedEnum, PropertyConstraints } from "./spec/parse";

// Code generation pipeline
export { generate, writeGeneratedFiles } from "./codegen/generate";
export { packageLexicon } from "./codegen/package";
export type { PackageOptions, PackageResult } from "./codegen/package";
