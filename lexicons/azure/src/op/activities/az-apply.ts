import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { safeHeartbeat } from "@intentius/chant/op";

// The floci-az default local subscription (from its ARM management-plane mock).
const DEFAULT_SUBSCRIPTION = "00000000-0000-0000-0000-000000000001";
const DEFAULT_ENDPOINT = "https://management.azure.com";

/** Context for evaluating the ARM template expressions chant emits. */
export interface ArmContext {
  subscriptionId: string;
  resourceGroup: string;
  location: string;
}

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
}

// ── ARM expression evaluation (the subset chant emits) ────────────────────────

/**
 * Evaluate an ARM template expression string (`"[...]"`). Supports the functions
 * chant's serializer emits: `concat`, `uniqueString`, `resourceGroup()` (`.id` /
 * `.location`), `subscription()` (`.subscriptionId`), and string literals. A
 * non-expression string is returned unchanged. Pure.
 */
export function evalArmString(s: string, ctx: ArmContext): string {
  if (!(s.startsWith("[") && s.endsWith("]"))) return s;
  // "[[" is an escaped literal "[".
  if (s.startsWith("[[")) return s.slice(1);
  return String(new ArmExpr(s.slice(1, -1), ctx).parse());
}

/** Recursively evaluate every string in a value against the ARM context. Pure. */
export function evalArm(value: unknown, ctx: ArmContext): unknown {
  if (typeof value === "string") return evalArmString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => evalArm(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = evalArm(v, ctx);
    return out;
  }
  return value;
}

/** Minimal recursive-descent evaluator for the ARM function subset. */
class ArmExpr {
  private i = 0;
  constructor(private readonly src: string, private readonly ctx: ArmContext) {}

  parse(): unknown {
    const v = this.expr();
    return v;
  }

  private expr(): unknown {
    this.ws();
    let v: unknown;
    if (this.src[this.i] === "'") {
      v = this.stringLiteral();
    } else {
      v = this.call();
    }
    // Property access: resourceGroup().location, subscription().subscriptionId
    while (this.peek() === ".") {
      this.i++;
      const prop = this.ident();
      v = (v as Record<string, unknown>)?.[prop];
    }
    return v;
  }

  private call(): unknown {
    const name = this.ident();
    this.ws();
    const args: unknown[] = [];
    if (this.peek() === "(") {
      this.i++;
      this.ws();
      if (this.peek() !== ")") {
        args.push(this.expr());
        this.ws();
        while (this.peek() === ",") {
          this.i++;
          args.push(this.expr());
          this.ws();
        }
      }
      if (this.peek() === ")") this.i++;
    }
    return this.applyFn(name, args);
  }

  private applyFn(name: string, args: unknown[]): unknown {
    switch (name) {
      case "concat":
        return args.map(String).join("");
      case "uniqueString":
        return createHash("sha256").update(args.map(String).join("-")).digest("hex").slice(0, 13);
      case "resourceGroup":
        return { location: this.ctx.location, id: `/subscriptions/${this.ctx.subscriptionId}/resourceGroups/${this.ctx.resourceGroup}`, name: this.ctx.resourceGroup };
      case "subscription":
        return { subscriptionId: this.ctx.subscriptionId, id: `/subscriptions/${this.ctx.subscriptionId}` };
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

  private ws(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }

  private peek(): string {
    this.ws();
    return this.src[this.i];
  }
}

// ── HTTP + apply ──────────────────────────────────────────────────────────────

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

/** The ARM resource-ID PUT URL for a resource under a resource group. Pure. */
export function armResourceUrl(resource: ArmResource, ctx: ArmContext, base: string): string {
  const name = evalArmString(resource.name, ctx);
  return `${base}/subscriptions/${ctx.subscriptionId}/resourceGroups/${ctx.resourceGroup}/providers/${resource.type}/${name}?api-version=${resource.apiVersion}`;
}

/** The ARM resource PUT body (location/properties/sku/kind/tags), expressions evaluated. Pure. */
export function armResourceBody(resource: ArmResource, ctx: ArmContext): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (resource.location) body.location = evalArmString(resource.location, ctx);
  if (resource.properties !== undefined) body.properties = evalArm(resource.properties, ctx);
  if (resource.sku !== undefined) body.sku = evalArm(resource.sku, ctx);
  if (resource.kind !== undefined) body.kind = resource.kind;
  if (resource.tags !== undefined) body.tags = resource.tags;
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
 * directly to the ARM resource-CRUD API, resolving ARM expressions first. This
 * is the direct-apply path (the Azure twin of `gcpApply`): it targets floci-az's
 * ARM resource endpoints — which `az deployment` cannot, since floci-az has no
 * `Microsoft.Resources/deployments` provider — or real Azure by endpoint override.
 * The resource group is ensured first. `http` is injectable for tests.
 */
export async function azApply(
  args: AzApplyArgs,
  signal?: AbortSignal,
  http: AzHttp = defaultHttp,
): Promise<{ applied: Array<{ type: string; name: string }> }> {
  const base = (args.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, "");
  const ctx: ArmContext = {
    subscriptionId: args.subscriptionId ?? DEFAULT_SUBSCRIPTION,
    resourceGroup: args.resourceGroup,
    location: args.location ?? "eastus",
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
  for (const resource of template.resources ?? []) {
    const name = evalArmString(resource.name, ctx);
    safeHeartbeat({ step: "azApply", type: resource.type, name });
    const res = await http("PUT", armResourceUrl(resource, ctx, base), armResourceBody(resource, ctx), signal);
    if (res.status >= 300) {
      throw new Error(`${resource.type} ${name} apply failed (${res.status}): ${res.text}`);
    }
    console.log(`applied: ${resource.type}/${name} (${base})`);
    applied.push({ type: resource.type, name });
  }
  return { applied };
}
