// Typed Op step-builder wrappers (chant #1288 Stage 2) — k3sInstall/
// k3sUninstall with authoring-time types derived from this lexicon's own
// *Args interfaces (see ./op/builders.ts's module doc). Opt-in:
// `@intentius/chant-lexicon-temporal`'s same-named exports are core's
// original untyped builders, unchanged.
export { k3sInstall, k3sUninstall } from "./op/builders";

// Plugin
export { k3sPlugin } from "./plugin";

// Serializer
export { k3sSerializer } from "./serializer";

// Generated resources — export everything from generated index
export * from "./generated/index";

// The pinned upstream release and its Docker image tag form
export { K3S_VERSION, K3S_IMAGE_TAG } from "./spec/fetch";
