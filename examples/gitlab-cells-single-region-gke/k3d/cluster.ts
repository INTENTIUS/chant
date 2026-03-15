// k3d cluster configuration for the local routing smoke test.
// This file exports the cluster config as a typed object (serialised to
// k3d-cluster.yaml by scripts/k3d-smoke.sh) plus constants shared by
// mock-cell.ts and index.ts.
//
// What the smoke test validates (no GCP, no real GitLab):
//   1. Session cookie _gitlab_session cell1_* → routed to cell-alpha
//   2. Routable token glrt-cell_2_*          → routed to cell-beta
//   3. Path /org-slug/ → topology service fallback → alpha (default)
//   4. Health endpoint /healthz              → 200 ok

export const CLUSTER_NAME = "gitlab-cells-smoke";

// Host port → k3d NodePort mappings.
//
// Direct cell-router port (for healthz and direct routing tests):
//   k3d --port "8080:30080@server:0"  →  localhost:8080 reaches cell-router NodePort
//
// Nginx ingress port (for Host-header wildcard routing tests):
//   k3d --port "8081:30081@server:0"  →  localhost:8081 reaches ingress-nginx NodePort
//   Tests use -H "Host: gitlab.alpha.<domain>" to exercise wildcard Ingress rules.
export const HOST_PORT = 8080;
export const NODE_PORT = 30080;
export const NGINX_HOST_PORT = 8081;
export const NGINX_NODE_PORT = 30081;

export const SYSTEM_NS = "system";

import { cells } from "../src/config";
export const CELL_NAMESPACES = cells.map(c => `cell-${c.name}`);

// Image tags for locally-built images loaded into k3d via `k3d image import`.
// imagePullPolicy must be "Never" for these to work in k3d.
export const CELL_ROUTER_IMAGE = "cell-router:local";
export const TOPOLOGY_SERVICE_IMAGE = "topology-service:local";
export const MOCK_GITLAB_IMAGE = "nginx:alpine";

// k3d cluster config (apiVersion: k3d.io/v1alpha5, kind: Simple).
// Written to k3d-cluster.yaml by scripts/k3d-smoke.sh.
export const k3dClusterConfig = {
  apiVersion: "k3d.io/v1alpha5",
  kind: "Simple",
  metadata: { name: CLUSTER_NAME },
  servers: 1,
  agents: 0,
  // Map host port 8080 → node port 30080 so curl http://localhost:8080 reaches the
  // cell-router NodePort service without a load balancer or nginx ingress.
  ports: [
    // @server:0 maps directly on the k3d server-0 container, bypassing the
    // load balancer. --no-lb must NOT be set (k3d v5 blocks --port when LB is disabled).
    // 8080:30080 — cell-router NodePort (direct routing tests + healthz)
    { port: `${HOST_PORT}:${NODE_PORT}`, nodeFilters: ["server:0"] },
    // 8081:30081 — ingress-nginx NodePort (Host-header wildcard routing tests)
    { port: `${NGINX_HOST_PORT}:${NGINX_NODE_PORT}`, nodeFilters: ["server:0"] },
  ],
  options: {
    k3s: {
      extraArgs: [
        // Disable traefik — we use a NodePort service directly, no ingress needed.
        { arg: "--disable=traefik", nodeFilters: ["server:*"] },
        // Disable servicelb — we don't need a software load balancer.
        { arg: "--disable=servicelb", nodeFilters: ["server:*"] },
      ],
    },
  },
};
