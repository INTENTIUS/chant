/**
 * Which resources the provider created, rather than anyone's infrastructure code.
 *
 * Every account arrives with resources nobody wrote: a default VPC and its
 * subnets, a default security group per VPC, a main route table, AWS-managed
 * KMS keys and IAM policies. They are yours to account for and were never
 * yours to declare, and until now chant recorded them looking exactly like
 * everything else.
 *
 * That matters wherever a question is about what you built. Asked which
 * security groups were unused, agents split three ways on the same correct set
 * of four — one excluded the three VPC defaults as "not real cleanup
 * candidates" and answered one, another counted something extra and answered
 * five. The answers that were accepted all did the same thing: listed all four
 * and said which were defaults. They could only do that by recognising them,
 * and chant gave them nothing to recognise them by.
 *
 * This records a fact and stops. `providerDefault: true` says the provider
 * created this; it does not say the resource is unused, safe to ignore, or
 * exempt from anything. Deciding that here would put a conclusion in an
 * observation — the mistake `liveInternetFacing` made and #1271 undid — and it
 * would be wrong in this very case, since the accepted answers count defaults
 * as unused.
 *
 * Almost none of this is chant's judgement. AWS marks these itself, on the same
 * payloads chant already reads; the fields were simply being dropped. The one
 * derivation is the security group, and it is safe because `default` is a
 * reserved group name — AWS rejects it on create, so a group called `default`
 * is that VPC's default group.
 */

import type { ResourceMetadata } from "@intentius/chant/lexicon";

type Attrs = Record<string, unknown>;

/**
 * Per kind, the provider's own marker. Extending this is the way to widen.
 *
 * Each predicate reads a field AWS already returns, so this is a passthrough
 * rather than a heuristic — a resource is a default because the provider says
 * so, not because it looks like one.
 */
const PROVIDER_DEFAULT: Record<string, (attrs: Attrs) => boolean> = {
  "AWS::EC2::VPC": (a) => a.IsDefault === true,
  "AWS::EC2::Subnet": (a) => a.DefaultForAz === true,
  "AWS::EC2::NetworkAcl": (a) => a.IsDefault === true,
  // `default` is a reserved group name: AWS refuses it on create, so a group
  // carrying it is the one AWS made with the VPC.
  "AWS::EC2::SecurityGroup": (a) => a.GroupName === "default",
  // The main route table is the one a subnet falls back to when it has no
  // explicit association — created with the VPC and not by anyone.
  "AWS::EC2::RouteTable": (a) =>
    Array.isArray(a.Associations) &&
    a.Associations.some((x) => (x as Attrs | null)?.Main === true),
  "AWS::KMS::Key": (a) => a.KeyManager === "AWS",
  "AWS::IAM::ManagedPolicy": (a) =>
    typeof a.Arn === "string" && a.Arn.startsWith("arn:aws:iam::aws:policy/"),
  "AWS::IAM::Policy": (a) =>
    typeof a.Arn === "string" && a.Arn.startsWith("arn:aws:iam::aws:policy/"),
};

/** True when this lexicon can tell whether the kind is a provider default. */
export function canDetectDefault(kind: string): boolean {
  return kind in PROVIDER_DEFAULT;
}

/** The kinds whose provider-default status this lexicon can report. */
export const DEFAULT_AWARE_KINDS: string[] = Object.keys(PROVIDER_DEFAULT);

/**
 * Mark the resources the provider created.
 *
 * Only ever sets the attribute to `true`, and only for kinds with a known
 * marker: absent means "not a default, or chant cannot tell", and those are
 * genuinely different from each other in a way a blanket `false` would hide.
 */
export function stampProviderDefaults(
  resources: Record<string, ResourceMetadata>,
): Record<string, ResourceMetadata> {
  const stamped: Record<string, ResourceMetadata> = {};
  for (const [name, meta] of Object.entries(resources)) {
    const test = PROVIDER_DEFAULT[meta.type];
    const attrs = (meta.attributes ?? {}) as Attrs;
    let isDefault = false;
    try {
      isDefault = test ? test(attrs) : false;
    } catch {
      // A malformed payload is not a default; it is a payload chant could not
      // read, and the rest of the observation is still good.
      isDefault = false;
    }
    stamped[name] = isDefault
      ? { ...meta, attributes: { ...attrs, providerDefault: true } }
      : meta;
  }
  return stamped;
}
