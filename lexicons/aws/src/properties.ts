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
 * are kept — they were the only attributes for a long time and queries lean on
 * them — but a resource's own properties win a name collision, because they are
 * the resource's.
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

/**
 * Merge each resource's own properties into an observation, in place of nothing.
 *
 * Best-effort per kind, and per kind only: an endpoint that cannot answer
 * `describe-subnets` still yields instance properties, and a total failure
 * leaves the observation exactly as it arrived. The managed observation is
 * already complete without any of this — these are additional facts about
 * resources chant has already identified, so a miss costs detail, never
 * correctness.
 */
export async function describeOwnProperties(
  resources: Record<string, ResourceMetadata>,
  region?: string,
): Promise<Record<string, ResourceMetadata>> {
  // Group the physical ids to look up by kind, so each kind is one call.
  const wanted = new Map<string, Map<string, string[]>>();
  for (const [name, meta] of Object.entries(resources)) {
    if (!meta.physicalId || !canDescribe(meta.type)) continue;
    const byId = wanted.get(meta.type) ?? new Map<string, string[]>();
    byId.set(meta.physicalId, [...(byId.get(meta.physicalId) ?? []), name]);
    wanted.set(meta.type, byId);
  }
  if (wanted.size === 0) return resources;

  const { getRuntime } = await import("@intentius/chant/runtime-adapter");
  const rt = getRuntime();
  const regionArgs = region ? ["--region", region] : [];
  const merged = { ...resources };

  /** One describe for a set of ids. `null` when the call itself failed. */
  const read = async (spec: (typeof DESCRIBE)[string], ids: string[]) => {
    const result = await rt.spawn(
      applyAwsEndpointArgv(
        ["aws", ...spec.argv, spec.idFlag, ...ids, ...regionArgs, "--output", "json"],
        process.env.AWS_ENDPOINT_URL,
      ),
    );
    if (result.exitCode !== 0) return null;
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
        top = [];
        for (const id of ids) top.push(...((await read(spec, [id])) ?? []));
      }
      if (top === null) continue;
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
            // Own properties last: a resource's `VpcId` outranks a stack output
            // that happens to share the name.
            attributes: { ...(merged[name].attributes ?? {}), ...row },
          };
        }
      }
    } catch {
      continue;
    }
  }
  return merged;
}
