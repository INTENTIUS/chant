// Plugin
export { cedarPlugin } from "./plugin";

// Serializer
export { cedarSerializer, policyIdFromLogicalName, resolvePolicyId, cedarPolicyRecords } from "./serializer";
export { CEDAR_POLICY_TYPE, CEDAR_JSON_FILENAME } from "./serializer";
export type { CedarEffect, CedarScope, CedarPolicyProps, CedarPolicyRecord } from "./serializer";

// AVP embedding (#1652) — the typed statement an `AWS::VerifiedPermissions::Policy`
// carries, without a dependency on the aws lexicon. See src/avp/embed.ts.
export {
  avpStatement,
  avpStatementJSON,
  avpPolicyDefinition,
  avpPolicyResource,
  avpPolicySet,
} from "./avp/embed";
export type {
  AvpEmbedOptions,
  AvpPolicyDefinition,
  AvpPolicyResource,
  AvpStaticDefinition,
} from "./avp/embed";

// The AVP ownership channel (#1652, chant #1348). Design record: src/avp/OWNERSHIP.md.
export {
  AVP_OWNERSHIP_KEYS,
  AVP_POLICY_ID_KEY,
  AVP_DESCRIPTION_MAX,
  encodeOwnershipDescription,
  decodeOwnershipDescription,
  ownershipFromDescription,
  ownershipFromStoreTags,
  descriptionIsOwned,
  storeOwnershipTags,
} from "./avp/ownership";
export type { DecodedDescription } from "./avp/ownership";

// AVP lifecycle readers (#1652).
export { describeAvpResources } from "./avp/describe-resources";
export { observeAvpAmbient, AVP_AMBIENT_KINDS } from "./avp/ambient";
export { exportAvpResources, policyToResourceIR } from "./avp/live-export";
export { resolvePolicyStoreId, AVP_POLICY_STORE_ENV } from "./avp/store";

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

// The dogwood temporal dialect (#1658) — typed temporal builders, the `.dw`
// serializer leg, `.dwschema` event schemas. Pre-release; see ./dogwood.
//
// Namespaced rather than flattened: the temporal sub-language's builders are
// named after its own grammar (`and`, `not`, `count`, `sum`, `str`, `field`,
// `record`, `window`), and spilling those into the package root would collide
// with a schema-generated entity class the moment someone declares one. The
// three entity classes are re-exported flat because that is what a policy file
// names.
export * as dogwood from "./dogwood/index";
export {
  DOGWOOD_EVENT_SCHEMA_FILENAME,
  DOGWOOD_EVENT_SCHEMA_TYPE,
  DOGWOOD_MACRO_FILENAME,
  DOGWOOD_MACRO_LIBRARY_TYPE,
  DOGWOOD_POLICY_FILENAME,
  DOGWOOD_POLICY_TYPE,
  TemporalEventSchema,
  TemporalMacroLibrary,
  TemporalPolicy,
} from "./dogwood/policy";
export type { EventSchemaProps, MacroLibraryProps, TemporalPolicyProps } from "./dogwood/policy";
export { DOGWOOD_UPSTREAM } from "./dogwood/upstream";

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

// Schema coverage — is every schema declaration reachable from the generated
// artifacts? Policy coverage below asks the other half.
export { computeCedarCoverage, formatCedarCoverage, analyzeCedarCoverage } from "./coverage";
export type { CedarCoverageReport, CedarCoverageItem } from "./coverage";

// Policy coverage — which schema declarations the built policy set can apply
// to. Backs the `cedar:coverage` MCP tool.
export { computePolicyCoverage, formatPolicyCoverage } from "./mcp/policy-coverage";
export type {
  CedarPolicyCoverageReport,
  CedarPolicyCoverageItem,
  CedarPolicyCoverageOptions,
} from "./mcp/policy-coverage";

// Composites — the repeated policy shapes Cedar itself has nowhere to put.
export * from "./composites/index";

// `chant init --lexicon cedar --template <name>` scaffolds.
export { cedarInitTemplates, CEDAR_INIT_TEMPLATES } from "./init-templates";

// Generated entity types, actions and the Policy authoring class (#1650).
export * from "./generated/index";
