import { DNSManagedZone, DNSRecordSet } from "@intentius/chant-lexicon-gcp";
import { shared } from "../config";

export const zone = new DNSManagedZone({
  metadata: { name: "gitlab-cells" },
  dnsName: `${shared.domain}.`,
  description: "GitLab Cells DNS zone",
});

const ingressIp = process.env.INGRESS_IP ?? "0.0.0.0";

// Bare domain A record — user-facing entry point (e.g. gitlab.example.com).
// A wildcard *.domain does NOT match the bare domain itself; both records are needed.
export const apexRecord = new DNSRecordSet({
  metadata: { name: "gitlab-cells-apex" },
  name: `${shared.domain}.`,
  type: "A",
  ttl: 300,
  managedZoneRef: { name: "gitlab-cells" },
  rrdatas: [ingressIp],
});

// Wildcard record — INGRESS_IP is replaced by load-outputs.sh after deploy
export const wildcardRecord = new DNSRecordSet({
  metadata: { name: "gitlab-cells-wildcard" },
  name: `*.${shared.domain}.`,
  type: "A",
  ttl: 300,
  managedZoneRef: { name: "gitlab-cells" },
  rrdatas: [ingressIp],
});
