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
): Promise<{ applied: Array<{ type: string; name: string }> }> {
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
  const applied: Array<{ type: string; name: string }> = [];
  for (const resource of orderArmResources(template.resources ?? [])) {
    const name = String(await evalArmString(resource.name, ctx));
    safeHeartbeat({ step: "azApply", type: resource.type, name });
    const res = await http("PUT", await armResourceUrl(resource, ctx), await armResourceBody(resource, ctx), signal);
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
  return { applied };
}
