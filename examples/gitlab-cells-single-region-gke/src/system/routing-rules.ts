import { ConfigMap } from "@intentius/chant-lexicon-k8s";
import { cells, shared } from "../config";

// Mirrors GitLab's session_token.json routing spec.
// The session cookie carries a cell-prefixed value (cell${cellId}_...) that
// the router extracts stateless — no Topology Service round-trip needed.
export interface SessionTokenRule {
  type: "session_token";
  cookieName: string;
  cellPrefixMap: Record<string, string>; // "cell1_" -> "alpha"
}

// Mirrors GitLab's routable_token.json spec.
// Runner + API tokens carry glrt-cell_${cellId}_ prefix, enabling
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

const routableTokenRule: RoutableTokenRule = {
  type: "routable_token",
  tokenPattern: "^glrt-cell_(\\d+)_",
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

export const routingRulesConfigMap = new ConfigMap({
  metadata: { name: "cell-router-rules", namespace: "system" },
  data: {
    "routing-rules.json": JSON.stringify(routingRules, null, 2),
    // Cell name → internal K8s service URL for proxy target selection
    "cell-registry.json": JSON.stringify(
      Object.fromEntries(
        cells.map(cell => [
          cell.name,
          `http://gitlab-cell-${cell.name}-webservice-default.cell-${cell.name}.svc.cluster.local:8080`,
        ])
      ),
      null,
      2
    ),
    "router-config.json": JSON.stringify({
      topologyServiceAddress: "topology-service.system.svc.cluster.local:8080",
      // Health score below this threshold triggers failover to next available cell
      healthScoreThreshold: shared.routerHealthThreshold,
      healthcheckPath: "/healthz",
    }),
  },
});
