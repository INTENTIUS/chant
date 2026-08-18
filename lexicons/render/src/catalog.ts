/**
 * The Render resource catalog — the one place that knows, per chant entity
 * type, which REST collection it lives in, how it is identified, and how it is
 * ordered against its neighbours. The serializer, the applier, the observation
 * seam, and the lint rules all read this table so the four cannot drift apart
 * on a resource's wire shape.
 *
 * Render's Public API is a plain REST surface (`https://api.render.com/v1`):
 *   - collections are `POST /services`, `POST /postgres`, ...; children of a
 *     service are `POST /services/{serviceId}/custom-domains`;
 *   - a resource is identified by an opaque id (`srv-…`, `dpg-…`) Render
 *     assigns on create; the *name* is the human key chant reconciles by, and
 *     is unique per workspace for services (Render enforces it) and, in
 *     practice, for the rest of what chant declares;
 *   - lists paginate by cursor and filter by `name` + `ownerId`;
 *   - updates are `PATCH` with the resource's PATCH DTO — a strict subset of
 *     the POST body (`ownerId`, `type`, `envVars` and friends are excluded).
 */

// ── Entity types ───────────────────────────────────────────────────

export const ENTITY_TYPES = {
  webService: "Render::Services::WebService",
  staticSite: "Render::Services::StaticSite",
  privateService: "Render::Services::PrivateService",
  backgroundWorker: "Render::Services::BackgroundWorker",
  cronJob: "Render::Services::CronJob",
  postgres: "Render::Datastores::Postgres",
  keyValue: "Render::Datastores::KeyValue",
  envGroup: "Render::Config::EnvGroup",
  registryCredential: "Render::Config::RegistryCredential",
  webhook: "Render::Config::Webhook",
  project: "Render::Projects::Project",
  environment: "Render::Projects::Environment",
  disk: "Render::Services::Disk",
  customDomain: "Render::Services::CustomDomain",
} as const;

export type EntityType = (typeof ENTITY_TYPES)[keyof typeof ENTITY_TYPES];

/** The five service entity types (share `POST /services`). */
export const SERVICE_ENTITY_TYPES: readonly string[] = [
  ENTITY_TYPES.webService,
  ENTITY_TYPES.staticSite,
  ENTITY_TYPES.privateService,
  ENTITY_TYPES.backgroundWorker,
  ENTITY_TYPES.cronJob,
];

/** Service entity type → the `type` discriminator `POST /services` takes. */
export const SERVICE_TYPE_OF: Record<string, string> = {
  [ENTITY_TYPES.webService]: "web_service",
  [ENTITY_TYPES.staticSite]: "static_site",
  [ENTITY_TYPES.privateService]: "private_service",
  [ENTITY_TYPES.backgroundWorker]: "background_worker",
  [ENTITY_TYPES.cronJob]: "cron_job",
};

/** The reverse: a live service's `type` → chant entity type. */
export const ENTITY_TYPE_OF_SERVICE: Record<string, string> = Object.fromEntries(
  Object.entries(SERVICE_TYPE_OF).map(([k, v]) => [v, k]),
);

export function isServiceEntityType(entityType: string | undefined): boolean {
  return !!entityType && SERVICE_ENTITY_TYPES.includes(entityType);
}

// ── Catalog ────────────────────────────────────────────────────────

/** How one resource kind maps onto the REST API. */
export interface CatalogEntry {
  /** Short kind name — the generated class name (`WebService`, `Postgres`). */
  kind: string;
  /**
   * The create collection. May carry a `{serviceId}` placeholder that the
   * serializer fills from the resource's `serviceId` prop (a literal id, or a
   * `{ $ref }` the applier resolves before issuing the request).
   */
  collection: string;
  /**
   * The key in each element of the list envelope: `GET /services` returns
   * `[{ service: {...}, cursor }]`. `null` for lists that return bare objects.
   */
  listKey: string | null;
  /** Whether the list endpoint accepts `?name=` and `?ownerId=` filters. */
  filters: { name: boolean; ownerId: boolean };
  /** Whether the API offers `PATCH /{collection}/{id}` for updates. */
  patchable: boolean;
  /**
   * The body fields the PATCH DTO accepts. Fields outside this set are
   * create-only (or apply through a side endpoint — env vars) and are excluded
   * from the diff so a rename of `ownerId` never proposes an impossible update.
   */
  patchFields: readonly string[];
  /** Whether the resource carries chant's env-var ownership marker. */
  marked: boolean;
  /**
   * The ownership boundary for a kind with no marker of its own. `"service"`:
   * the resource hangs off a service (`serviceId`), and inherits that service's
   * verdict — a disk or custom domain under a chant-owned service is chant's,
   * the same way fly treats volumes and IPs at the app boundary. Absent: no
   * boundary either; the verdict is `unknown` and the kind is never pruned.
   */
  boundary?: "service";
  /**
   * Whether the create body takes an `ownerId` (workspace). When it does and
   * the author omitted it, the serializer fills it from `Render.OwnerId`.
   */
  ownerScoped: boolean;
  /**
   * Apply ordering. Lower applies first; delete runs in reverse. Projects
   * before environments before everything that can join one; services before
   * the disks/domains that hang off them.
   */
  order: number;
  /** Chant-side props that are association hints, not body fields. */
  nonBodyProps: readonly string[];
}

const SERVICE_PATCH_FIELDS = [
  "autoDeploy",
  "repo",
  "branch",
  "image",
  "name",
  "buildFilter",
  "rootDir",
  "serviceDetails",
] as const;

function serviceEntry(kind: string): CatalogEntry {
  return {
    kind,
    collection: "/services",
    listKey: "service",
    filters: { name: true, ownerId: true },
    patchable: true,
    patchFields: SERVICE_PATCH_FIELDS,
    marked: true,
    ownerScoped: true,
    order: 40,
    nonBodyProps: [],
  };
}

export const CATALOG: Record<string, CatalogEntry> = {
  [ENTITY_TYPES.project]: {
    kind: "Project",
    collection: "/projects",
    listKey: "project",
    filters: { name: true, ownerId: true },
    patchable: true,
    patchFields: ["name"],
    marked: false,
    ownerScoped: true,
    order: 10,
    nonBodyProps: [],
  },
  [ENTITY_TYPES.environment]: {
    kind: "Environment",
    collection: "/environments",
    listKey: "environment",
    filters: { name: true, ownerId: false },
    patchable: true,
    patchFields: ["name", "protectedStatus", "networkIsolationEnabled", "ipAllowList"],
    marked: false,
    ownerScoped: false,
    order: 20,
    nonBodyProps: [],
  },
  [ENTITY_TYPES.registryCredential]: {
    kind: "RegistryCredential",
    collection: "/registrycredentials",
    listKey: "registryCredential",
    filters: { name: true, ownerId: true },
    patchable: true,
    patchFields: ["registry", "name", "username", "authToken"],
    marked: false,
    ownerScoped: true,
    order: 25,
    nonBodyProps: [],
  },
  [ENTITY_TYPES.envGroup]: {
    kind: "EnvGroup",
    collection: "/env-groups",
    listKey: "envGroup",
    filters: { name: true, ownerId: true },
    patchable: true,
    patchFields: ["name", "environmentId"],
    marked: true,
    ownerScoped: true,
    order: 30,
    nonBodyProps: [],
  },
  [ENTITY_TYPES.postgres]: {
    kind: "Postgres",
    collection: "/postgres",
    listKey: "postgres",
    filters: { name: true, ownerId: true },
    patchable: true,
    patchFields: [
      "name",
      "plan",
      "enableHighAvailability",
      "diskSizeGB",
      "enableDiskAutoscaling",
      "readReplicas",
      "ipAllowList",
      "parameterOverrides",
    ],
    marked: false,
    ownerScoped: true,
    order: 30,
    nonBodyProps: [],
  },
  [ENTITY_TYPES.keyValue]: {
    kind: "KeyValue",
    collection: "/key-value",
    listKey: "keyValue",
    filters: { name: true, ownerId: true },
    patchable: true,
    patchFields: ["name", "plan", "maxmemoryPolicy", "ipAllowList"],
    marked: false,
    ownerScoped: true,
    order: 30,
    nonBodyProps: [],
  },
  [ENTITY_TYPES.webService]: serviceEntry("WebService"),
  [ENTITY_TYPES.staticSite]: serviceEntry("StaticSite"),
  [ENTITY_TYPES.privateService]: serviceEntry("PrivateService"),
  [ENTITY_TYPES.backgroundWorker]: serviceEntry("BackgroundWorker"),
  [ENTITY_TYPES.cronJob]: serviceEntry("CronJob"),
  [ENTITY_TYPES.disk]: {
    kind: "Disk",
    collection: "/disks",
    listKey: "disk",
    filters: { name: true, ownerId: true },
    patchable: true,
    patchFields: ["name", "sizeGB", "mountPath"],
    marked: false,
    boundary: "service",
    ownerScoped: false,
    order: 50,
    nonBodyProps: [],
  },
  [ENTITY_TYPES.customDomain]: {
    kind: "CustomDomain",
    collection: "/services/{serviceId}/custom-domains",
    listKey: "customDomain",
    filters: { name: true, ownerId: false },
    patchable: false,
    patchFields: [],
    marked: false,
    boundary: "service",
    ownerScoped: false,
    order: 50,
    nonBodyProps: ["serviceId"],
  },
  [ENTITY_TYPES.webhook]: {
    kind: "Webhook",
    collection: "/webhooks",
    listKey: "webhook",
    filters: { name: false, ownerId: true },
    patchable: true,
    patchFields: ["url", "name", "enabled", "eventFilter"],
    marked: false,
    ownerScoped: true,
    order: 60,
    nonBodyProps: [],
  },
};

/** Look up a catalog entry, or throw — an unknown entity type is a lexicon bug, not user error. */
export function catalogEntry(entityType: string): CatalogEntry {
  const entry = CATALOG[entityType];
  if (!entry) throw new Error(`render: no catalog entry for entity type ${entityType}`);
  return entry;
}

/** Entity type ← short kind (`WebService` → `Render::Services::WebService`). */
export function entityTypeOfKind(kind: string): string | undefined {
  for (const [type, entry] of Object.entries(CATALOG)) {
    if (entry.kind === kind) return type;
  }
  return undefined;
}
