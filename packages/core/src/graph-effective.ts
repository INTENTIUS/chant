import type { GraphIR, IRNode } from "./graph-ir";

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
 */
export function enrichEffectiveTopology(ir: GraphIR): GraphIR {
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  const edges = ir.edges ?? [];
  const kind = (n?: IRNode): string => n?.kind ?? "";
  const isKind = (n: IRNode | undefined, suffix: string): boolean =>
    !!n && (kind(n) === suffix || kind(n).endsWith("::" + suffix));
  const via = (...names: string[]) => (v: string): boolean => names.includes(v);

  /** Out-neighbours of `id` (edges from → to), optionally filtered by viaAttr. */
  const out = (id: string, pred?: (v: string) => boolean): IRNode[] =>
    edges
      .filter((e) => e.from === id && (!pred || pred(e.viaAttr ?? e.kind ?? "")))
      .map((e) => byId.get(e.to))
      .filter((x): x is IRNode => !!x);
  /** In-neighbours of `id` (edges to ← from), optionally filtered by viaAttr. */
  const incoming = (id: string, pred?: (v: string) => boolean): IRNode[] =>
    edges
      .filter((e) => e.to === id && (!pred || pred(e.viaAttr ?? e.kind ?? "")))
      .map((e) => byId.get(e.from))
      .filter((x): x is IRNode => !!x);

  const normalizeIngress = (sg: IRNode): string[] => {
    const rules = (sg.attrs as Record<string, unknown> | undefined)?.["SecurityGroupIngress"];
    if (!Array.isArray(rules)) return [];
    return rules.map((r) => {
      const rule = r as Record<string, unknown>;
      const proto = String(rule.IpProtocol ?? "-1");
      const from = rule.FromPort as number | undefined;
      const to = rule.ToPort as number | undefined;
      const port = from == null ? "all" : from === to ? `${from}` : `${from}-${to}`;
      const cidr =
        (rule.CidrIp as string | undefined) ??
        (rule.CidrIpv6 as string | undefined) ??
        (rule.SourceSecurityGroupId ? `sg:${String(rule.SourceSecurityGroupId)}` : "?");
      return `${proto}:${port}:${cidr}`;
    });
  };

  /** Security groups reachable from an instance — direct and via launch template. */
  const effectiveSgs = (inst: IRNode): IRNode[] => {
    const direct = out(inst.id, via("SecurityGroupIds", "SecurityGroupId"));
    const templates = out(inst.id, via("LaunchTemplate", "LaunchTemplateId"));
    const viaTemplate = templates
      .flatMap((lt) => out(lt.id, via("LaunchTemplateData", "SecurityGroupIds", "SecurityGroupId")))
      .filter((n) => isKind(n, "SecurityGroup"));
    const all = [...direct.filter((n) => isKind(n, "SecurityGroup")), ...viaTemplate];
    return [...new Map(all.map((s) => [s.id, s])).values()];
  };

  /** The IGW an instance's subnet routes to (evidence), or undefined. */
  const internetFacingVia = (inst: IRNode): string | undefined => {
    for (const subnet of out(inst.id, via("SubnetId")).filter((n) => isKind(n, "Subnet"))) {
      const assocs = incoming(subnet.id, via("SubnetId")).filter((a) => isKind(a, "SubnetRouteTableAssociation"));
      const routeTables = assocs.flatMap((a) => out(a.id, via("RouteTableId")).filter((n) => isKind(n, "RouteTable")));
      for (const rt of routeTables) {
        const routes = incoming(rt.id, via("RouteTableId")).filter((n) => isKind(n, "Route"));
        for (const route of routes) {
          const dest = (route.attrs as Record<string, unknown> | undefined)?.["DestinationCidrBlock"];
          const igw = out(route.id, via("GatewayId")).find((g) => isKind(g, "InternetGateway"));
          if (igw && (dest == null || dest === "0.0.0.0/0")) {
            const id = igw.id.includes("::") ? igw.id.slice(igw.id.lastIndexOf("::") + 2) : igw.id;
            return `${rt.id.includes("::") ? rt.id.slice(rt.id.lastIndexOf("::") + 2) : rt.id} → ${id}`;
          }
        }
      }
    }
    return undefined;
  };

  const terraform = terraformFolds(byId, edges);
  const nodes = ir.nodes.map((n) => {
    if (terraformResourceType(n) === "aws_instance") return terraform(n);
    if (!isKind(n, "Instance")) return n;
    const effectiveIngress = effectiveSgs(n).flatMap(normalizeIngress);
    // A live enrichment may already have set internetFacing (+ its evidence) for
    // a subnet chant doesn't model declaratively (e.g. the account's default
    // VPC). Keep that truth; otherwise derive it from the declared route topology.
    const attrs = (n.attrs ?? {}) as Record<string, unknown>;
    const liveFacing = attrs["internetFacing"] === true;
    const declaredVia = internetFacingVia(n);
    const via = (attrs["internetFacingVia"] as string | undefined) ?? declaredVia;
    return {
      ...n,
      attrs: { ...attrs, effectiveIngress, internetFacing: liveFacing || !!declaredVia, ...(via ? { internetFacingVia: via } : {}) },
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

/** Whether a reference expression (`${aws_internet_gateway.main.id}`) names `address`. */
function refersTo(value: unknown, address: string): boolean {
  if (typeof value !== "string") return false;
  return value.includes(`${address}.`) || value.includes(`${address}}`);
}

const ANY_DESTINATION = new Set(["0.0.0.0/0", "::/0"]);

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

/**
 * The same two facts as the CloudFormation fold above, over terraform's AWS
 * resource types (#4362). The references the lexicon resolves into edges carry
 * the consumer-side top-level argument as `viaAttr` (#2265), which is what each
 * hop below filters on; literal values (ports, CIDRs, route destinations) are
 * read from the block body the lexicon keeps verbatim on `attrs.body`.
 *
 *  - `effectiveIngress`: `aws_instance` -> `aws_security_group` through
 *    `vpc_security_group_ids` or `security_groups`, and through
 *    `launch_template` -> `aws_launch_template` -> its `vpc_security_group_ids`
 *    (or a `network_interfaces` block's `security_groups`). Ingress is read from
 *    the group's inline `ingress` blocks, from `aws_security_group_rule`
 *    resources of `type = "ingress"` that point at it, and from
 *    `aws_vpc_security_group_ingress_rule` resources that point at it.
 *  - `internetFacing`: `aws_instance` -> `aws_subnet` through `subnet_id`,
 *    `aws_route_table_association` -> `aws_route_table`, and the table routes
 *    a default destination to an `aws_internet_gateway` through an inline
 *    `route` block or an `aws_route` resource. A subnet with no explicit
 *    association (the VPC's main table) is not followed.
 *
 * All of it is computed from declared references, so on a declared-only read
 * it is a fact about the source, not about the account.
 */
function terraformFolds(byId: Map<string, IRNode>, edges: GraphIR["edges"]) {
  const typeIs = (...types: string[]) => (n: IRNode): boolean => types.includes(terraformResourceType(n) ?? "");
  const out = (id: string, ...vias: string[]): IRNode[] =>
    edges
      .filter((e) => e.from === id && vias.includes(e.viaAttr ?? ""))
      .map((e) => byId.get(e.to))
      .filter((x): x is IRNode => !!x);
  const incoming = (id: string, ...vias: string[]): IRNode[] =>
    edges
      .filter((e) => e.to === id && vias.includes(e.viaAttr ?? ""))
      .map((e) => byId.get(e.from))
      .filter((x): x is IRNode => !!x);

  const INLINE = { proto: "protocol", cidrs: ["cidr_blocks", "ipv6_cidr_blocks", "prefix_list_ids"], groups: ["security_groups"] };
  const SG_RULE = { proto: "protocol", cidrs: ["cidr_blocks", "ipv6_cidr_blocks", "prefix_list_ids"], groups: ["source_security_group_id"] };
  const VPC_RULE = { proto: "ip_protocol", cidrs: ["cidr_ipv4", "cidr_ipv6", "prefix_list_id"], groups: ["referenced_security_group_id"] };

  const ingressOf = (sg: IRNode): string[] => {
    const inline = list(bodyOf(sg)["ingress"]).flatMap((r) => terraformIngress(r as Body, INLINE));
    const sgRules = incoming(sg.id, "security_group_id")
      .filter(typeIs("aws_security_group_rule"))
      .filter((r) => bodyOf(r)["type"] === "ingress")
      .flatMap((r) => terraformIngress(bodyOf(r), SG_RULE));
    const vpcRules = incoming(sg.id, "security_group_id")
      .filter(typeIs("aws_vpc_security_group_ingress_rule"))
      .flatMap((r) => terraformIngress(bodyOf(r), VPC_RULE));
    return [...inline, ...sgRules, ...vpcRules];
  };

  /** Each security group the instance reaches, with the path it was reached by. */
  const groupsOf = (inst: IRNode): Array<{ sg: IRNode; path: string }> => {
    const isSg = typeIs("aws_security_group");
    const found: Array<{ sg: IRNode; path: string }> = [];
    for (const sg of out(inst.id, "vpc_security_group_ids", "security_groups").filter(isSg)) {
      found.push({ sg, path: terraformAddress(sg) });
    }
    for (const lt of out(inst.id, "launch_template").filter(typeIs("aws_launch_template"))) {
      for (const sg of out(lt.id, "vpc_security_group_ids", "security_group_names", "network_interfaces").filter(isSg)) {
        found.push({ sg, path: `${terraformAddress(lt)} -> ${terraformAddress(sg)}` });
      }
    }
    const seen = new Set<string>();
    return found.filter(({ sg }) => !seen.has(sg.id) && !!seen.add(sg.id));
  };

  /** The route an instance's subnet takes to an internet gateway (evidence), or undefined. */
  const internetFacingVia = (inst: IRNode): string | undefined => {
    for (const subnet of out(inst.id, "subnet_id").filter(typeIs("aws_subnet"))) {
      const tables = incoming(subnet.id, "subnet_id")
        .filter(typeIs("aws_route_table_association"))
        .flatMap((a) => out(a.id, "route_table_id").filter(typeIs("aws_route_table")));
      for (const rt of tables) {
        const hop = `subnet route ${terraformAddress(subnet)} -> ${terraformAddress(rt)}`;
        // Inline `route { gateway_id = aws_internet_gateway.x.id }` blocks: the
        // edge says the table reaches the gateway through `route`, the block
        // says which destination that route covers.
        for (const igw of out(rt.id, "route").filter(typeIs("aws_internet_gateway"))) {
          const address = terraformAddress(igw);
          const routed = list(bodyOf(rt)["route"]).some((r) => {
            const route = r as Body;
            const dest = route["cidr_block"] ?? route["ipv6_cidr_block"];
            return refersTo(route["gateway_id"], address) && (dest == null || ANY_DESTINATION.has(String(dest)));
          });
          if (routed) return `${hop} -> ${address} (inline route)`;
        }
        // A separate `aws_route` resource pointing at the table.
        for (const route of incoming(rt.id, "route_table_id").filter(typeIs("aws_route"))) {
          const body = bodyOf(route);
          const dest = body["destination_cidr_block"] ?? body["destination_ipv6_cidr_block"];
          if (dest != null && !ANY_DESTINATION.has(String(dest))) continue;
          const igw = out(route.id, "gateway_id").find(typeIs("aws_internet_gateway"));
          if (igw) return `${hop} -> ${terraformAddress(igw)} (${terraformAddress(route)})`;
        }
      }
    }
    return undefined;
  };

  return (inst: IRNode): IRNode => {
    const groups = groupsOf(inst);
    const effectiveIngress = [...new Set(groups.flatMap(({ sg }) => ingressOf(sg)))];
    const attrs = (inst.attrs ?? {}) as Record<string, unknown>;
    // Same rule as the CloudFormation fold: a live enrichment's verdict stands.
    const liveFacing = attrs["internetFacing"] === true;
    const declaredVia = internetFacingVia(inst);
    const via = (attrs["internetFacingVia"] as string | undefined) ?? declaredVia;
    const ingressVia = groups.map(({ path }) => path).join(", ");
    return {
      ...inst,
      attrs: {
        ...attrs,
        effectiveIngress,
        internetFacing: liveFacing || !!declaredVia,
        ...(via ? { internetFacingVia: via } : {}),
        ...(ingressVia ? { effectiveIngressVia: `security groups ${ingressVia}` } : {}),
      },
    };
  };
}
