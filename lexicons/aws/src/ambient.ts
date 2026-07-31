/**
 * Resources that are simply *there* (#1278).
 *
 * `describeResources` answers "what do I manage" and `observeDependencies`
 * answers "what do I rely on". Both resolve outward from the declared estate,
 * so neither can see a resource nothing points at — and "which of my security
 * groups are unused" is precisely a question about resources nothing points at.
 *
 * A state file cannot answer this at all: it knows what it created, and an
 * unused resource is by definition not something it created and attached. A
 * lexicon that can enumerate a kind can.
 *
 * Bounded by the kinds the project declares. A project managing security groups
 * is asked about security groups, not about the account.
 */

import { applyAwsEndpointArgv } from "./components/cloud-executor";
import type { ResourceMetadata } from "@intentius/chant/lexicon";

/** Enumerable kinds, and how to list them. Extending this is the way to widen. */
const ENUMERABLE: Record<string, { argv: string[]; key: string; id: string; name?: string }> = {
  "AWS::EC2::SecurityGroup": {
    argv: ["ec2", "describe-security-groups"],
    key: "SecurityGroups",
    id: "GroupId",
    name: "GroupName",
  },
  // The account's default VPC is the archetype: nothing declares it, nothing
  // in the declared estate points at it, and "which instances are outside a
  // default VPC" cannot be answered without it.
  "AWS::EC2::VPC": {
    argv: ["ec2", "describe-vpcs"],
    key: "Vpcs",
    id: "VpcId",
  },
  // Nobody writes a network interface: EC2 creates one per instance. But the
  // ENI is where a security group is actually attached, so "which of my
  // security groups are unused" is an ENI question and cannot be answered
  // without them. Asked exactly that, an agent queried
  // `kind:EC2::NetworkInterface`, got nothing, and rebuilt the attachment map
  // by hand from twenty-nine raw provider calls.
  "AWS::EC2::NetworkInterface": {
    argv: ["ec2", "describe-network-interfaces"],
    key: "NetworkInterfaces",
    id: "NetworkInterfaceId",
  },
};

/**
 * Kinds a declared kind implies, though nobody writes them.
 *
 * The scan is bounded by what the project declares — a project managing
 * security groups is asked about security groups, not about the account. That
 * bound is right, and it excluded exactly the resource that answers the
 * question: EC2 creates a network interface per instance, and the ENI is where
 * a security group is actually attached. So an estate full of instances had no
 * ENIs recorded, and "which of my security groups are unused" — definitionally
 * an ENI question — could not be answered from the snapshot at all.
 *
 * Declaring an instance is declaring its network interface. This widens the
 * bound by implication rather than abandoning it: still nothing about the
 * account at large.
 */
const IMPLIED: Record<string, string[]> = {
  "AWS::EC2::Instance": ["AWS::EC2::NetworkInterface"],
};

/** The requested kinds, plus the ones they imply. */
export function withImplied(kinds: string[]): string[] {
  return [...new Set(kinds.flatMap((k) => [k, ...(IMPLIED[k] ?? [])]))];
}

/** The kinds this reader can enumerate. Declared so a caller can mention
 * `--ambient` without paying for a scan to discover it is relevant. */
export const AMBIENT_KINDS: string[] = Object.keys(ENUMERABLE);

/** True when this lexicon can enumerate the kind, so a caller can say what it skipped. */
export function canEnumerate(kind: string): boolean {
  return kind in ENUMERABLE;
}

/**
 * List resources of the declared kinds that exist in the account but are
 * neither managed nor already observed.
 *
 * Attachment is deliberately NOT decided here. Whether a security group is
 * "unused" is a graph question — does anything reference it — and the graph
 * answers it once the group is a node. Deciding it in the reader would put a
 * conclusion in the observation, which is the mistake `liveInternetFacing` made
 * and #1271 undid.
 */
export async function observeAwsAmbient(options: {
  kinds: string[];
  observed: Record<string, ResourceMetadata>;
  region?: string;
}): Promise<Record<string, ResourceMetadata>> {
  const kinds = withImplied(options.kinds).filter(canEnumerate);
  if (kinds.length === 0) return {};

  const { getRuntime } = await import("@intentius/chant/runtime-adapter");
  const rt = getRuntime();
  const regionArgs = options.region ? ["--region", options.region] : [];

  // Physical ids already accounted for, so a managed resource is never also
  // reported as ambient.
  const known = new Set(
    Object.values(options.observed)
      .map((m) => m.physicalId)
      .filter((id): id is string => typeof id === "string"),
  );

  const ambient: Record<string, ResourceMetadata> = {};
  for (const kind of kinds) {
    const spec = ENUMERABLE[kind];
    try {
      const result = await rt.spawn(
        applyAwsEndpointArgv(["aws", ...spec.argv, ...regionArgs, "--output", "json"], process.env.AWS_ENDPOINT_URL),
      );
      if (result.exitCode !== 0) continue;
      const rows = (JSON.parse(result.stdout)[spec.key] ?? []) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const id = row[spec.id];
        if (typeof id !== "string" || known.has(id)) continue;
        ambient[id] = {
          type: kind,
          status: "OBSERVED",
          physicalId: id,
          // The whole payload, so the graph can decide what "unused" means
          // rather than the reader pre-deciding it.
          attributes: row,
          ownership: "foreign",
          ambient: true,
        };
      }
    } catch {
      // Best-effort per kind: one unreadable kind does not sink the others, and
      // the managed observation is already complete without any of this.
      continue;
    }
  }
  // Same stamps the managed path applies, so one query shape works across both
  // (#1279). Defaults matter most here: a default VPC or security group is
  // ambient by definition — nobody declared it.
  const { stampRegion } = await import("./properties");
  const { stampProviderDefaults } = await import("./defaults");
  return stampProviderDefaults(stampRegion(ambient, options.region));
}
