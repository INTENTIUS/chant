// Typed Op step-builder wrappers (chant #1288 Stage 2) — k3dUp/k3dDown with
// authoring-time types derived from this lexicon's own *Args interfaces (see
// ./op/builders.ts's module doc). Opt-in: `@intentius/chant-lexicon-temporal`'s
// same-named exports are core's original untyped builders, unchanged.
export { k3dUp, k3dDown } from "./op/builders";

// Plugin
export { k3dPlugin } from "./plugin";

// Serializer
export { k3dSerializer } from "./serializer";

// Generated resources — export everything from generated index
export * from "./generated/index";
