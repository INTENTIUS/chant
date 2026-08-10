// Plugin
export { k3sPlugin } from "./plugin";

// Serializer
export { k3sSerializer } from "./serializer";

// Generated resources — export everything from generated index
export * from "./generated/index";

// The pinned upstream release and its Docker image tag form
export { K3S_VERSION, K3S_IMAGE_TAG } from "./spec/fetch";
