/**
 * The GCP carve provider (#2017) — advise-only.
 *
 * `mapsTo` names a Config Connector type as the gcp lexicon spells it
 * (`GCP::Storage::Bucket`), not a Terraform type and not a raw CNRM kind. Every
 * value here is checked against `lexicons/gcp/dist/meta.json` by
 * `gcp.test.ts`, so an entry pointing at a type the lexicon does not define
 * fails the suite rather than shipping a report that promises a resource chant
 * cannot build.
 *
 * The google Terraform provider and Config Connector wrap the same GCP API, so
 * resource granularity matches almost everywhere. That is why `foldsInto` is
 * empty: unlike S3, where Terraform splits versioning, ACLs and encryption out
 * of the bucket CloudFormation keeps together, GCP has no family where several
 * `google_*` resources collapse into one CNRM resource.
 *
 * Tiers follow the reshaping the constructor demands, not the API's size:
 *
 *   1 — flat rename, `google_pubsub_topic` to `GCP::Pubsub::Topic`.
 *   2 — a cross-resource reference becomes a `*Ref` object, or a Terraform
 *       block list becomes a CNRM object. Most of the table.
 *   3 — the native shape is a re-modelling. `google_container_cluster` inlines
 *       node pools Terraform also declares separately, `google_sql_database_
 *       instance` carries everything under `settings`, and the IAM membership
 *       resources map onto one generic `GCP::Iam::PolicyMember` per binding.
 *
 * No `emitTypes` and no `adopt`, so `carve emit` refuses these types on both
 * paths with the same message (#2015). Emit is a larger piece of work than the
 * per-attribute rename the tier map implies: CNRM addresses a sibling through
 * a `*Ref` object rather than the id or self-link Terraform state holds, and
 * the resource's own name lives in `metadata.name` with `resourceID` as the
 * override, so a faithful adopter has to resolve both per type. Declaring emit
 * before that exists would put back the advise/emit cliff #2015 closed.
 */

import type { CarveProvider, TierInfo } from "../carve-provider";

interface Row extends TierInfo {
  /** The HCL attribute carrying the physical name. Null when the type has none. */
  identityAttr: string | null;
}

/**
 * A table row. Most google resources carry their physical name in `name`, so
 * that is the default and only the exceptions are spelled out.
 */
function t(tier: 1 | 2 | 3, mapsTo: string, identityAttr: string | null = "name"): Row {
  return { tier, mapsTo, identityAttr };
}

const TABLE: Record<string, Row> = {
  // ── Storage ──
  google_storage_bucket: t(1, "GCP::Storage::Bucket"),
  google_storage_bucket_access_control: t(2, "GCP::Storage::BucketAccessControl", null),
  google_storage_default_object_access_control: t(2, "GCP::Storage::DefaultObjectAccessControl", null),
  google_storage_notification: t(2, "GCP::Storage::Notification", null),
  google_storage_hmac_key: t(1, "GCP::Storage::HMACKey", null),
  google_storage_managed_folder: t(1, "GCP::Storage::ManagedFolder"),
  google_storage_transfer_job: t(2, "GCP::Storagetransfer::Job", null),
  google_filestore_instance: t(2, "GCP::Filestore::Instance"),

  // ── Compute: instances, disks, images ──
  google_compute_instance: t(3, "GCP::Compute::Instance"),
  google_compute_instance_template: t(3, "GCP::Compute::InstanceTemplate"),
  google_compute_instance_group: t(2, "GCP::Compute::InstanceGroup"),
  google_compute_instance_group_manager: t(2, "GCP::Compute::InstanceGroupManager"),
  google_compute_region_instance_group_manager: t(2, "GCP::Compute::InstanceGroupManager"),
  google_compute_autoscaler: t(2, "GCP::Compute::Autoscaler"),
  google_compute_region_autoscaler: t(2, "GCP::Compute::RegionAutoscaler"),
  google_compute_disk: t(1, "GCP::Compute::Disk"),
  google_compute_snapshot: t(2, "GCP::Compute::Snapshot"),
  google_compute_image: t(2, "GCP::Compute::Image"),
  google_compute_resource_policy: t(2, "GCP::Compute::ResourcePolicy"),
  google_compute_project_metadata: t(2, "GCP::Compute::ProjectMetadata", null),

  // ── Compute: networking ──
  google_compute_network: t(1, "GCP::Compute::Network"),
  google_compute_subnetwork: t(2, "GCP::Compute::Subnetwork"),
  google_compute_firewall: t(2, "GCP::Compute::Firewall"),
  google_compute_route: t(2, "GCP::Compute::Route"),
  google_compute_router: t(2, "GCP::Compute::Router"),
  google_compute_router_nat: t(2, "GCP::Compute::RouterNAT"),
  google_compute_router_interface: t(2, "GCP::Compute::RouterInterface"),
  google_compute_router_peer: t(2, "GCP::Compute::RouterPeer"),
  google_compute_address: t(1, "GCP::Compute::Address"),
  // Global and regional addresses are one CNRM type, split by `location`.
  google_compute_global_address: t(2, "GCP::Compute::Address"),
  google_compute_network_peering: t(2, "GCP::Compute::NetworkPeering"),
  google_compute_shared_vpc_host_project: t(1, "GCP::Compute::SharedVPCHostProject", null),
  google_compute_shared_vpc_service_project: t(1, "GCP::Compute::SharedVPCServiceProject", null),
  google_compute_network_endpoint_group: t(2, "GCP::Compute::NetworkEndpointGroup"),
  google_compute_region_network_endpoint_group: t(2, "GCP::Compute::RegionNetworkEndpointGroup"),
  google_compute_service_attachment: t(2, "GCP::Compute::ServiceAttachment"),
  // The classic VPN gateway is CNRM's TargetVPNGateway; the HA one is VPNGateway.
  google_compute_vpn_gateway: t(2, "GCP::Compute::TargetVPNGateway"),
  google_compute_ha_vpn_gateway: t(2, "GCP::Compute::VPNGateway"),
  google_compute_external_vpn_gateway: t(2, "GCP::Compute::ExternalVPNGateway"),
  google_compute_vpn_tunnel: t(2, "GCP::Compute::VPNTunnel"),
  google_compute_interconnect_attachment: t(2, "GCP::Compute::InterconnectAttachment"),

  // ── Compute: load balancing ──
  google_compute_backend_service: t(2, "GCP::Compute::BackendService"),
  google_compute_region_backend_service: t(2, "GCP::Compute::BackendService"),
  google_compute_backend_bucket: t(2, "GCP::Compute::BackendBucket"),
  google_compute_health_check: t(2, "GCP::Compute::HealthCheck"),
  google_compute_region_health_check: t(2, "GCP::Compute::HealthCheck"),
  google_compute_http_health_check: t(2, "GCP::Compute::HTTPHealthCheck"),
  google_compute_https_health_check: t(2, "GCP::Compute::HTTPSHealthCheck"),
  google_compute_url_map: t(2, "GCP::Compute::URLMap"),
  google_compute_region_url_map: t(2, "GCP::Compute::URLMap"),
  google_compute_target_http_proxy: t(2, "GCP::Compute::TargetHTTPProxy"),
  google_compute_target_https_proxy: t(2, "GCP::Compute::TargetHTTPSProxy"),
  google_compute_target_tcp_proxy: t(2, "GCP::Compute::TargetTCPProxy"),
  google_compute_target_ssl_proxy: t(2, "GCP::Compute::TargetSSLProxy"),
  google_compute_target_grpc_proxy: t(2, "GCP::Compute::TargetGRPCProxy"),
  google_compute_target_pool: t(2, "GCP::Compute::TargetPool"),
  google_compute_target_instance: t(2, "GCP::Compute::TargetInstance"),
  google_compute_forwarding_rule: t(2, "GCP::Compute::ForwardingRule"),
  google_compute_global_forwarding_rule: t(2, "GCP::Compute::ForwardingRule"),
  google_compute_ssl_certificate: t(2, "GCP::Compute::SSLCertificate"),
  google_compute_managed_ssl_certificate: t(2, "GCP::Compute::ManagedSSLCertificate"),
  google_compute_ssl_policy: t(2, "GCP::Compute::SSLPolicy"),
  google_compute_region_ssl_policy: t(2, "GCP::Compute::RegionSSLPolicy"),
  google_compute_security_policy: t(2, "GCP::Compute::SecurityPolicy"),

  // ── GKE and fleet ──
  google_container_cluster: t(3, "GCP::Container::Cluster"),
  google_container_node_pool: t(2, "GCP::Container::NodePool"),
  google_container_attached_cluster: t(3, "GCP::Containerattached::Cluster"),
  google_gke_hub_membership: t(2, "GCP::Gkehub::Membership", "membership_id"),
  google_gke_hub_feature: t(2, "GCP::Gkehub::Feature"),
  google_gke_hub_feature_membership: t(3, "GCP::Gkehub::FeatureMembership", null),
  google_gke_backup_backup_plan: t(2, "GCP::Gkebackup::BackupPlan"),
  google_gke_backup_restore_plan: t(2, "GCP::Gkebackup::RestorePlan"),

  // ── IAM ──
  google_service_account: t(1, "GCP::Iam::ServiceAccount", "account_id"),
  google_service_account_key: t(2, "GCP::Iam::ServiceAccountKey", null),
  google_project_iam_custom_role: t(2, "GCP::Iam::CustomRole", "role_id"),
  google_organization_iam_custom_role: t(2, "GCP::Iam::CustomRole", "role_id"),
  // A per-resource Terraform binding becomes one generic policy object holding
  // a reference to the resource it grants on. Tier 3 for all of them.
  google_project_iam_member: t(3, "GCP::Iam::PolicyMember", null),
  google_project_iam_binding: t(3, "GCP::Iam::PartialPolicy", null),
  google_project_iam_policy: t(3, "GCP::Iam::Policy", null),
  google_project_iam_audit_config: t(3, "GCP::Iam::AuditConfig", null),
  google_folder_iam_member: t(3, "GCP::Iam::PolicyMember", null),
  google_organization_iam_member: t(3, "GCP::Iam::PolicyMember", null),
  google_storage_bucket_iam_member: t(3, "GCP::Iam::PolicyMember", null),
  google_service_account_iam_member: t(3, "GCP::Iam::PolicyMember", null),
  google_pubsub_topic_iam_member: t(3, "GCP::Iam::PolicyMember", null),
  google_kms_crypto_key_iam_member: t(3, "GCP::Iam::PolicyMember", null),
  google_secret_manager_secret_iam_member: t(3, "GCP::Iam::PolicyMember", null),
  google_bigquery_dataset_iam_member: t(3, "GCP::Iam::PolicyMember", null),
  google_iam_workload_identity_pool: t(1, "GCP::Iam::WorkloadIdentityPool", "workload_identity_pool_id"),
  google_iam_workload_identity_pool_provider: t(
    2,
    "GCP::Iam::WorkloadIdentityPoolProvider",
    "workload_identity_pool_provider_id",
  ),
  google_iam_workforce_pool: t(2, "GCP::Iam::WorkforcePool", "workforce_pool_id"),
  google_iam_workforce_pool_provider: t(2, "GCP::Iam::WorkforcePoolProvider", "provider_id"),
  google_iam_deny_policy: t(2, "GCP::Iam::DenyPolicy"),
  google_iam_access_boundary_policy: t(2, "GCP::Iam::AccessBoundaryPolicy"),

  // ── Keys and secrets ──
  google_kms_key_ring: t(1, "GCP::Kms::KeyRing"),
  google_kms_crypto_key: t(2, "GCP::Kms::CryptoKey"),
  google_kms_crypto_key_version: t(2, "GCP::Kms::CryptoKeyVersion", null),
  google_kms_secret_ciphertext: t(2, "GCP::Kms::SecretCiphertext", null),
  google_secret_manager_secret: t(2, "GCP::Secretmanager::Secret", "secret_id"),
  google_secret_manager_secret_version: t(2, "GCP::Secretmanager::SecretVersion", null),

  // ── Databases and analytics ──
  google_sql_database_instance: t(3, "GCP::Sql::Instance"),
  google_sql_database: t(2, "GCP::Sql::Database"),
  google_sql_user: t(2, "GCP::Sql::User"),
  google_sql_ssl_cert: t(2, "GCP::Sql::SSLCert", null),
  google_bigquery_dataset: t(2, "GCP::Bigquery::Dataset", "dataset_id"),
  google_bigquery_table: t(2, "GCP::Bigquery::Table", "table_id"),
  google_bigquery_job: t(2, "GCP::Bigquery::Job", "job_id"),
  google_bigquery_routine: t(2, "GCP::Bigquery::Routine", "routine_id"),
  google_bigquery_connection: t(2, "GCP::Bigqueryconnection::Connection", "connection_id"),
  google_bigtable_instance: t(2, "GCP::Bigtable::Instance"),
  google_bigtable_table: t(2, "GCP::Bigtable::Table"),
  google_bigtable_app_profile: t(2, "GCP::Bigtable::AppProfile", "app_profile_id"),
  google_bigtable_gc_policy: t(2, "GCP::Bigtable::GCPolicy", null),
  google_spanner_instance: t(2, "GCP::Spanner::Instance"),
  google_spanner_database: t(2, "GCP::Spanner::Database"),
  google_firestore_database: t(2, "GCP::Firestore::Database"),
  google_firestore_index: t(2, "GCP::Firestore::Index", null),
  google_datastore_index: t(2, "GCP::Datastore::Index", null),
  google_redis_instance: t(2, "GCP::Redis::Instance"),
  google_redis_cluster: t(2, "GCP::Redis::Cluster"),
  google_memcache_instance: t(2, "GCP::Memcache::Instance"),
  google_alloydb_cluster: t(3, "GCP::Alloydb::Cluster", "cluster_id"),
  google_alloydb_instance: t(2, "GCP::Alloydb::Instance", "instance_id"),
  google_dataproc_cluster: t(3, "GCP::Dataproc::Cluster"),
  google_dataproc_job: t(2, "GCP::Dataproc::Job", null),
  google_dataproc_autoscaling_policy: t(2, "GCP::Dataproc::AutoscalingPolicy", "policy_id"),
  google_dataflow_job: t(2, "GCP::Dataflow::Job"),
  google_dataflow_flex_template_job: t(2, "GCP::Dataflow::FlexTemplateJob"),
  google_composer_environment: t(3, "GCP::Composer::Environment"),
  google_data_fusion_instance: t(2, "GCP::Datafusion::Instance"),

  // ── Messaging and serverless ──
  google_pubsub_topic: t(1, "GCP::Pubsub::Topic"),
  google_pubsub_subscription: t(2, "GCP::Pubsub::Subscription"),
  google_pubsub_schema: t(1, "GCP::Pubsub::Schema"),
  google_cloud_tasks_queue: t(2, "GCP::Cloudtasks::TasksQueue"),
  google_cloud_scheduler_job: t(2, "GCP::Cloudscheduler::Job"),
  google_eventarc_trigger: t(2, "GCP::Eventarc::Trigger"),
  google_eventarc_channel: t(2, "GCP::Eventarc::Channel"),
  google_cloud_run_service: t(3, "GCP::Run::Service"),
  google_cloud_run_v2_service: t(3, "GCP::Run::Service"),
  google_cloud_run_v2_job: t(3, "GCP::Run::Job"),
  google_cloudfunctions_function: t(2, "GCP::Cloudfunctions::Function"),
  google_cloudfunctions2_function: t(3, "GCP::Cloudfunctions2::Function"),
  google_workflows_workflow: t(2, "GCP::Workflows::Workflow"),
  google_vpc_access_connector: t(2, "GCP::Vpcaccess::Connector"),

  // ── DNS ──
  google_dns_managed_zone: t(2, "GCP::Dns::ManagedZone"),
  google_dns_record_set: t(2, "GCP::Dns::RecordSet"),
  google_dns_policy: t(2, "GCP::Dns::Policy"),
  google_dns_response_policy: t(2, "GCP::Dns::ResponsePolicy", "response_policy_name"),
  google_dns_response_policy_rule: t(2, "GCP::Dns::ResponsePolicyRule", "rule_name"),

  // ── Logging and monitoring ──
  google_logging_project_sink: t(2, "GCP::Logging::LogSink"),
  google_logging_folder_sink: t(2, "GCP::Logging::LogSink"),
  google_logging_organization_sink: t(2, "GCP::Logging::LogSink"),
  google_logging_billing_account_sink: t(2, "GCP::Logging::LogSink"),
  google_logging_metric: t(2, "GCP::Logging::LogMetric"),
  google_logging_project_exclusion: t(2, "GCP::Logging::LogExclusion"),
  google_logging_project_bucket_config: t(2, "GCP::Logging::LogBucket", "bucket_id"),
  google_logging_log_view: t(2, "GCP::Logging::LogView"),
  google_monitoring_alert_policy: t(2, "GCP::Monitoring::AlertPolicy", "display_name"),
  google_monitoring_notification_channel: t(2, "GCP::Monitoring::NotificationChannel", "display_name"),
  google_monitoring_dashboard: t(2, "GCP::Monitoring::Dashboard", null),
  google_monitoring_uptime_check_config: t(2, "GCP::Monitoring::UptimeCheckConfig", "display_name"),
  google_monitoring_group: t(2, "GCP::Monitoring::Group", "display_name"),
  google_monitoring_custom_service: t(2, "GCP::Monitoring::Service", "display_name"),
  google_monitoring_slo: t(2, "GCP::Monitoring::ServiceLevelObjective", null),
  google_monitoring_monitored_project: t(1, "GCP::Monitoring::MonitoredProject", null),

  // ── Build, registry, deploy ──
  google_artifact_registry_repository: t(2, "GCP::Artifactregistry::Repository", "repository_id"),
  google_cloudbuild_trigger: t(3, "GCP::Cloudbuild::Trigger"),
  google_cloudbuild_worker_pool: t(2, "GCP::Cloudbuild::WorkerPool"),
  google_sourcerepo_repository: t(1, "GCP::Sourcerepo::Repository"),
  google_clouddeploy_target: t(2, "GCP::Clouddeploy::Target"),
  google_clouddeploy_delivery_pipeline: t(2, "GCP::Clouddeploy::DeliveryPipeline"),
  google_clouddeploy_automation: t(2, "GCP::Clouddeploy::Automation"),

  // ── Project, folder, org ──
  google_project: t(2, "GCP::Resourcemanager::Project", "project_id"),
  google_folder: t(2, "GCP::Resourcemanager::Folder", "display_name"),
  google_project_service: t(2, "GCP::Serviceusage::Service", "service"),
  google_service_networking_connection: t(2, "GCP::Servicenetworking::Connection", null),
  google_tags_tag_key: t(1, "GCP::Tags::TagKey", "short_name"),
  google_tags_tag_value: t(1, "GCP::Tags::TagValue", "short_name"),
  google_tags_tag_binding: t(2, "GCP::Tags::TagBinding", null),
  google_tags_location_tag_binding: t(2, "GCP::Tags::LocationTagBinding", null),
  google_essential_contacts_contact: t(1, "GCP::Essentialcontacts::Contact", "email"),
  google_org_policy_policy: t(2, "GCP::Orgpolicy::Policy"),
  google_org_policy_custom_constraint: t(2, "GCP::Orgpolicy::CustomConstraint"),
  google_billing_budget: t(2, "GCP::Billingbudgets::Budget", "display_name"),
  google_resource_manager_lien: t(2, "GCP::Resourcemanager::Lien", null),
  google_apikeys_key: t(2, "GCP::Apikeys::Key"),

  // ── Security ──
  google_binary_authorization_policy: t(3, "GCP::Binaryauthorization::Policy", null),
  google_binary_authorization_attestor: t(2, "GCP::Binaryauthorization::Attestor"),
  google_privateca_ca_pool: t(2, "GCP::Privateca::CAPool"),
  google_privateca_certificate_authority: t(3, "GCP::Privateca::CertificateAuthority", "certificate_authority_id"),
  google_privateca_certificate: t(2, "GCP::Privateca::Certificate"),
  google_privateca_certificate_template: t(2, "GCP::Privateca::CertificateTemplate"),
  google_certificate_manager_certificate: t(2, "GCP::Certificatemanager::Certificate"),
  google_certificate_manager_certificate_map: t(2, "GCP::Certificatemanager::CertificateMap"),
  google_certificate_manager_certificate_map_entry: t(2, "GCP::Certificatemanager::CertificateMapEntry"),
  google_certificate_manager_dns_authorization: t(2, "GCP::Certificatemanager::DNSAuthorization"),
  google_network_security_authorization_policy: t(2, "GCP::Networksecurity::AuthorizationPolicy"),
  google_network_security_client_tls_policy: t(2, "GCP::Networksecurity::ClientTLSPolicy"),
  google_network_security_server_tls_policy: t(2, "GCP::Networksecurity::ServerTLSPolicy"),

  // ── Network services and service directory ──
  google_network_services_gateway: t(2, "GCP::Networkservices::Gateway"),
  google_network_services_mesh: t(2, "GCP::Networkservices::Mesh"),
  google_network_services_http_route: t(2, "GCP::Networkservices::HTTPRoute"),
  google_network_services_grpc_route: t(2, "GCP::Networkservices::GRPCRoute"),
  google_network_services_tcp_route: t(2, "GCP::Networkservices::TCPRoute"),
  google_network_services_tls_route: t(2, "GCP::Networkservices::TLSRoute"),
  google_network_services_endpoint_policy: t(2, "GCP::Networkservices::EndpointPolicy"),
  google_network_connectivity_hub: t(2, "GCP::Networkconnectivity::Hub"),
  google_network_connectivity_spoke: t(2, "GCP::Networkconnectivity::Spoke"),
  google_network_connectivity_internal_range: t(2, "GCP::Networkconnectivity::InternalRange"),
  google_network_management_connectivity_test: t(2, "GCP::Networkmanagement::ConnectivityTest"),
  google_service_directory_namespace: t(1, "GCP::Servicedirectory::Namespace", "namespace_id"),
  google_service_directory_service: t(2, "GCP::Servicedirectory::Service", "service_id"),
  google_service_directory_endpoint: t(2, "GCP::Servicedirectory::Endpoint", "endpoint_id"),

  // ── API Gateway ──
  google_api_gateway_api: t(2, "GCP::Apigateway::API", "api_id"),
  google_api_gateway_api_config: t(3, "GCP::Apigateway::APIConfig", "api_config_id"),
  google_api_gateway_gateway: t(2, "GCP::Apigateway::Gateway", "gateway_id"),
};

/** Terraform type → tier, the shape the registry merges into the tier map. */
export const GCP_TIERS: Readonly<Record<string, TierInfo>> = Object.fromEntries(
  Object.entries(TABLE).map(([tfType, row]) => [tfType, { tier: row.tier, mapsTo: row.mapsTo }]),
);

/** Terraform type → the HCL attribute carrying its physical name. */
export const GCP_IDENTITY_ATTRS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TABLE)
    .filter(([, row]) => row.identityAttr !== null)
    .map(([tfType, row]) => [tfType, row.identityAttr!]),
);

export const gcpCarveProvider: CarveProvider = {
  name: "gcp",
  tfTypePrefixes: ["google_"],
  lexicon: "gcp",
  tiers: GCP_TIERS,
  identityAttrs: GCP_IDENTITY_ATTRS,
  // No family of google resources collapses into one CNRM resource, so nothing
  // folds. See the module comment.
};
