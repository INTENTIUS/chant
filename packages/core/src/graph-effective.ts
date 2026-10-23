import type { GraphIR, IRNode } from "./graph-ir";
import { CapabilityEngine, type Evidence } from "./capabilities/matcher";
import { buildView, type CapabilityPack, type View } from "./capabilities/view";
import { resolvePacks, shippedRules } from "./capabilities/catalog";

/**
 * Fold DERIVED reachability facts onto EC2 instance nodes so a single-node query
 * can answer questions that are otherwise a multi-hop join with a union (#1139).
 *
 * Two facts, both things a live AWS-CLI sweep gets wrong because it can't cheaply
 * resolve the topology:
 *
 *  - `effectiveIngress` — the union of security-group ingress rules reachable
 *    from the instance, BOTH directly (`SecurityGroupIds`) AND through its launch
 *    template (`LaunchTemplate → LaunchTemplateData → SecurityGroupIds`). The
 *    launch-template hop is exactly what a CLI agent misses (it under-counts
 *    SSH-reachable instances). Each rule is normalized to `proto:port:cidr`
 *    (e.g. `tcp:22:0.0.0.0/0`) so it is precisely queryable.
 *  - `internetFacing` — whether the instance's subnet routes to an Internet
 *    Gateway (`subnet ← SubnetRouteTableAssociation → RouteTable ← Route →
 *    InternetGateway`). "Public subnet" means an IGW route, not
 *    `MapPublicIpOnLaunch`.
 *
 * With these, "instances SSH-reachable from the internet" is one predicate:
 *   `kind:EC2::Instance attr:internetFacing=true attr:effectiveIngress=tcp:22:0.0.0.0/0`
 * — no hand-joined CLI sweep, no over/under-counting.
 *
 * Both are capability rules (#4375): `internet-facing`, `in-sg` and
 * `ingress-of` in `capabilities/aws.paths`, over the lexicon-neutral view, so
 * one rule serves CloudFormation kinds and Terraform's AWS types (#4362)
 * alike. What stays here is the attribute surface: which nodes get the facts,
 * and how a rule's evidence is spelled as `proto:port:cidr` and `...Via`.
 */
export function enrichEffectiveTopology(ir: GraphIR, packs: CapabilityPack[] = []): GraphIR {
  const view = buildView(ir, resolvePacks(packs));
  const engine = new CapabilityEngine(view, shippedRules().rules);
  const facing = engine.set("internet-facing");
  const groups = engine.relation("in-sg").out;

  const nodes = ir.nodes.map((n) => {
    const tf = terraformResourceType(n) === "aws_instance";
    if (!tf && !isKind(n, "Instance")) return n;
    const attrs = (n.attrs ?? {}) as Record<string, unknown>;
    const reached = [...(groups.get(n.id) ?? new Map<string, Evidence>())];
    const ingress = reached.flatMap(([sg]) => ingressStrings(view, sg));
    const effectiveIngress = tf ? [...new Set(ingress)] : ingress;
    // A live enrichment may already have set internetFacing (+ its evidence) for
    // a subnet chant doesn't model declaratively (e.g. the account's default
    // VPC). Keep that truth; otherwise derive it from the declared route topology.
    const liveFacing = attrs["internetFacing"] === true;
    const evidence = facing.get(n.id);
    const declaredVia = evidence && evidence.hops.length > 0 ? facingVia(view, evidence, tf) : undefined;
    const via = (attrs["internetFacingVia"] as string | undefined) ?? declaredVia;
    const ingressVia = tf ? reached.map(([sg, ev]) => groupPath(view, ev, sg)).join(", ") : "";
    return {
      ...n,
      attrs: {
        ...attrs,
        effectiveIngress,
        internetFacing: liveFacing || !!declaredVia,
        ...(via ? { internetFacingVia: via } : {}),
        ...(ingressVia ? { effectiveIngressVia: `security groups ${ingressVia}` } : {}),
      },
    };
  });
  // Record what this pass computed, so a caller can report the graph's derived surface
  // without hardcoding attribute names. Only kinds actually enriched are listed.
  const enriched = nodes.some((n) => isKind(n, "Instance"));
  const enrichedTf = nodes.some((n) => terraformResourceType(n) === "aws_instance");
  const derivedAttrs = enriched || enrichedTf
    ? {
        ...(ir.derivedAttrs ?? {}),
        ...(enriched ? { Instance: ["internetFacing", "effectiveIngress"] } : {}),
        ...(enrichedTf ? { aws_instance: ["internetFacing", "effectiveIngress"] } : {}),
      }
    : ir.derivedAttrs;
  return { ...ir, nodes, ...(derivedAttrs ? { derivedAttrs } : {}) };
}

function isKind(n: IRNode | undefined, suffix: string): boolean {
  const kind = n?.kind ?? "";
  return !!n && (kind === suffix || kind.endsWith("::" + suffix));
}

function bare(id: string): string {
  return id.includes("::") ? id.slice(id.lastIndexOf("::") + 2) : id;
}

/** A node's name in a fold's evidence: a terraform address, or a bare logical id. */
function display(view: View, id: string): string {
  const v = view.nodes.get(id);
  if (v && v.lexicon === "terraform") return id.slice(id.lastIndexOf("/") + 1);
  return bare(id);
}

/** The ids an evidence path visits, in walk order. */
function visited(ev: Evidence, start?: string): string[] {
  const out: string[] = start ? [start] : [];
  let at = start;
  for (const h of ev.hops) {
    const next = at === undefined ? h.to : h.from === at ? h.to : h.from;
    if (at === undefined) out.push(h.from === next ? h.to : h.from);
    out.push(next);
    at = next;
  }
  return out;
}

/** `internetFacingVia`, as each fold always spelled it. */
function facingVia(view: View, ev: Evidence, tf: boolean): string | undefined {
  const ids = visited(ev);
  const of = (label: string) => ids.find((id) => view.nodes.get(id)?.label === label);
  const rt = of("RouteTable");
  const igw = of("InternetGateway");
  if (!rt || !igw) return undefined;
  if (!tf) return `${bare(rt)} → ${bare(igw)}`;
  const subnet = of("Subnet");
  const route = of("Route");
  const how = route && view.nodes.get(route)?.attrs.block ? "inline route" : route ? display(view, route) : "route";
  return `subnet route ${subnet ? display(view, subnet) : "?"} -> ${display(view, rt)} -> ${display(view, igw)} (${how})`;
}

/** One reached group, as `effectiveIngressVia` names it: the group, or the template it came through. */
function groupPath(view: View, ev: Evidence, sg: string): string {
  const lt = visited(ev).find((id) => view.nodes.get(id)?.label === "LaunchTemplate");
  return lt ? `${display(view, lt)} -> ${display(view, sg)}` : display(view, sg);
}

const STYLE_ORDER = ["cfn", "tf-inline", "tf-sg-rule", "tf-vpc-rule"];

/** A group's ingress rules as `proto:port:source` strings, inline rules first. */
function ingressStrings(view: View, sg: string): string[] {
  const rules = view.edges
    .filter((e) => e.from === sg && e.name === "ingress")
    .map((e) => view.nodes.get(e.to)!)
    .filter((r) => r && r.label === "IngressRule");
  const order = (r: (typeof rules)[number]) => (r.attrs.block ? -1 : STYLE_ORDER.indexOf(String(r.attrs.style)));
  return [...rules]
    .sort((a, b) => order(a) - order(b))
    .flatMap((r) => {
      const raw = (r.body ?? {}) as Body;
      switch (r.attrs.style) {
        case "tf-inline":
          return terraformIngress(raw, { proto: "protocol", cidrs: ["cidr_blocks", "ipv6_cidr_blocks", "prefix_list_ids"], groups: ["security_groups"] });
        case "tf-sg-rule":
          return terraformIngress(raw, { proto: "protocol", cidrs: ["cidr_blocks", "ipv6_cidr_blocks", "prefix_list_ids"], groups: ["source_security_group_id"] });
        case "tf-vpc-rule":
          return terraformIngress(raw, { proto: "ip_protocol", cidrs: ["cidr_ipv4", "cidr_ipv6", "prefix_list_id"], groups: ["referenced_security_group_id"] });
        default:
          return [cloudFormationIngress(raw)];
      }
    });
}

/** One CloudFormation ingress rule as `proto:port:source`. */
function cloudFormationIngress(rule: Body): string {
  const proto = String(rule.IpProtocol ?? "-1");
  const from = rule.FromPort as number | undefined;
  const to = rule.ToPort as number | undefined;
  const port = from == null ? "all" : from === to ? `${from}` : `${from}-${to}`;
  const source = rule.SourceSecurityGroupId;
  const group = source && typeof source === "object" && typeof (source as { $ref?: unknown }).$ref === "string"
    ? String((source as { $ref: string }).$ref).replace(/\.[A-Za-z]+$/, "")
    : source;
  const cidr =
    (rule.CidrIp as string | undefined) ??
    (rule.CidrIpv6 as string | undefined) ??
    (group ? `sg:${String(group)}` : "?");
  return `${proto}:${port}:${cidr}`;
}

/** The chant entity types every terraform `resource` and `data` block carries. */
const TERRAFORM_RESOURCE = "Terraform::Resource";
const TERRAFORM_DATA = "Terraform::Data";

/**
 * The Terraform type of a `resource` or `data` node: `aws_instance` for
 * `aws_instance.web`, `data.aws_ami` for `data.aws_ami.ubuntu`. Undefined for
 * any other node.
 *
 * This is the one reading of a terraform node's type. `chant search`'s `kind:`
 * (#4366), its rows and `--explain` count, `--count-by kind` (#4360) and the
 * effective-topology folds (#4362) all call it, so they cannot disagree.
 *
 * The terraform lexicon puts every resource on the IR as `Terraform::Resource`
 * (and every data source as `Terraform::Data`) and carries the block's type
 * label as `attrs.type` (#4366), which is read first. A node without one (an
 * older producer, or a `chant graph --live` node built from state) falls back
 * to the block's address (`aws_instance.web`, or `module.app.aws_instance.web`)
 * in `attrs.address`, whose second-to-last segment is the type, and failing
 * that to its id, whose last path segment is the address too. A data source
 * keeps its `data.` prefix: `data.aws_ami` reads an AMI, it does not manage one.
 */
export function terraformType(n: IRNode | undefined): string | undefined {
  if (!n || (n.kind !== TERRAFORM_RESOURCE && n.kind !== TERRAFORM_DATA)) return undefined;
  const label = (n.attrs as Record<string, unknown> | undefined)?.["type"];
  let type = typeof label === "string" && label.length > 0 ? label : undefined;
  if (type === undefined) {
    const parts = terraformAddress(n).split(".");
    type = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  }
  if (type === undefined) return undefined;
  return n.kind === TERRAFORM_DATA ? `data.${type}` : type;
}

/**
 * The provider resource type of a terraform `resource` node (`aws_instance`),
 * or undefined for any other node, data sources included. See {@link terraformType}.
 */
export function terraformResourceType(n: IRNode | undefined): string | undefined {
  return n?.kind === TERRAFORM_RESOURCE ? terraformType(n) : undefined;
}

function terraformAddress(n: IRNode): string {
  const address = (n.attrs as Record<string, unknown> | undefined)?.["address"];
  if (typeof address === "string" && address.length > 0) return address;
  return n.id.slice(n.id.lastIndexOf("/") + 1).replace(/~\d+$/, "");
}

type Body = Record<string, unknown>;

function bodyOf(n: IRNode): Body {
  const body = (n.attrs as Record<string, unknown> | undefined)?.["body"];
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Body) : {};
}

/** A block-or-list attribute as a list: hcl2json renders nested blocks as arrays. */
function list(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** `${aws_security_group.x.id}` -> `aws_security_group.x`; anything else unchanged. */
function sourceRef(value: unknown): string {
  const s = String(value);
  const m = /^\$\{([A-Za-z0-9_.-]+?)(?:\.(?:id|arn|name))?\}$/.exec(s);
  return m ? m[1] : s;
}

/**
 * One terraform ingress rule, in any of its three spellings, normalized to the
 * `proto:port:source` strings the CloudFormation fold produces. A rule with
 * several CIDRs or sources yields one string per source, so each is queryable
 * on its own.
 */
function terraformIngress(rule: Body, fields: {
  proto: string;
  cidrs: string[];
  groups: string[];
}): string[] {
  const rawProto = String(rule[fields.proto] ?? "-1").toLowerCase();
  const proto = rawProto === "all" ? "-1" : rawProto;
  const from = rule["from_port"];
  const to = rule["to_port"];
  const port =
    proto === "-1" || from == null
      ? "all"
      : String(from) === String(to ?? from)
        ? `${from}`
        : `${from}-${to}`;
  const sources: string[] = [];
  for (const f of fields.cidrs) for (const c of list(rule[f])) sources.push(String(c));
  for (const f of fields.groups) for (const g of list(rule[f])) sources.push(`sg:${sourceRef(g)}`);
  if (rule["self"] === true) sources.push("sg:self");
  if (sources.length === 0) sources.push("?");
  return sources.map((src) => `${proto}:${port}:${src}`);
}
