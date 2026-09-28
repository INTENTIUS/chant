import type { ChantConfig } from "@intentius/chant";

// One build root for everything, so the checks that join across documents see
// both sides: WK8601-WK8603 read the collector ConfigMaps next to the
// DaemonSet and Deployment that run them, PROM202 reads the SLO's severities
// next to the Alertmanager routes, and GRAF101/GRAF102 read every panel's
// datasource next to the declared datasources.
export default { lexicons: ["k8s", "prometheus", "grafana", "k3d"] } satisfies ChantConfig;
