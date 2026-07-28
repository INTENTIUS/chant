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

  const nodes = ir.nodes.map((n) => {
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
  return { ...ir, nodes };
}
