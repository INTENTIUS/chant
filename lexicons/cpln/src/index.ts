// Plugin
export { cplnPlugin } from "./plugin";

// Serializer
export { cplnSerializer, cplnLink } from "./serializer";

// The modelled kinds and the link/path helpers built on them. Useful to
// consumers writing their own tooling against a chant-declared cpln estate.
export {
  KINDS,
  KIND_NAMES,
  kindByName,
  kindByTypeName,
  kindByClassName,
  isCplnResourceType,
  collectionPath,
  resourcePath,
  NAMESPACE,
  SERVICE,
} from "./kinds";
export type { CplnKind } from "./kinds";

// Ownership marker convention (cpln `tags` keys).
export { CPLN_TAG_OWNERSHIP_KEYS } from "./ownership";

// Composites — opinionated bundles over the generated resources.
export * from "./composites";

// Generated resources — `Gvc`, `Workload`, `Identity`, `VolumeSet`, `Secret`,
// `Policy`, `Domain`, `IpSet` and the property types their specs reach.
export * from "./generated/index";
