// Forgejo Actions lexicon — a thin dialect of the github lexicon.
//
// Serializer + plugin override only the dialect; everything a user writes
// (entities, expression helpers, context variables, composites) is reused
// directly from the github lexicon and re-exported here so a forgejo project
// imports solely from "@intentius/chant-lexicon-forgejo".

// Serializer
export { forgejoSerializer } from "./serializer";

// Plugin
export { forgejoPlugin } from "./plugin";

// Dialect (exposed for tooling/tests)
export {
  applyForgejoDialect,
  DEFAULT_RUNNER_LABELS,
  type ForgejoDialectOptions,
  type ForgejoDialectResult,
} from "./dialect";

// Action-reference resolver (exposed for tooling/tests)
export {
  resolveActionRef,
  DEFAULT_ACTIONS_ROOT,
  KNOWN_ACTIONS,
  type ActionTarget,
  type ActionResolveOptions,
  type ActionResolveResult,
} from "./actions";

// Reuse the entire github authoring surface: generated entities, expression
// system, context variables, and composites.
export * from "@intentius/chant-lexicon-github";
