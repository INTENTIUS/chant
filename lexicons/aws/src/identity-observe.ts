/**
 * The identity fallback on the stack read (#1647).
 *
 * `describeResources` asks CloudFormation exactly one question — is there a
 * logical id named <entity> in this stack? — which reads a freshly
 * carve-emitted, still-Terraform-owned resource as confirmed-absent even
 * though the declared `BucketName` names it precisely. When a declared entity
 * is absent from the stack AND its props spell the type's full primary
 * identifier (the spec knowledge the codegen already compiled into
 * `lexicon-aws.json`), ask Cloud Control for it by identity. Found means
 * OBSERVED: `ownership: "foreign"` (it exists and something other than this
 * stack owns it — Terraform, a console hand, another tool) and
 * `status: "EXTERNAL"` (live outside the stack, deliberately not a
 * CloudFormation status word).
 *
 * Best-effort ON TOP of a stack answer, never instead of one: a genuine miss
 * (`ResourceNotFoundException`) keeps the stack's absent verdict, and so does
 * every other refusal (`UnsupportedOperation` — a Floci without Cloud
 * Control — credentials, throttling). The stack read succeeded; absence at
 * stack scope is an honest verdict this fallback can refine but must never
 * degrade into a hole, or a pre-first-apply plan would stop proposing
 * `create` the moment the emulator lacks Cloud Control.
 */
import { createRequire } from "module";
import { AwsReadError, getResource, listResources, type AwsReadClientOptions, type CloudControlDescription } from "./api/read-client";
import type { ResourceMetadata } from "@intentius/chant/lexicon";

const require = createRequire(import.meta.url);

interface LexiconEntry {
  resourceType: string;
  kind: string;
  primaryIdentifier?: string[];
}

let byResourceType: Map<string, LexiconEntry> | undefined;
function manifestByType(): Map<string, LexiconEntry> {
  if (!byResourceType) {
    const manifest = require("./generated/lexicon-aws.json") as Record<string, LexiconEntry>;
    byResourceType = new Map(Object.values(manifest).map((e) => [e.resourceType, e]));
  }
  return byResourceType;
}

/**
 * The Cloud Control identifier the declared props spell, or undefined when the
 * type has no primary identifier on record or any part of it is absent or
 * non-scalar (a Ref, an intrinsic, a server-assigned name). Multi-part
 * identifiers join with `|`, Cloud Control's own separator.
 */
export function declaredIdentifier(entityType: string, props: Record<string, unknown>): string | undefined {
  const entry = manifestByType().get(entityType);
  const parts = entry?.primaryIdentifier;
  if (!entry || entry.kind !== "resource" || !parts || parts.length === 0) return undefined;
  const values: string[] = [];
  for (const part of parts) {
    const v = props[part];
    if (typeof v !== "string" && typeof v !== "number") return undefined;
    const s = String(v);
    if (!s) return undefined;
    values.push(s);
  }
  return values.join("|");
}

/**
 * `GetResource`, with a `ListResources` + identifier-match fallback when the
 * endpoint says the operation itself is unsupported. That is Floci's exact
 * answer (read-client's own note) while it serves `ListResources` fine — and
 * an emulator is exactly where the carve state lives, so without this leg the
 * fallback proves itself everywhere except the one place the walkthrough
 * films it. Every other refusal propagates: the caller decides what a failed
 * refinement means.
 */
async function readByIdentity(
  typeName: string,
  identifier: string,
  client: AwsReadClientOptions,
): Promise<CloudControlDescription | null> {
  try {
    return await getResource(typeName, identifier, client);
  } catch (err) {
    if (!(err instanceof AwsReadError) || err.code !== "UnsupportedOperation") throw err;
    const listed = await listResources(typeName, client);
    return listed.find((d) => d.identifier === identifier) ?? null;
  }
}

/** The same scrub the stack-output path applies, on live property KEYS. */
function redactSensitive(properties: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    out[key] = /password|secret|token/i.test(key) ? "[REDACTED]" : value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Identity-read every entity the stack did not answer for and whose props
 * spell an identifier. `already` is the stack's answer — an entity the stack
 * DID return is never re-read. The `queried` map records the address each
 * attempted read was issued against (#1620), whatever the verdict.
 */
export async function observeByIdentity(
  entityNames: string[],
  entities: Map<string, { entityType: string; props: Record<string, unknown> }> | undefined,
  already: Record<string, ResourceMetadata>,
  client: AwsReadClientOptions,
): Promise<{ resources: Record<string, ResourceMetadata>; queried: Record<string, string> }> {
  const resources: Record<string, ResourceMetadata> = {};
  const queried: Record<string, string> = {};
  if (!entities) return { resources, queried };
  for (const name of entityNames) {
    if (already[name]) continue;
    const entity = entities.get(name);
    if (!entity) continue;
    const identifier = declaredIdentifier(entity.entityType, entity.props ?? {});
    if (!identifier) continue;
    queried[name] = `cloudcontrol:GetResource:${entity.entityType}:${identifier}`;
    try {
      const found = await readByIdentity(entity.entityType, identifier, client);
      if (!found) continue;
      resources[name] = {
        type: entity.entityType,
        physicalId: found.identifier || identifier,
        status: "EXTERNAL",
        ownership: "foreign",
        ...(redactSensitive(found.properties) ? { attributes: redactSensitive(found.properties) } : {}),
      };
    } catch {
      // Refusals of every kind keep the stack's verdict — see the module
      // comment for why a failed refinement must not become a hole.
      continue;
    }
  }
  return { resources, queried };
}
