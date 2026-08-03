import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { safeHeartbeat } from "@intentius/chant/op";

// The floci-az default local subscription (from its ARM management-plane mock).
const DEFAULT_SUBSCRIPTION = "00000000-0000-0000-0000-000000000001";
const DEFAULT_ENDPOINT = "https://management.azure.com";

/** One ARM resource from a `deploymentTemplate.json` `resources[]`. */
export interface ArmResource {
  type: string;
  apiVersion: string;
  name: string;
  location?: string;
  properties?: unknown;
  sku?: unknown;
  kind?: unknown;
  tags?: Record<string, string>;
  dependsOn?: unknown;
}

/** Injectable HTTP client — mirrors the GCP applier so tests avoid the network. */
export type AzHttp = (
  method: string,
  url: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<{ status: number; text: string }>;

const defaultHttp: AzHttp = async (method, url, body, signal) => {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return { status: res.status, text: await res.text() };
};

// ── ARM expression evaluation ─────────────────────────────────────────────────

/**
 * Context for evaluating ARM template expressions. `deployed` holds the response
 * bodies of resources already applied this run (keyed by evaluated name) so
 * `reference()` resolves; `http`/`base` let `listKeys()` call the resource's
 * key action.
 */
export interface ArmEvalCtx {
  subscriptionId: string;
  resourceGroup: string;
  location: string;
  deployed: Map<string, unknown>;
  http: AzHttp;
  base: string;
  signal?: AbortSignal;
}

/** Evaluate an ARM expression string (`"[...]"`); a plain string is returned as-is. */
export async function evalArmString(s: string, ctx: ArmEvalCtx): Promise<unknown> {
  if (!(s.startsWith("[") && s.endsWith("]"))) return s;
  if (s.startsWith("[[")) return s.slice(1); // escaped literal "["
  return new ArmExpr(s.slice(1, -1), ctx).parse();
}

/** Recursively evaluate every string in a value against the ARM context. */
export async function evalArm(value: unknown, ctx: ArmEvalCtx): Promise<unknown> {
  if (typeof value === "string") return evalArmString(value, ctx);
  if (Array.isArray(value)) return Promise.all(value.map((v) => evalArm(v, ctx)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await evalArm(v, ctx);
    return out;
  }
  return value;
}

/**
 * Recursive-descent evaluator for the ARM function subset chant emits:
 * `concat`, `uniqueString`, `resourceGroup()`, `subscription()`, `resourceId`,
 * `reference` (runtime state of an applied resource), and `listKeys` (async key
 * action), with `.prop` and `[index]` access.
 */
class ArmExpr {
  private i = 0;
  constructor(private readonly src: string, private readonly ctx: ArmEvalCtx) {}

  async parse(): Promise<unknown> {
    return this.access(await this.atom());
  }

  private async atom(): Promise<unknown> {
    this.ws();
    return this.src[this.i] === "'" ? this.stringLiteral() : this.call();
  }

  /** Postfix `.prop` / `[index]` access. */
  private async access(v: unknown): Promise<unknown> {
    for (;;) {
      const c = this.peek();
      if (c === ".") {
        this.i++;
        v = (v as Record<string, unknown> | undefined)?.[this.ident()];
      } else if (c === "[") {
        this.i++;
        v = (v as unknown[] | undefined)?.[this.indexNumber()];
      } else {
        return v;
      }
    }
  }

  private async call(): Promise<unknown> {
    const name = this.ident();
    this.ws();
    const args: unknown[] = [];
    if (this.peek() === "(") {
      this.i++;
      this.ws();
      if (this.peek() !== ")") {
        args.push(await this.parse());
        this.ws();
        while (this.peek() === ",") {
          this.i++;
          args.push(await this.parse());
          this.ws();
        }
      }
      if (this.peek() === ")") this.i++;
    }
    return this.applyFn(name, args);
  }

  private async applyFn(name: string, args: unknown[]): Promise<unknown> {
    switch (name) {
      case "concat":
        return args.map(String).join("");
      case "uniqueString":
        return createHash("sha256").update(args.map(String).join("-")).digest("hex").slice(0, 13);
      case "resourceGroup":
        return { location: this.ctx.location, id: `/subscriptions/${this.ctx.subscriptionId}/resourceGroups/${this.ctx.resourceGroup}`, name: this.ctx.resourceGroup };
      case "subscription":
        return { subscriptionId: this.ctx.subscriptionId, id: `/subscriptions/${this.ctx.subscriptionId}` };
      case "resourceId":
        // resourceId('Microsoft.X/y', 'name'[, 'child']) → the resource-id path.
        return `/subscriptions/${this.ctx.subscriptionId}/resourceGroups/${this.ctx.resourceGroup}/providers/${args.map(String).join("/")}`;
      case "reference": {
        // reference('name') → the runtime `properties` of an already-applied resource.
        const dep = this.ctx.deployed.get(String(args[0]));
        return (dep as { properties?: unknown } | undefined)?.properties ?? dep;
      }
      case "listKeys": {
        // listKeys(resourceId, apiVersion) → POST the resource's key action.
        const resId = String(args[0]);
        const apiVersion = String(args[1] ?? "2023-01-01");
        const res = await this.ctx.http("POST", `${this.ctx.base}${resId}/listKeys?api-version=${apiVersion}`, {}, this.ctx.signal);
        try {
          return JSON.parse(res.text);
        } catch {
          return {};
        }
      }
      default:
        throw new Error(`unsupported ARM function: ${name}`);
    }
  }

  private stringLiteral(): string {
    this.i++; // opening '
    let out = "";
    while (this.i < this.src.length && this.src[this.i] !== "'") out += this.src[this.i++];
    this.i++; // closing '
    return out;
  }

  private ident(): string {
    this.ws();
    let out = "";
    while (this.i < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.i])) out += this.src[this.i++];
    return out;
  }

  private indexNumber(): number {
    this.ws();
    let n = "";
    while (this.i < this.src.length && /[0-9]/.test(this.src[this.i])) n += this.src[this.i++];
    this.ws();
    if (this.peek() === "]") this.i++;
    return parseInt(n, 10);
  }

  private ws(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }

  private peek(): string {
    this.ws();
    return this.src[this.i];
  }
}

// ── Dependency ordering ───────────────────────────────────────────────────────

/** Resource names this resource references via `resourceId('type','name')` / `reference('name')`. Pure. */
export function armDependencies(resource: ArmResource, names: Set<string>): string[] {
  const deps = new Set<string>();
  const scan = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/resourceId\(\s*'[^']*'\s*,\s*'([^']*)'/g)) if (names.has(m[1])) deps.add(m[1]);
      for (const m of v.matchAll(/reference\(\s*'([^']*)'/g)) if (names.has(m[1])) deps.add(m[1]);
    } else if (Array.isArray(v)) {
      v.forEach(scan);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(scan);
    }
  };
  scan(resource);
  deps.delete(resource.name);
  return [...deps];
}

/**
 * Topologically order ARM resources so a referenced resource is applied before
 * the resource that references it. Names that are expressions are ordered as-is
 * (they don't match a literal reference). Throws on a cycle. Pure.
 */
export function orderArmResources(resources: ArmResource[]): ArmResource[] {
  const byName = new Map<string, ArmResource>();
  for (const r of resources) byName.set(r.name, r);
  const names = new Set(resources.map((r) => r.name));
  const ordered: ArmResource[] = [];
  const done = new Set<ArmResource>();
  const active = new Set<ArmResource>();
  const visit = (r: ArmResource): void => {
    if (done.has(r)) return;
    if (active.has(r)) throw new Error(`ARM reference cycle involving ${r.name}`);
    active.add(r);
    for (const dep of armDependencies(r, names)) {
      const target = byName.get(dep);
      if (target && target !== r) visit(target);
    }
    active.delete(r);
    done.add(r);
    ordered.push(r);
  };
  for (const r of resources) visit(r);
  return ordered;
}

// ── URL + body + apply ────────────────────────────────────────────────────────

/** The ARM resource-ID PUT URL for a resource (name expression evaluated). */
export async function armResourceUrl(resource: ArmResource, ctx: ArmEvalCtx): Promise<string> {
  const name = await evalArmString(resource.name, ctx);
  return `${ctx.base}/subscriptions/${ctx.subscriptionId}/resourceGroups/${ctx.resourceGroup}/providers/${resource.type}/${name}?api-version=${resource.apiVersion}`;
}

/** The ARM resource PUT body (location/properties/sku/kind/tags), expressions evaluated. */
export async function armResourceBody(resource: ArmResource, ctx: ArmEvalCtx): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (resource.location) body.location = await evalArmString(resource.location, ctx);
  if (resource.properties !== undefined) body.properties = await evalArm(resource.properties, ctx);
  if (resource.sku !== undefined) body.sku = await evalArm(resource.sku, ctx);
  if (resource.kind !== undefined) body.kind = await evalArm(resource.kind, ctx);
  if (resource.tags !== undefined) body.tags = await evalArm(resource.tags, ctx);
  return body;
}

export interface AzApplyArgs {
  /** Path to a built ARM template (`deploymentTemplate.json`). */
  templatePath: string;
  /** Resource group to deploy into. */
  resourceGroup: string;
  /** Region for the resource group and `resourceGroup().location`. Default: `eastus`. */
  location?: string;
  /** ARM endpoint override (e.g. floci-az `http://localhost:4577`). Default: real Azure. */
  endpoint?: string;
  /** Subscription id. Default: floci-az's local subscription. */
  subscriptionId?: string;
  /**
   * Delete chant-owned resources of a templated type that are no longer in the
   * template (owned-only prune). Destructive — off by default. Foreign
   * (non-chant) resources are never touched.
   */
  prune?: boolean;
}

/**
 * The native Azure applier — read a built ARM template and PUT each resource
 * directly to the ARM resource-CRUD API, in dependency order, resolving ARM
 * expressions (including `reference()`/`listKeys()` against resources applied
 * earlier this run). The Azure twin of `gcpApply`: it targets floci-az (which
 * `az deployment` can't, floci-az having no deployments provider) or real Azure
 * by endpoint override; the resource group is ensured first.
 */
export async function azApply(
  args: AzApplyArgs,
  signal?: AbortSignal,
  http: AzHttp = defaultHttp,
): Promise<{
  applied: Array<{ type: string; name: string }>;
  pruned: Array<{ type: string; name: string; deleted: boolean }>;
  /** Owned, undeclared resources the prune could not delete (#1457). Empty when
   * `prune` is off, and empty on a clean prune. */
  notPrunable: AzNotPrunable[];
}> {
  const base = (args.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
  const ctx: ArmEvalCtx = {
    subscriptionId: args.subscriptionId ?? DEFAULT_SUBSCRIPTION,
    resourceGroup: args.resourceGroup,
    location: args.location ?? "eastus",
    deployed: new Map(),
    http,
    base,
    signal,
  };

  // Ensure the resource group exists (ARM rejects resource PUTs without it).
  await http(
    "PUT",
    `${base}/subscriptions/${ctx.subscriptionId}/resourceGroups/${ctx.resourceGroup}?api-version=2021-04-01`,
    { location: ctx.location },
    signal,
  );

  const template = JSON.parse(readFileSync(args.templatePath, "utf8")) as { resources?: ArmResource[] };
  const resources = template.resources ?? [];
  const applied: Array<{ type: string; name: string }> = [];
  for (const resource of orderArmResources(resources)) {
    const name = String(await evalArmString(resource.name, ctx));
    safeHeartbeat({ step: "azApply", type: resource.type, name });
    // Stamp chant ownership so a later prune can tell chant-managed resources
    // apart from foreign ones in the same group.
    const body = await armResourceBody(resource, ctx);
    body.tags = { ...((body.tags as Record<string, string> | undefined) ?? {}), ...chantOwnershipTags() };
    const res = await http("PUT", await armResourceUrl(resource, ctx), body, signal);
    if (res.status >= 300) {
      throw new Error(`${resource.type} ${name} apply failed (${res.status}): ${res.text}`);
    }
    // Capture the applied resource so later reference()/dependents resolve.
    try {
      ctx.deployed.set(name, JSON.parse(res.text));
    } catch {
      // non-JSON response — reference() to this resource resolves to undefined
    }
    console.log(`applied: ${resource.type}/${name} (${base})`);
    applied.push({ type: resource.type, name });
  }

  const prune = args.prune
    ? await pruneArmOrphans(resources, ctx, http, signal)
    : { pruned: [], notPrunable: [] };
  return { applied, pruned: prune.pruned, notPrunable: prune.notPrunable };
}

// ── Ownership + prune + delete ────────────────────────────────────────────────

// chant stamps this tag on every resource it applies; prune only ever deletes
// resources carrying it, so a foreign resource sharing the group is never
// touched. Real Azure persists resource tags; note that floci-az currently drops
// them, so owned-only prune only takes effect against real Azure (the delete
// mechanics themselves work against either — see azDelete).
const OWNERSHIP_TAG_KEY = "managed-by";
const OWNERSHIP_TAG_VALUE = "chant";

/** The ownership tag azApply stamps on every resource it applies. */
export function chantOwnershipTags(): Record<string, string> {
  return { [OWNERSHIP_TAG_KEY]: OWNERSHIP_TAG_VALUE };
}

/** Whether a resource's tags mark it chant-owned. */
export function isChantOwned(tags: Record<string, string> | null | undefined): boolean {
  return tags?.[OWNERSHIP_TAG_KEY] === OWNERSHIP_TAG_VALUE;
}

/** One resource from the ARM resource-group listing. */
export interface ArmListItem {
  id: string;
  name: string;
  type: string;
  tags?: Record<string, string>;
}

/** List the resources in the group via the ARM resource-list endpoint. */
export async function listGroupResources(ctx: ArmEvalCtx, http: AzHttp = defaultHttp, signal?: AbortSignal): Promise<ArmListItem[]> {
  const url = `${ctx.base}/subscriptions/${ctx.subscriptionId}/resourceGroups/${ctx.resourceGroup}/resources?api-version=2021-04-01`;
  const res = await http("GET", url, undefined, signal);
  if (res.status >= 300) return [];
  try {
    return ((JSON.parse(res.text) as { value?: ArmListItem[] }).value ?? []).filter((r) => r?.type && r?.name);
  } catch {
    return [];
  }
}

/** Idempotently delete one ARM resource by type/name/apiVersion. A 404 means it is already gone. */
export async function deleteArmResource(
  type: string,
  name: string,
  apiVersion: string,
  ctx: ArmEvalCtx,
  http: AzHttp = defaultHttp,
  signal?: AbortSignal,
): Promise<{ type: string; name: string; deleted: boolean }> {
  const url = `${ctx.base}/subscriptions/${ctx.subscriptionId}/resourceGroups/${ctx.resourceGroup}/providers/${type}/${name}?api-version=${apiVersion}`;
  const res = await http("DELETE", url, undefined, signal);
  if (res.status === 404) return { type, name, deleted: false };
  if (res.status >= 300) throw new Error(`${type} ${name} delete failed (${res.status}): ${res.text}`);
  return { type, name, deleted: true };
}

/** A chant-owned live resource an owned-only prune could not delete, and why (#1457). */
export interface AzNotPrunable {
  type: string;
  name: string;
  /**
   * `no-api-version` — the resource is owned and undeclared, but its type is
   * absent from the current template, which is the only place an `apiVersion`
   * comes from. `deleteArmResource` cannot build a URL without one.
   */
  reason: "no-api-version";
}

/**
 * Owned-only prune: for each resource type present in the template, delete the
 * chant-owned live resources of that type whose (evaluated) name is not in the
 * template. Foreign (non-chant) resources are never touched.
 *
 * ## The type-left-the-template hole (#1457)
 *
 * `byType` is keyed off the resources the template CURRENTLY declares, and the
 * `!entry` guard skipped any live resource of a type the template no longer
 * mentions — before `isChantOwned` was ever consulted.
 *
 * So: declare one storage account, apply, then delete it from source. The
 * template now has zero resources of that type, `byType` has no entry, and the
 * live account is skipped. It is owned, it is undeclared, and prune would never
 * touch it — on that run or any future one. **Prune the last resource of a type
 * and you created a permanent orphan.** Prune one of several and it works,
 * which is why it survived testing.
 *
 * The guard cannot simply be removed: `deleteArmResource` needs an
 * `apiVersion`, and the template is the only source of one — ARM's
 * resource-group listing does not return it per resource. So the skip stays,
 * and is now REPORTED rather than silent: a permanent invisible orphan becomes
 * a permanent visible one, which is the difference between a bug and a known
 * limitation. Resolving it properly wants a per-type apiVersion source (the
 * provider metadata endpoint, or a lexicon-side map).
 *
 * This matters more since #1448, which routed `ApplyOp`'s `arm` target through
 * `azApply` — before that, the composite reached `--mode Complete` and never
 * came here at all.
 */
export async function pruneArmOrphans(
  desired: ArmResource[],
  ctx: ArmEvalCtx,
  http: AzHttp = defaultHttp,
  signal?: AbortSignal,
): Promise<{
  pruned: Array<{ type: string; name: string; deleted: boolean }>;
  notPrunable: AzNotPrunable[];
}> {
  const byType = new Map<string, { keep: Set<string>; apiVersion: string }>();
  for (const r of desired) {
    const name = String(await evalArmString(r.name, ctx));
    const entry = byType.get(r.type) ?? { keep: new Set<string>(), apiVersion: r.apiVersion };
    entry.keep.add(name);
    byType.set(r.type, entry);
  }

  const pruned: Array<{ type: string; name: string; deleted: boolean }> = [];
  const notPrunable: AzNotPrunable[] = [];
  for (const item of await listGroupResources(ctx, http, signal)) {
    // Ownership first, so a foreign resource never reaches the report either —
    // it is not an orphan chant failed to prune, it is simply not chant's.
    if (!isChantOwned(item.tags)) continue;
    const entry = byType.get(item.type);
    if (!entry) {
      console.log(
        `prune: ${item.type}/${item.name} is chant-owned and undeclared, but its type is absent ` +
          `from the template so no apiVersion is available — not deleted`,
      );
      notPrunable.push({ type: item.type, name: item.name, reason: "no-api-version" });
      continue;
    }
    if (entry.keep.has(item.name)) continue;
    safeHeartbeat({ step: "azPrune", type: item.type, name: item.name });
    const result = await deleteArmResource(item.type, item.name, entry.apiVersion, ctx, http, signal);
    console.log(`pruned: ${item.type}/${item.name} (${ctx.base})`);
    pruned.push(result);
  }
  return { pruned, notPrunable };
}

/**
 * The inverse of {@link azApply} — read a built ARM template and delete the
 * resources it declares, in reverse dependency order (a referrer goes before the
 * resource it references). Idempotent: already-absent resources are a no-op. The
 * Azure twin of `gcpDelete`; `http` is injectable for tests.
 */
export async function azDelete(
  args: AzApplyArgs,
  signal?: AbortSignal,
  http: AzHttp = defaultHttp,
): Promise<{ deleted: Array<{ type: string; name: string; deleted: boolean }> }> {
  const base = (args.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
  const ctx: ArmEvalCtx = {
    subscriptionId: args.subscriptionId ?? DEFAULT_SUBSCRIPTION,
    resourceGroup: args.resourceGroup,
    location: args.location ?? "eastus",
    deployed: new Map(),
    http,
    base,
    signal,
  };

  const template = JSON.parse(readFileSync(args.templatePath, "utf8")) as { resources?: ArmResource[] };
  const deleted: Array<{ type: string; name: string; deleted: boolean }> = [];
  for (const resource of orderArmResources(template.resources ?? []).reverse()) {
    const name = String(await evalArmString(resource.name, ctx));
    safeHeartbeat({ step: "azDelete", type: resource.type, name });
    const result = await deleteArmResource(resource.type, name, resource.apiVersion, ctx, http, signal);
    console.log(`${result.deleted ? "deleted" : "absent"}: ${resource.type}/${name} (${base})`);
    deleted.push(result);
  }
  return { deleted };
}
