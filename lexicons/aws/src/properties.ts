/**
 * A managed resource's own properties (#1279).
 *
 * `describe-stack-resources` returns identity and status — logical id, physical
 * id, type, timestamp — and nothing about the resource itself. So the managed
 * observation filled `attributes` with the *stack's* outputs instead, copied
 * onto every resource in the stack. Every node in a stack came out carrying the
 * same `expVpcId`/`expWebIp` keys, and no node carried its own `VpcId`.
 *
 * That is invisible until something asks. `search --show VpcId` printed a blank
 * column for six instances, which reads as "the estate has no VPCs" rather than
 * "chant never read that". An agent asked which instances were outside the
 * default VPC concluded all six were, because nothing in the graph said
 * otherwise.
 *
 * A deep read (Cloud Control) answers this properly but is a per-resource call
 * and is not available on every endpoint. This is the cheap middle: one describe
 * per kind for the whole observation, joined back by physical id. Stack outputs
 * no longer ride the resource at all — they are the stack's, and travel on the
 * observation envelope's `stackExports`. Whatever a resource already carries is
 * kept underneath its own properties, which win a name collision because they
 * are the resource's.
 */

import { applyAwsEndpointArgv } from "./components/cloud-executor";
import type { ResourceMetadata } from "@intentius/chant/lexicon";

/**
 * How to read each kind in bulk, and which field joins back to the physical id.
 *
 * Extending this is the way to widen coverage. Deliberately batch calls: one
 * `describe-instances` for every instance in the stack, not one per instance.
 */
const DESCRIBE: Record<
  string,
  { argv: string[]; idFlag: string; key: string; id: string; nested?: string }
> = {
  "AWS::EC2::Instance": {
    argv: ["ec2", "describe-instances"],
    idFlag: "--instance-ids",
    key: "Reservations",
    nested: "Instances",
    id: "InstanceId",
  },
  "AWS::EC2::VPC": { argv: ["ec2", "describe-vpcs"], idFlag: "--vpc-ids", key: "Vpcs", id: "VpcId" },
  "AWS::EC2::Subnet": {
    argv: ["ec2", "describe-subnets"],
    idFlag: "--subnet-ids",
    key: "Subnets",
    id: "SubnetId",
  },
  "AWS::EC2::SecurityGroup": {
    argv: ["ec2", "describe-security-groups"],
    idFlag: "--group-ids",
    key: "SecurityGroups",
    id: "GroupId",
  },
};

/**
 * Stamp the region each resource was observed in (#1279).
 *
 * The observation is already scoped per stack and each stack declares its
 * region, so the reader knows this and was throwing it away. Without it the
 * only route to "which region is this in" was parsing
 * `Placement.AvailabilityZone` and trimming the last character — a trick that
 * happens to work for EC2 and for nothing else. Region is a dimension of the
 * estate, not a substring of an availability zone.
 */
export function stampRegion(
  resources: Record<string, ResourceMetadata>,
  region?: string,
): Record<string, ResourceMetadata> {
  // Fall back to the region the call would actually have used, so a
  // single-region project gets the same attribute a multi-region one does.
  const value = region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!value) return resources;
  const stamped: Record<string, ResourceMetadata> = {};
  for (const [name, meta] of Object.entries(resources)) {
    stamped[name] = { ...meta, attributes: { ...(meta.attributes ?? {}), region: value } };
  }
  return stamped;
}

/** True when this lexicon can read the kind's own properties. */
export function canDescribe(kind: string): boolean {
  return kind in DESCRIBE;
}

/** What an enrichment pass managed to do, so a caller can tell a miss from a no-op. */
export interface OwnPropertiesResult {
  resources: Record<string, ResourceMetadata>;
  /**
   * True when enrichment was attempted and *every* kind's read failed — the
   * transport is unavailable rather than the account being quiet. Callers must
   * not present the result as a complete observation (#1089).
   */
  transportFailed: boolean;
  /** Why each failed kind failed, keyed by CloudFormation type, so a caller can attribute per resource. */
  failures: Map<string, string>;
}

/**
 * Merge each resource's own properties into an observation, in place of nothing.
 *
 * Best-effort per kind: an endpoint that cannot answer `describe-subnets` still
 * yields instance properties. A miss costs detail — with one exception that used
 * to be silent and is now reported.
 *
 * The exception (#1206): these attributes are compared by `lifecycle diff`, so a
 * read that fails after the resource is already identified does not degrade to
 * "less detail", it degrades to *drift* — the snapshot has `GroupId`, the live
 * read has nothing, and the differ reports the property as removed. A partial
 * failure still rides the best-effort path, but a total one is a hole the caller
 * has to declare rather than a thinner set of facts.
 */
export async function describeOwnProperties(
  resources: Record<string, ResourceMetadata>,
  region?: string,
): Promise<OwnPropertiesResult> {
  // Group the physical ids to look up by kind, so each kind is one call.
  const wanted = new Map<string, Map<string, string[]>>();
  for (const [name, meta] of Object.entries(resources)) {
    if (!meta.physicalId || !canDescribe(meta.type)) continue;
    const byId = wanted.get(meta.type) ?? new Map<string, string[]>();
    byId.set(meta.physicalId, [...(byId.get(meta.physicalId) ?? []), name]);
    wanted.set(meta.type, byId);
  }
  if (wanted.size === 0) return { resources, transportFailed: false, failures: new Map() };

  const { getRuntime } = await import("@intentius/chant/runtime-adapter");
  const rt = getRuntime();
  const regionArgs = region ? ["--region", region] : [];
  const merged = { ...resources };
  const failures = new Map<string, string>();
  /** The last failure for a kind, phrased for a human — stderr when there is any, the exit status otherwise. */
  let lastReason = "";

  /** One describe for a set of ids. `null` when the call itself failed. */
  const read = async (spec: (typeof DESCRIBE)[string], ids: string[]) => {
    const argv = ["aws", ...spec.argv, spec.idFlag, ...ids, ...regionArgs, "--output", "json"];
    const result = await rt.spawn(applyAwsEndpointArgv(argv, process.env.AWS_ENDPOINT_URL));
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim().split("\n")[0];
      lastReason = `${spec.argv.join(" ")} failed${stderr ? `: ${stderr}` : ` (${result.exitCode})`}`;
      return null;
    }
    return (JSON.parse(result.stdout)[spec.key] ?? []) as Array<Record<string, unknown>>;
  };

  for (const [kind, byId] of wanted) {
    const spec = DESCRIBE[kind];
    try {
      const ids = [...byId.keys()];
      let top = await read(spec, ids);
      // AWS fails the whole call on one bad id — a snapshot naming an instance
      // that has since been terminated takes every other instance's properties
      // down with it, and the result is indistinguishable from "the account has
      // nothing to say". Retry one at a time so the damage stops at the bad id.
      if (top === null && ids.length > 1) {
        const perId = await Promise.all(ids.map((id) => read(spec, [id])));
        // Every retry failing is the kind failing, not the kind being empty —
        // the distinction the old `top = []` erased.
        top = perId.every((r) => r === null) ? null : perId.flatMap((r) => r ?? []);
      }
      if (top === null) {
        failures.set(kind, lastReason);
        continue;
      }
      // `describe-instances` buries instances one level down under reservations;
      // the others return the resources directly.
      const rows = spec.nested
        ? top.flatMap((r) => (r[spec.nested as string] ?? []) as Array<Record<string, unknown>>)
        : top;
      for (const row of rows) {
        const id = row[spec.id];
        if (typeof id !== "string") continue;
        for (const name of byId.get(id) ?? []) {
          merged[name] = {
            ...merged[name],
            // Own properties last: a resource's `VpcId` outranks anything the
            // entry already carried under the same name.
            attributes: { ...(merged[name].attributes ?? {}), ...row },
          };
        }
      }
    } catch (err) {
      failures.set(kind, `${spec.argv.join(" ")} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { resources: merged, transportFailed: failures.size === wanted.size, failures };
}
