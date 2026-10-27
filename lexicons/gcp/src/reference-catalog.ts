import type { IdentityRule, ReferenceCatalog, RefRule } from "@intentius/chant/graph-refs";

/**
 * GCP reference catalog (#4535): how GCP resources name each other, so
 * chant's catalog pass (`reconstructIndexedEdges`, #4522) draws their edges
 * and behold can retire its name matcher (behold#1005).
 *
 * ## Shape: Config Connector references by name
 *
 * The lexicon declares Config Connector objects, and a Config Connector
 * object names another by a `*Ref` holding the other's `metadata.name`
 * (`networkRef: { name: "three-cloud-vpc" }`). When the composite wires the
 * reference as `vpc.name`, the declared graph already has the edge (the ref
 * is an `AttrRef`). When the composite writes the name as a string (the
 * Cloud Run runtime service account, an IAM member's `resourceRef`), only a
 * rule draws it. These were the two gcp edges behold's matcher drew on
 * example-three-cloud.
 *
 * Every target kind is identified by its `metadata.name`, and every rule
 * names its `targetKind` (behold#1023's ruling), so a name is only joined to
 * a node of the kind the field refers to. Names repeat across kinds in one
 * project (the composites name a network and its service `three-cloud-*`
 * alike), and the kind is what keeps them apart.
 *
 * A field whose target can be one of several kinds (`resourceRef` on an IAM
 * member, a backend's group) has one rule per kind, each `optional`: a value
 * that is not a reference to that kind is not dangling under it.
 *
 * ## What this does not do
 *
 * `external` references (`projectRef.external`, a `*Ref.external` URL) are
 * not read: they name something outside the declaration, in one of several
 * spellings (selfLink, relative name, bare name). Nor does the catalog read
 * the REST shape of an indexed node: Cloud Asset's search summary carries no
 * references, and a REST payload names its targets by selfLink URL while an
 * indexed node is named by its Cloud Asset name (`//compute.googleapis.com/
 * projects/...`). Joining those needs one spelling on both sides, which is
 * the identity-match pass's to give (a gcp `indexIdentity`), not a rule's.
 */

/** Kinds other gcp resources reference by `*Ref.name`. */
const NAMED_KINDS = [
  "GCP::Compute::Network",
  "GCP::Compute::Subnetwork",
  "GCP::Compute::Address",
  "GCP::Compute::BackendService",
  "GCP::Compute::BackendBucket",
  "GCP::Compute::RegionNetworkEndpointGroup",
  "GCP::Compute::NetworkEndpointGroup",
  "GCP::Compute::GlobalNetworkEndpointGroup",
  "GCP::Compute::InstanceGroup",
  "GCP::Compute::HealthCheck",
  "GCP::Compute::SecurityPolicy",
  "GCP::Compute::URLMap",
  "GCP::Compute::TargetHTTPProxy",
  "GCP::Compute::TargetHTTPSProxy",
  "GCP::Compute::ManagedSSLCertificate",
  "GCP::Compute::SSLCertificate",
  "GCP::Compute::SSLPolicy",
  "GCP::Compute::Router",
  "GCP::Compute::Disk",
  "GCP::Compute::InstanceTemplate",
  "GCP::Container::Cluster",
  "GCP::Iam::ServiceAccount",
  "GCP::Run::Service",
  "GCP::Sql::Instance",
  "GCP::Storage::Bucket",
  "GCP::Pubsub::Topic",
  "GCP::Kms::KeyRing",
  "GCP::Kms::CryptoKey",
  "GCP::Secretmanager::Secret",
  "GCP::Vpcaccess::Connector",
  "GCP::Dns::ManagedZone",
] as const;

const identities: IdentityRule[] = NAMED_KINDS.map((kind) => ({ kind, ids: ["metadata.name"] }));

type Rel = RefRule["relation"];

const ref = (from: string, path: string, targetKind: string, label: string, relation: Rel = "reference"): RefRule => ({ from, path, targetKind, relation, label });

/** One rule per kind a multi-kind field can name, each optional. */
const anyOf = (from: string, path: string, targetKinds: readonly string[], label: string): RefRule[] =>
  targetKinds.map((targetKind) => ({ from, path, targetKind, relation: "reference" as const, label, optional: true }));

/** The kinds an IAM binding's `resourceRef` most often names. */
const IAM_RESOURCE_KINDS = [
  "GCP::Run::Service",
  "GCP::Storage::Bucket",
  "GCP::Pubsub::Topic",
  "GCP::Iam::ServiceAccount",
  "GCP::Secretmanager::Secret",
  "GCP::Kms::CryptoKey",
  "GCP::Kms::KeyRing",
] as const;

const refs: RefRule[] = [
  // ── network placement ──
  ref("GCP::Compute::Subnetwork", "networkRef.name", "GCP::Compute::Network", "in network", "containment"),
  ref("GCP::Compute::Firewall", "networkRef.name", "GCP::Compute::Network", "in network", "containment"),
  ref("GCP::Compute::Router", "networkRef.name", "GCP::Compute::Network", "in network", "containment"),
  ref("GCP::Compute::RouterNAT", "routerRef.name", "GCP::Compute::Router", "on router"),
  ref("GCP::Vpcaccess::Connector", "networkRef.name", "GCP::Compute::Network", "in network", "containment"),
  ref("GCP::Compute::RegionNetworkEndpointGroup", "networkRef.name", "GCP::Compute::Network", "in network", "containment"),
  ref("GCP::Compute::RegionNetworkEndpointGroup", "subnetworkRef.name", "GCP::Compute::Subnetwork", "in subnet", "containment"),
  ref("GCP::Compute::ForwardingRule", "networkRef.name", "GCP::Compute::Network", "in network", "containment"),
  ref("GCP::Compute::ForwardingRule", "subnetworkRef.name", "GCP::Compute::Subnetwork", "in subnet", "containment"),
  ref("GCP::Compute::Instance", "networkInterface[].networkRef.name", "GCP::Compute::Network", "in network", "containment"),
  ref("GCP::Compute::Instance", "networkInterface[].subnetworkRef.name", "GCP::Compute::Subnetwork", "in subnet", "containment"),
  ref("GCP::Container::Cluster", "networkRef.name", "GCP::Compute::Network", "in network", "containment"),
  ref("GCP::Container::Cluster", "subnetworkRef.name", "GCP::Compute::Subnetwork", "in subnet", "containment"),
  ref("GCP::Run::Service", "template.vpcAccess.networkInterfaces[].networkRef.name", "GCP::Compute::Network", "egress into"),
  ref("GCP::Run::Service", "template.vpcAccess.networkInterfaces[].subnetworkRef.name", "GCP::Compute::Subnetwork", "egress into"),
  ref("GCP::Run::Service", "template.vpcAccess.connectorRef.name", "GCP::Vpcaccess::Connector", "egress via"),
  ref("GCP::Sql::Instance", "settings.ipConfiguration.privateNetworkRef.name", "GCP::Compute::Network", "private on"),

  // ── load balancing: forwarding rule → proxy → URL map → backend → NEG → service ──
  ref("GCP::Compute::ForwardingRule", "ipAddress.addressRef.name", "GCP::Compute::Address", "address"),
  ref("GCP::Compute::ForwardingRule", "target.targetHTTPProxyRef.name", "GCP::Compute::TargetHTTPProxy", "to"),
  ref("GCP::Compute::ForwardingRule", "target.targetHTTPSProxyRef.name", "GCP::Compute::TargetHTTPSProxy", "to"),
  ref("GCP::Compute::ForwardingRule", "backendServiceRef.name", "GCP::Compute::BackendService", "to"),
  ref("GCP::Compute::TargetHTTPProxy", "urlMapRef.name", "GCP::Compute::URLMap", "routes by"),
  ref("GCP::Compute::TargetHTTPSProxy", "urlMapRef.name", "GCP::Compute::URLMap", "routes by"),
  ref("GCP::Compute::TargetHTTPSProxy", "sslPolicyRef.name", "GCP::Compute::SSLPolicy", "tls policy"),
  ...anyOf("GCP::Compute::TargetHTTPSProxy", "sslCertificates[].name", ["GCP::Compute::ManagedSSLCertificate", "GCP::Compute::SSLCertificate"], "certificate"),
  ref("GCP::Compute::URLMap", "defaultService.backendServiceRef.name", "GCP::Compute::BackendService", "default"),
  ref("GCP::Compute::URLMap", "defaultService.backendBucketRef.name", "GCP::Compute::BackendBucket", "default"),
  ref("GCP::Compute::URLMap", "pathMatcher[].defaultService.backendServiceRef.name", "GCP::Compute::BackendService", "path default"),
  ...anyOf(
    "GCP::Compute::BackendService",
    "backend[].group.networkEndpointGroupRef.name",
    ["GCP::Compute::RegionNetworkEndpointGroup", "GCP::Compute::NetworkEndpointGroup", "GCP::Compute::GlobalNetworkEndpointGroup"],
    "backend",
  ),
  ref("GCP::Compute::BackendService", "backend[].group.instanceGroupRef.name", "GCP::Compute::InstanceGroup", "backend"),
  ref("GCP::Compute::BackendService", "healthChecks[].healthCheckRef.name", "GCP::Compute::HealthCheck", "checked by"),
  ref("GCP::Compute::BackendService", "securityPolicyRef.name", "GCP::Compute::SecurityPolicy", "policy"),
  ref("GCP::Compute::RegionNetworkEndpointGroup", "cloudRun.serviceRef.name", "GCP::Run::Service", "serves"),

  // ── identity: who a workload runs as ──
  ref("GCP::Run::Service", "template.serviceAccountRef.name", "GCP::Iam::ServiceAccount", "runs as"),
  ref("GCP::Compute::Instance", "serviceAccount.serviceAccountRef.name", "GCP::Iam::ServiceAccount", "runs as"),
  ref("GCP::Container::NodePool", "nodeConfig.serviceAccountRef.name", "GCP::Iam::ServiceAccount", "runs as"),
  ref("GCP::Container::Cluster", "nodeConfig.serviceAccountRef.name", "GCP::Iam::ServiceAccount", "runs as"),
  ...anyOf("GCP::Iam::PolicyMember", "resourceRef.name", IAM_RESOURCE_KINDS, "grant on"),
  ...anyOf("GCP::Iam::PartialPolicy", "resourceRef.name", IAM_RESOURCE_KINDS, "grant on"),
  ...anyOf("GCP::Iam::Policy", "resourceRef.name", IAM_RESOURCE_KINDS, "grant on"),
  ref("GCP::Iam::PolicyMember", "memberFrom.serviceAccountRef.name", "GCP::Iam::ServiceAccount", "grants"),

  // ── parents and data ──
  ref("GCP::Container::NodePool", "clusterRef.name", "GCP::Container::Cluster", "in cluster", "containment"),
  ref("GCP::Sql::Database", "instanceRef.name", "GCP::Sql::Instance", "on instance", "containment"),
  ref("GCP::Sql::User", "instanceRef.name", "GCP::Sql::Instance", "on instance", "containment"),
  ref("GCP::Kms::CryptoKey", "keyRingRef.name", "GCP::Kms::KeyRing", "in key ring", "containment"),
  ref("GCP::Secretmanager::SecretVersion", "secretRef.name", "GCP::Secretmanager::Secret", "version of", "containment"),
  ref("GCP::Dns::RecordSet", "managedZoneRef.name", "GCP::Dns::ManagedZone", "in zone", "containment"),
  ref("GCP::Pubsub::Subscription", "topicRef.name", "GCP::Pubsub::Topic", "subscribes to"),
  ref("GCP::Compute::Instance", "bootDisk.sourceDiskRef.name", "GCP::Compute::Disk", "boots from"),
  ref("GCP::Compute::Instance", "instanceTemplateRef.name", "GCP::Compute::InstanceTemplate", "from template"),
  ref("GCP::Run::Service", "template.containers[].env[].valueSource.secretKeyRef.secretRef.name", "GCP::Secretmanager::Secret", "reads secret"),
];

export const gcpReferenceCatalog: ReferenceCatalog = { identities, refs };
