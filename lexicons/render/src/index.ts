// Plugin
export { renderPlugin } from "./plugin";

// Serializer (+ the marker shapes the applier resolves)
export { renderSerializer, isRefMarker, isAttrMarker, isOwnerMarker } from "./serializer";
export type { RenderPlan, RenderRequest, RefMarker, AttrMarker, OwnerMarker } from "./serializer";

// Pseudo-parameters — environment-resolved values (`Render.OwnerId`,
// `Render.Region`) usable in place of hard-coded strings.
export { Render, OwnerId, Region, PseudoParameter } from "./pseudo";

// Ownership marker convention (env-var keys on services and env groups)
export { RENDER_ENV_OWNERSHIP_KEYS } from "./ownership";

// The resource catalog: entity type → REST collection, identity, ordering.
export { CATALOG, ENTITY_TYPES, SERVICE_TYPE_OF, catalogEntry, isServiceEntityType } from "./catalog";
export type { CatalogEntry, EntityType } from "./catalog";

// Deploy Op composite + typed step builders. `renderDeploy` returns a
// `build → renderApply [→ verify] [→ teardown]` Op; the step builders wrap the
// generic `activity()` so the render activities resolve by name.
export { renderDeploy, renderApplyStep, renderDeleteStep } from "./composites/render-deploy";
export type { RenderDeployOpts, RenderApplyStepOpts } from "./composites/render-deploy";

// Generated resources — export everything from generated index.
// Provides `WebService`, `StaticSite`, `PrivateService`, `BackgroundWorker`,
// `CronJob`, `Postgres`, `KeyValue`, `EnvGroup`, `Project`, `Environment`,
// `Disk`, `CustomDomain`, `RegistryCredential`, `Webhook`, and the property
// types (`WebServiceDetails`, `Image`, `ServiceDisk`, ...) for authoring.
export * from "./generated/index";
