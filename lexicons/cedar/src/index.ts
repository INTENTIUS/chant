// Plugin
export { cedarPlugin } from "./plugin";

// Serializer
export { cedarSerializer, policyIdFromLogicalName } from "./serializer";
export { CEDAR_POLICY_TYPE, CEDAR_JSON_FILENAME } from "./serializer";
export type { CedarEffect, CedarScope, CedarPolicyProps } from "./serializer";

// Lint rules
export { rules as cedarLintRules } from "./lint/rules";

// Packaging pipeline (for external tooling)
export { packageLexicon } from "./codegen/package";
export type { PackageOptions, PackageResult } from "./codegen/package";

// Generated entities — populated by schema-driven codegen (#1650).
// export * from "./generated/index";
