import { DNSManagedZone, DNSRecordSet } from "@intentius/chant-lexicon-gcp";
import { shared } from "../config";

export const zone = new DNSManagedZone({
  metadata: { name: "gitlab-cells" },
  dnsName: `${shared.domain}.`,
  description: "GitLab Cells DNS zone",
});

// Wildcard record — INGRESS_IP is replaced by load-outputs.sh after deploy
export const wildcardRecord = new DNSRecordSet({
  metadata: { name: "gitlab-cells-wildcard" },
  name: `*.${shared.domain}.`,
  type: "A",
  ttl: 300,
  managedZoneRef: { name: "gitlab-cells" },
  rrdatas: [process.env.INGRESS_IP ?? "0.0.0.0"],
});
