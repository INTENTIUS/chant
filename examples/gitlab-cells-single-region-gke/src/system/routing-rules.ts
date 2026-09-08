import { ConfigMap } from "@intentius/chant-lexicon-k8s";
import { cells, shared, SYSTEM_NS } from "../config";

// Mirrors GitLab's session_token.json routing spec.
// The session cookie carries a cell-prefixed value (cell${cellId}_...) that
// the router extracts stateless — no Topology Service round-trip needed.
export interface SessionTokenRule {
  type: "session_token";
  cookieName: string;
  cellPrefixMap: Record<string, string>; // "cell1_" -> "alpha"
}

// Mirrors GitLab's routable_token.json spec.
// Runner + API tokens carry the glrt-t${cellId}_ prefix, enabling
// stateless routing from token alone — key to Cells 1.5 runner architecture.
export interface RoutableTokenRule {
  type: "routable_token";
  tokenPattern: string; // regex capturing cellId group
  cellIdMap: Record<string, string>; // "1" -> "alpha"
}

// Path-based fallback for org slug routing via Topology Service lookup.
// Used when no session cookie or routable token is present.
export interface PathRule {
  type: "path";
  pathPattern: string;
  topologyServiceAddress: string;
  lookupParam: "org_slug";
}

export type RoutingRule = SessionTokenRule | RoutableTokenRule | PathRule;

const sessionTokenRule: SessionTokenRule = {
  type: "session_token",
  cookieName: "_gitlab_session",
  cellPrefixMap: Object.fromEntries(
    cells.map(cell => [`cell${cell.cellId}_`, cell.name])
  ),
};

// GitLab Cells 17.x generates tokens with prefix glrt-t{cellId}_ (e.g. glrt-t1_ for cellId=1).
// This differs from the design-doc format glrt-cell_N_ — use the actual runtime format.
const routableTokenRule: RoutableTokenRule = {
  type: "routable_token",
  tokenPattern: "^glrt-t(\\d+)_",
  cellIdMap: Object.fromEntries(
    cells.map(cell => [String(cell.cellId), cell.name])
  ),
};

const pathRule: PathRule = {
  type: "path",
  pathPattern: "^/([^/]+)/",
  topologyServiceAddress: "topology-service.system.svc.cluster.local:8080",
  lookupParam: "org_slug",
};

// Priority-ordered: stateless rules (session, token) evaluated before
// topology lookup so the common case requires no external call.
export const routingRules: RoutingRule[] = [sessionTokenRule, routableTokenRule, pathRule];

// Cell name -> internal K8s service URL for proxy target selection.
// Built here rather than inline in the ConfigMap below: a resource constructor
// property must be statically evaluable, and an arrow function passed to
// `.map()` is not (EVL001).
//
// Port 8181 is the workhorse TCP listener. Port 8080 is the internal puma/rails
// port, which bypasses workhorse — git HTTP requires workhorse for JWT handling.
const cellRegistry = Object.fromEntries(
  cells.map(cell => [
    cell.name,
    `http://gitlab-cell-${cell.name}-webservice-default.cell-${cell.name}.svc.cluster.local:8181`,
  ])
);

export const routingRulesConfigMap = new ConfigMap({
  metadata: { name: "cell-router-rules", namespace: SYSTEM_NS, labels: { "app.kubernetes.io/part-of": "system" } },
  data: {
    "routing-rules.json": JSON.stringify(routingRules, null, 2),
    "cell-registry.json": JSON.stringify(cellRegistry, null, 2),
    "router-config.json": JSON.stringify({
      topologyServiceAddress: "topology-service.system.svc.cluster.local:8080",
      // Health score below this threshold triggers failover to next available cell
      healthScoreThreshold: shared.routerHealthThreshold,
      healthcheckPath: "/healthz",
    }),
  },
});
