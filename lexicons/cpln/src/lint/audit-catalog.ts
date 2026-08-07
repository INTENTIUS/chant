/**
 * The cpln lexicon's `chant audit` catalog — metadata for every CPL check.
 *
 * Every entry carries `yamlBased: false`. That is not an oversight: all of
 * cpln's checks read the chant model (`ctx.entities`) rather than the emitted
 * manifests (`ctx.outputs`), because the facts they need — which GVC a workload
 * is placed in, which volume set a mount names, whether a policy principal is
 * GVC-qualified — are relationships between declared resources rather than text
 * in one document. They fire on `chant build` and cannot fire on an audit of
 * standalone cpln YAML. `auditRule()` hardcodes `yamlBased: true`, so these are
 * constructed directly.
 *
 * A test asserts this catalog covers every check the plugin registers, so a
 * check added without an entry here fails the build rather than contributing
 * nothing to `chant audit` silently.
 */

import type { Authority, RuleMeta } from "@intentius/chant/audit/catalog";

// ── Authorities ────────────────────────────────────────────────────

const CPLN_WORKLOAD: Authority = {
  name: "Control Plane — Workload reference",
  url: "https://docs.controlplane.com/reference/workload",
};
const CPLN_SECRETS: Authority = {
  name: "Control Plane — Secret access model",
  url: "https://docs.controlplane.com/reference/secret",
};
const CPLN_POLICY: Authority = {
  name: "Control Plane — Policy reference",
  url: "https://docs.controlplane.com/reference/policy",
};

/**
 * An entry with no external citation.
 *
 * Deliberately unable to take one. Core asserts two invariants over the
 * aggregated catalog — an authority citation always means `security`, and it
 * only attaches to `merge-worthy` — so a citation is not decoration, it is a
 * claim about the finding's weight. Splitting the constructors makes the pair
 * unviolatable here rather than caught later by core's test.
 */
function rule(
  id: string,
  tier: RuleMeta["tier"],
  category: RuleMeta["category"],
  title: string,
  remediation: string,
): RuleMeta {
  return { id, tier, fixKind: "guidance", category, title, remediation, yamlBased: false };
}

/**
 * A merge-worthy security entry, which is the only kind that may cite an
 * authority. The tier and category are not parameters because there is only
 * one legal combination.
 */
function securityRule(id: string, title: string, remediation: string, authority: Authority[]): RuleMeta {
  return {
    id,
    tier: "merge-worthy",
    fixKind: "guidance",
    category: "security",
    title,
    remediation,
    authority,
    yamlBased: false,
  };
}

export const cplnAuditCatalog: Record<string, RuleMeta> = {
  // ── Source-level rules ───────────────────────────────────────────
  CPL001: securityRule(
    "CPL001",
    "Literal credential in a cpln declaration",
    "Store the value as a Secret and reference it as cpln://secret/NAME.FIELD.",
    [CPLN_SECRETS],
  ),
  CPL002: rule(
    "CPL002",
    "report-only",
    "best-practice",
    "Hand-written Control Plane link where a resource reference would do",
    "Pass the declared resource; the serializer emits the correct link, GVC qualifier included.",
  ),

  // ── Security ─────────────────────────────────────────────────────
  CPL010: securityRule(
    "CPL010",
    "Workload allows outbound traffic to every address",
    "Narrow outboundAllowCIDR, or use outboundAllowHostname with wildcards.",
    [CPLN_WORKLOAD],
  ),
  CPL011: rule(
    "CPL011",
    "report-only",
    "security",
    "Internal firewall opened to the whole org",
    'Prefer "same-gvc", or "workload-list" naming the specific workloads.',
  ),
  CPL012: securityRule(
    "CPL012",
    "Credential-shaped environment variable set to a literal",
    "Reference a secret: cpln://secret/NAME.FIELD.",
    [CPLN_SECRETS],
  ),
  CPL013: securityRule(
    "CPL013",
    "Policy binds an identity by its unqualified link",
    "Use //gvc/<gvc>/identity/<name>; the bare //identity/<name> form is silently ignored.",
    [CPLN_POLICY],
  ),
  CPL014: rule(
    "CPL014",
    "merge-worthy",
    "correctness",
    "Secret reference names no field",
    "Qualify the reference: cpln://secret/NAME.payload, .username, .cert, or a dictionary key.",
  ),

  // ── Correctness ──────────────────────────────────────────────────
  CPL020: rule(
    "CPL020",
    "merge-worthy",
    "correctness",
    "Serverless workload does not expose exactly one HTTP port",
    "Expose exactly one http/http2 port, or change the workload to type standard.",
  ),
  CPL021: rule(
    "CPL021",
    "merge-worthy",
    "correctness",
    "Cron workload shape is invalid",
    "Cron requires spec.job.schedule and must expose no ports; no other type may set spec.job.",
  ),
  CPL022: rule(
    "CPL022",
    "merge-worthy",
    "correctness",
    "Container ports conflict",
    "Use `ports` rather than `port`, and keep port numbers unique across a workload's containers.",
  ),
  CPL023: rule(
    "CPL023",
    "merge-worthy",
    "correctness",
    "Container resources violate a platform floor or the memory-to-CPU ratio",
    "CPU ≥ 25m, memory ≥ 32Mi, and memory(MiB)/cpu(m) ≤ 8 — or add the cpln/relaxMemoryToCpuRatio tag.",
  ),
  CPL024: rule(
    "CPL024",
    "merge-worthy",
    "correctness",
    "Health-check probe sets no handler, or more than one",
    "Set exactly one of exec, grpc, tcpSocket, httpGet per probe.",
  ),
  CPL025: rule(
    "CPL025",
    "merge-worthy",
    "correctness",
    "Autoscaling configuration is not a valid combination",
    "`metric` and `multi` are exclusive; `target` belongs to the single-metric form and caps at 100 for cpu/memory.",
  ),
  CPL026: rule(
    "CPL026",
    "merge-worthy",
    "correctness",
    "minScale 0 with a strategy that cannot scale to zero",
    "Serverless needs rps or concurrency; standard and stateful need KEDA, enabled at the GVC.",
  ),
  CPL027: rule(
    "CPL027",
    "merge-worthy",
    "correctness",
    "Capacity AI combined with a feature it excludes",
    "Set defaultOptions.capacityAI false, or drop the CPU-utilization scaling, multi-metric scaling, or GPU.",
  ),
  CPL028: rule(
    "CPL028",
    "merge-worthy",
    "correctness",
    "Volume set capacity, filesystem binding, or mount paths are invalid",
    "Clear the performance-class capacity floor, mount ext4/xfs only from stateful workloads, and keep mount paths disjoint.",
  ),
  CPL029: rule(
    "CPL029",
    "merge-worthy",
    "correctness",
    "Control Plane link does not resolve, or crosses a GVC boundary",
    "Point the link at a declared resource in the right GVC; identities cannot be shared across GVCs.",
  ),
  CPL030: rule(
    "CPL030",
    "merge-worthy",
    "correctness",
    "Domain DNS mode, challenge, or routing target is invalid",
    "Apex domains need cname; ns needs dns01; pick exactly one of gvcLink, workloadLink, ports[].routes.",
  ),

  // ── Best practice ────────────────────────────────────────────────
  CPL040: rule(
    "CPL040",
    "report-only",
    "best-practice",
    "Container image is not pinned",
    "Pin a version tag or a digest; a scale-from-zero cold start re-pulls.",
  ),
  CPL041: rule(
    "CPL041",
    "merge-worthy",
    "correctness",
    "Image reference uses a registry prefix Control Plane rejects",
    "Drop the docker.io/ prefix; address this org's own images as //image/NAME:TAG.",
  ),
  CPL042: rule(
    "CPL042",
    "merge-worthy",
    "correctness",
    "GVC declares no placement",
    "Set spec.staticPlacement.locationLinks, e.g. /org/<org>/location/aws-us-east-1.",
  ),
  CPL043: rule(
    "CPL043",
    "merge-worthy",
    "correctness",
    "Policy target kind, scope, or origin is not well formed",
    "Pick exactly one target scope, target a policy-targetable kind, and never set origin by hand.",
  ),
};
