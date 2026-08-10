// Plugin
export { cedarPlugin } from "./plugin";

// Serializer
export { cedarSerializer, policyIdFromLogicalName } from "./serializer";
export { CEDAR_POLICY_TYPE, CEDAR_JSON_FILENAME } from "./serializer";
export type { CedarEffect, CedarScope, CedarPolicyProps } from "./serializer";

export { policySetJSON, escapeCedarString } from "./serializer";
export type { CedarPolicySetJSON } from "./serializer";

// Import / reconcile (#1653) — `.cedar` text and the JSON policy-set envelope
// in, authoring TypeScript out.
export { CedarParser, isPolicySetEnvelope } from "./import/parser";
export type { CedarParseResult, CedarPolicyIR, CedarEntityKind } from "./import/parser";
export { CedarGenerator, loadActionConstants, sanitizeName, CEDAR_PACKAGE } from "./import/generator";
export type { CedarGenerateOptions, CedarGenerateResult } from "./import/generator";
export { CedarTemplateParser, CedarTemplateGenerator } from "./import/adapter";
export { detectTemplate } from "./detect";

// Lint rules
export { rules as cedarLintRules } from "./lint/rules";

// Packaging pipeline (for external tooling)
export { packageLexicon } from "./codegen/package";
export type { PackageOptions, PackageResult } from "./codegen/package";

// The `cedar` config namespace (#1344). Importing this package is what brings
// the key into ChantConfig, so a `chant.config.ts` that sets it compiles.
export { cedarConfigSchema, loadCedarConfig, CEDAR_DEFAULT_SCHEMA_PATH } from "./config";
export type { CedarConfig } from "./config";

// Upstream pin — the cedar-wasm package version and the Cedar language
// version it implements (#1650).
export { CEDAR_WASM_VERSION, CEDAR_LANG_VERSION } from "./spec/pin";

// Schema coverage.
export { computeCedarCoverage, formatCedarCoverage, analyzeCedarCoverage } from "./coverage";
export type { CedarCoverageReport, CedarCoverageItem } from "./coverage";

// Generated entity types, actions and the Policy authoring class (#1650).
export * from "./generated/index";
