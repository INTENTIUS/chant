/**
 * AWS governance authoring (#791, epic #787 C1): the desired-state config
 * shape the AWS cloud warden (#792) reconciles, and `landingZoneConfig()` —
 * the typed authoring layer that emits it.
 *
 * This is deliberately NOT a composite. The evaluability rules (EVL002/004,
 * #916/#952) require composites to declare a fixed set of resources, so a
 * data-driven OU tree walker cannot be one. The split mirrors the SCM
 * wardens: authoring emits config (this module, arbitrary cardinality);
 * resources for greenfield bootstrap are the fixed-shape composites in
 * `composites/landing-zone.ts`; the warden consumes only the config.
 *
 * GCP (Folder/OrgPolicy/AuditConfig) and Azure (blocked on #1545)
 * counterparts are tracked as #791 follow-ups.
 */

// ---------------------------------------------------------------------------
// The desired-state config shape the AWS cloud warden consumes (#792)
// ---------------------------------------------------------------------------

/** An SCP definition, keyed by name in `AwsGovernanceConfig.scps`. */
export interface ScpConfig {
  description?: string;
  /** The policy document (SCP JSON). */
  document: Record<string, unknown>;
}

/** A member account declared inside an OU. */
export interface AccountConfig {
  name: string;
  email: string;
}

/** One OU: its guardrails, accounts, and child OUs, keyed by OU name. */
export interface OuConfig {
  /** Names of SCPs (from `scps`) attached to this OU. */
  scps?: string[];
  accounts?: AccountConfig[];
  children?: Record<string, OuConfig>;
}

/**
 * The desired-state governance tree for one AWS organization. This is the
 * shape `wardens/aws` (#792) loads as config — the AWS counterpart of the
 * SCM wardens' GovernanceConfig. Cycles map onto the governance verbs
 * (#790): the OU/account tree is `org-unit`, SCPs are `policy-guardrail`,
 * audit sinks are `audit-sink`.
 */
export interface AwsGovernanceConfig {
  organization: {
    /** SCP names attached at the organization root. */
    scps?: string[];
  };
  /** Top-level OUs under the root, keyed by OU name. */
  ous: Record<string, OuConfig>;
  /** SCP definitions, keyed by the names the tree attaches. */
  scps: Record<string, ScpConfig>;
  /** Where audit evidence flows. */
  auditSinks?: {
    cloudtrail?: { bucket: string; multiRegion: boolean };
  };
}

// ---------------------------------------------------------------------------
// Baseline guardrails (shared with the bootstrap composites)
// ---------------------------------------------------------------------------

export const DENY_LEAVE_ORGANIZATION: ScpConfig = {
  description: "Member accounts may not remove themselves from the organization.",
  document: {
    Version: "2012-10-17",
    Statement: [{ Effect: "Deny", Action: "organizations:LeaveOrganization", Resource: "*" }],
  },
};

export const DENY_AUDIT_TAMPER: ScpConfig = {
  description: "Audit trails and recorders cannot be stopped or deleted from member accounts.",
  document: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Deny",
        Action: [
          "cloudtrail:StopLogging",
          "cloudtrail:DeleteTrail",
          "config:StopConfigurationRecorder",
          "config:DeleteConfigurationRecorder",
          "config:DeleteDeliveryChannel",
        ],
        Resource: "*",
      },
    ],
  },
};

/** Deny requests outside `regions`, excepting global services. */
export function regionRestriction(regions: readonly string[]): ScpConfig {
  return {
    description: `Deny requests outside [${regions.join(", ")}] except global services.`,
    document: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Deny",
          NotAction: [
            "iam:*",
            "organizations:*",
            "route53:*",
            "cloudfront:*",
            "sts:*",
            "support:*",
            "budgets:*",
          ],
          Resource: "*",
          Condition: { StringNotEquals: { "aws:RequestedRegion": regions } },
        },
      ],
    },
  };
}

/**
 * The recommended foundation OU structure. Exported so callers can extend it
 * rather than restate it.
 */
export const FOUNDATION_OUS: Record<string, OuConfig> = {
  Security: { scps: ["deny-audit-tamper"] },
  Infrastructure: {},
  Sandbox: {},
  Workloads: {},
};

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

export interface LandingZoneConfigProps {
  /**
   * Start from the recommended foundation: Security / Infrastructure /
   * Sandbox / Workloads OUs, `deny-leave-organization` at the root, and
   * `deny-audit-tamper` on Security. Default true; your `ous`/`scps` merge
   * over it (same-name keys win).
   */
  foundation?: boolean;
  /** Adds a region-restriction SCP at the root allowing only these regions. */
  allowedRegions?: string[];
  /** OU tree, merged over the foundation's. Greenfield (full tree) and brownfield (partial subtree) are both just this map. */
  ous?: Record<string, OuConfig>;
  /** SCP definitions, merged over the foundation's. */
  scps?: Record<string, ScpConfig>;
  /** Extra SCP names to attach at the organization root. */
  rootScps?: string[];
  /** Declare an organization CloudTrail flowing into this bucket. */
  cloudtrailBucket?: string;
}

/**
 * Author the desired-state tree the AWS cloud warden (#792) reconciles.
 * Pure. Throws when the tree attaches an SCP name with no definition; only
 * SCPs the tree actually attaches are included in the output.
 */
export function landingZoneConfig(props: LandingZoneConfigProps = {}): AwsGovernanceConfig {
  const foundation = props.foundation ?? true;
  const scps: Record<string, ScpConfig> = {
    ...(foundation
      ? { "deny-leave-organization": DENY_LEAVE_ORGANIZATION, "deny-audit-tamper": DENY_AUDIT_TAMPER }
      : {}),
    ...(props.allowedRegions?.length ? { "region-restriction": regionRestriction(props.allowedRegions) } : {}),
    ...props.scps,
  };
  const ous = { ...(foundation ? FOUNDATION_OUS : {}), ...props.ous };
  const rootScps = [
    ...(foundation ? ["deny-leave-organization"] : []),
    ...(props.allowedRegions?.length ? ["region-restriction"] : []),
    ...(props.rootScps ?? []),
  ];

  const attached = new Set(rootScps);
  const collect = (tree: Record<string, OuConfig>): void => {
    for (const node of Object.values(tree)) {
      for (const s of node.scps ?? []) attached.add(s);
      if (node.children) collect(node.children);
    }
  };
  collect(ous);
  for (const name of attached) {
    if (!scps[name]) throw new Error(`landingZoneConfig: SCP "${name}" is attached but not defined in scps`);
  }

  return {
    organization: rootScps.length ? { scps: rootScps } : {},
    ous,
    scps: Object.fromEntries(Object.entries(scps).filter(([n]) => attached.has(n))),
    ...(props.cloudtrailBucket
      ? { auditSinks: { cloudtrail: { bucket: props.cloudtrailBucket, multiRegion: true } } }
      : {}),
  };
}
