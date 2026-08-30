/**
 * The Control Plane kinds this lexicon models, and the facts about each that
 * more than one subsystem needs.
 *
 * Codegen, the serializer, observation, the LSP providers, the MCP catalog and
 * the docs generator all need to agree on the same three things: which schema
 * in the OpenAPI document backs a kind, what its chant type name is, and
 * whether it is scoped to a GVC. Each of those was, in an earlier draft, a
 * literal repeated in five files — so a kind added in one place quietly went
 * missing from the others. This table is the single place a kind is declared.
 *
 * Coverage is deliberately the *workload* surface rather than every kind the
 * API exposes. The org-administration kinds (`group`, `serviceaccount`,
 * `cloudaccount`, `auditctx`, `user`, `agent`) and `mk8s` are all modellable
 * from the same spec by adding rows here; they are out of the first pass, not
 * out of reach. `chant cpln coverage` reports the gap rather than hiding it.
 */

/** The chant namespace segment for every generated cpln type. */
export const NAMESPACE = "Cpln";

/** The single service segment. The Control Plane Core API is one service. */
export const SERVICE = "Core";

export interface CplnKind {
  /**
   * The `kind` discriminator as it appears in a `cpln apply` manifest and in
   * the API's own responses. Also the REST collection segment — the API is
   * uniform that way, so `/org/{org}/{kind}` is the org-scoped collection and
   * `/org/{org}/gvc/{gvc}/{kind}` the GVC-scoped one.
   */
  kind: string;
  /** The schema name in `components.schemas` backing this kind. */
  schema: string;
  /** The chant type name, e.g. `Cpln::Core::Workload`. */
  typeName: string;
  /** The generated TypeScript class name, e.g. `Workload`. */
  className: string;
  /**
   * Whether the kind lives inside a GVC. GVC-scoped kinds get a synthetic
   * `gvc` property — see `SYNTHETIC_GVC_PROP` in `spec/parse.ts` for why the
   * spec cannot supply it.
   */
  gvcScoped: boolean;
  /** One-line summary, used for LSP hover, MCP catalog entries and docs. */
  summary: string;
}

export const KINDS: CplnKind[] = [
  {
    kind: "gvc",
    schema: "gvc",
    typeName: `${NAMESPACE}::${SERVICE}::Gvc`,
    className: "Gvc",
    gvcScoped: false,
    summary:
      "Global Virtual Cloud — the placement and networking boundary every workload, identity and volume set belongs to.",
  },
  {
    kind: "workload",
    schema: "workload",
    typeName: `${NAMESPACE}::${SERVICE}::Workload`,
    className: "Workload",
    gvcScoped: true,
    summary:
      "A running unit of work — serverless, standard, cron, stateful or vm — with its containers, firewall and autoscaling.",
  },
  {
    kind: "identity",
    schema: "identity",
    typeName: `${NAMESPACE}::${SERVICE}::Identity`,
    className: "Identity",
    gvcScoped: true,
    summary:
      "A workload's identity, carrying its cloud-provider access (AWS/GCP/Azure) and network resource grants.",
  },
  {
    kind: "volumeset",
    schema: "volumeset",
    typeName: `${NAMESPACE}::${SERVICE}::VolumeSet`,
    className: "VolumeSet",
    gvcScoped: true,
    summary: "Persistent storage attached to stateful workloads, with its performance class and snapshot policy.",
  },
  {
    kind: "secret",
    schema: "secret",
    typeName: `${NAMESPACE}::${SERVICE}::Secret`,
    className: "Secret",
    gvcScoped: false,
    summary: "An org-scoped secret — opaque, TLS, keypair, dictionary, or a cloud-provider credential.",
  },
  {
    kind: "policy",
    schema: "policy",
    typeName: `${NAMESPACE}::${SERVICE}::Policy`,
    className: "Policy",
    gvcScoped: false,
    summary: "An access policy binding permissions to principals over a target kind, link set, or query.",
  },
  {
    kind: "domain",
    schema: "domain",
    typeName: `${NAMESPACE}::${SERVICE}::Domain`,
    className: "Domain",
    gvcScoped: false,
    summary: "A custom domain with its TLS, CORS and per-port routing to workloads.",
  },
  {
    kind: "ipset",
    schema: "ipset",
    typeName: `${NAMESPACE}::${SERVICE}::IpSet`,
    className: "IpSet",
    gvcScoped: false,
    summary: "A set of dedicated IP addresses reserved in named locations and bound to a workload.",
  },
];

/** Every modelled kind string, in declaration order. */
export const KIND_NAMES: string[] = KINDS.map((k) => k.kind);

const BY_KIND = new Map(KINDS.map((k) => [k.kind, k] as const));
const BY_TYPE_NAME = new Map(KINDS.map((k) => [k.typeName, k] as const));
const BY_CLASS_NAME = new Map(KINDS.map((k) => [k.className, k] as const));

/** Look up a kind by its `kind` discriminator (`"workload"`). */
export function kindByName(kind: string): CplnKind | undefined {
  return BY_KIND.get(kind);
}

/** Look up a kind by chant type name (`"Cpln::Core::Workload"`). */
export function kindByTypeName(typeName: string): CplnKind | undefined {
  return BY_TYPE_NAME.get(typeName);
}

/** Look up a kind by generated class name (`"Workload"`). */
export function kindByClassName(className: string): CplnKind | undefined {
  return BY_CLASS_NAME.get(className);
}

/** Whether a chant type name belongs to a modelled cpln resource (not a property type). */
export function isCplnResourceType(typeName: string): boolean {
  return BY_TYPE_NAME.has(typeName);
}

/**
 * The REST collection path for a kind, relative to the API root.
 *
 * GVC-scoped kinds have two: the writable collection nested under their GVC,
 * and an org-wide read-only rollup. Observation uses the rollup (one request
 * per kind instead of one per GVC); apply uses the nested one.
 */
export function collectionPath(kind: CplnKind, org: string, gvc?: string): string {
  if (kind.gvcScoped && gvc) return `/org/${org}/gvc/${gvc}/${kind.kind}`;
  return `/org/${org}/${kind.kind}`;
}

/** The path of a single named resource. */
export function resourcePath(kind: CplnKind, org: string, name: string, gvc?: string): string {
  return `${collectionPath(kind, org, gvc)}/${name}`;
}

/** Extract the short name from a chant type name: `Cpln::Core::Workload` → `Workload`. */
export function cplnShortName(typeName: string): string {
  const parts = typeName.split("::");
  return parts[parts.length - 1];
}

/** Extract the service segment: `Cpln::Core::Workload` → `Core`. */
export function cplnServiceName(typeName: string): string {
  const parts = typeName.split("::");
  return parts.length >= 2 ? parts[1] : SERVICE;
}
