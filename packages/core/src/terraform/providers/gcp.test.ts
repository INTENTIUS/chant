import { describe, test, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GCP_IDENTITY_ATTRS, GCP_TIERS, gcpCarveProvider } from "./gcp";
import { resolveCarveProvider } from "../carve-provider";
import { canBridge, canCarveEmit, carveEmitTypes, identityAttrOf, foldParentOf, tierMap } from "../tier-map";
import { canAdoptFromState } from "../adopt-state";
import { carveAdvise } from "../../cli/commands/carve";
import { loadHcl2json } from "../parse";

/**
 * The GCP carve provider (#2017). Two things are pinned here: that every
 * `mapsTo` names a Config Connector type the gcp lexicon actually defines, and
 * that coverage cannot silently shrink.
 */
const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const gcpMetaPath = join(repoRoot, "lexicons", "gcp", "dist", "meta.json");

interface MetaEntry {
  kind: string;
  resourceType: string;
}

/**
 * Every Config Connector type the gcp lexicon defines, read from the bundle the
 * lexicon's own codegen writes. A `mapsTo` checked against a hand-copied list
 * would only prove the list agrees with itself.
 */
function lexiconResourceTypes(): Set<string> {
  if (!existsSync(gcpMetaPath)) {
    throw new Error(
      `lexicons/gcp/dist/meta.json is missing, so no mapsTo can be verified. Build it with \`just regen\` or \`npm run bundle -w lexicons/gcp\`.`,
    );
  }
  const meta = JSON.parse(readFileSync(gcpMetaPath, "utf-8")) as Record<string, MetaEntry>;
  return new Set(
    Object.values(meta)
      .filter((entry) => entry?.kind === "resource" && typeof entry.resourceType === "string")
      .map((entry) => entry.resourceType),
  );
}

const googleTierTypes = Object.keys(tierMap())
  .filter((t) => t.startsWith("google_"))
  .sort();

describe("GCP carve coverage (#2017)", () => {
  test("every mapsTo is a Config Connector type the gcp lexicon defines", () => {
    // A tier entry pointing at a type chant cannot build is worse than no
    // entry: the report promises a carve target that does not exist.
    const real = lexiconResourceTypes();
    const dangling = Object.entries(GCP_TIERS)
      .filter(([, info]) => !real.has(info.mapsTo))
      .map(([tfType, info]) => `${tfType} -> ${info.mapsTo}`);
    expect(dangling).toEqual([]);
  });

  test("coverage cannot shrink (no cliff)", () => {
    // The floors are the guard: an entry removed, or a whole family dropped in
    // a refactor, fails here instead of quietly narrowing what advise ranks.
    expect(googleTierTypes.length).toBeGreaterThanOrEqual(200);
    expect(Object.keys(GCP_IDENTITY_ATTRS).length).toBeGreaterThanOrEqual(170);

    // The tier map's google_ half is exactly this provider's table — nothing
    // ranks google types from anywhere else.
    expect(googleTierTypes).toEqual(Object.keys(GCP_TIERS).sort());
    for (const tfType of googleTierTypes) {
      expect(resolveCarveProvider(tfType)).toBe(gcpCarveProvider);
    }
  });

  test("covers the common carve targets across families", () => {
    for (const tfType of [
      // storage, compute, networking
      "google_storage_bucket", "google_compute_network", "google_compute_subnetwork",
      "google_compute_firewall", "google_compute_router", "google_compute_router_nat",
      "google_compute_address", "google_compute_instance", "google_compute_disk",
      "google_compute_backend_service", "google_compute_url_map", "google_compute_forwarding_rule",
      // GKE and fleet
      "google_container_cluster", "google_container_node_pool", "google_gke_hub_membership",
      // identity
      "google_service_account", "google_project_iam_custom_role", "google_project_iam_member",
      "google_iam_workload_identity_pool", "google_iam_workload_identity_pool_provider",
      // keys, secrets
      "google_kms_key_ring", "google_kms_crypto_key", "google_secret_manager_secret",
      // data
      "google_sql_database_instance", "google_bigquery_dataset", "google_bigquery_table",
      "google_spanner_instance", "google_bigtable_instance", "google_redis_instance",
      "google_filestore_instance", "google_dataproc_cluster", "google_composer_environment",
      // messaging, serverless
      "google_pubsub_topic", "google_pubsub_subscription", "google_cloud_run_v2_service",
      "google_cloudfunctions2_function", "google_cloud_scheduler_job", "google_workflows_workflow",
      // dns, observability
      "google_dns_managed_zone", "google_dns_record_set", "google_logging_project_sink",
      "google_logging_metric", "google_monitoring_alert_policy",
      // build, project, security
      "google_artifact_registry_repository", "google_cloudbuild_trigger", "google_project",
      "google_project_service", "google_privateca_ca_pool", "google_certificate_manager_certificate",
    ]) {
      expect(GCP_TIERS[tfType]).toBeDefined();
    }
  });

  test("tiers reflect the reshaping the CNRM constructor demands", () => {
    expect(GCP_TIERS.google_storage_bucket).toEqual({ tier: 1, mapsTo: "GCP::Storage::Bucket" });
    expect(GCP_TIERS.google_pubsub_topic).toEqual({ tier: 1, mapsTo: "GCP::Pubsub::Topic" });
    expect(GCP_TIERS.google_compute_network).toEqual({ tier: 1, mapsTo: "GCP::Compute::Network" });
    // A sibling reference becomes a *Ref object, so the subnetwork reshapes.
    expect(GCP_TIERS.google_compute_subnetwork.tier).toBe(2);
    // Node pools inline into the cluster; the instance settles under `settings`.
    expect(GCP_TIERS.google_container_cluster.tier).toBe(3);
    expect(GCP_TIERS.google_sql_database_instance.tier).toBe(3);
    // Every per-resource IAM membership lands on the one generic policy member.
    for (const tfType of [
      "google_project_iam_member",
      "google_folder_iam_member",
      "google_storage_bucket_iam_member",
      "google_service_account_iam_member",
      "google_kms_crypto_key_iam_member",
    ]) {
      expect(GCP_TIERS[tfType]).toEqual({ tier: 3, mapsTo: "GCP::Iam::PolicyMember" });
    }
    // Two Terraform types for one CNRM type is fine; the reverse is not checked.
    expect(GCP_TIERS.google_compute_global_address.mapsTo).toBe(GCP_TIERS.google_compute_address.mapsTo);
  });

  test("identity attributes name the HCL attribute holding the physical name", () => {
    expect(identityAttrOf("google_storage_bucket")).toBe("name");
    expect(identityAttrOf("google_service_account")).toBe("account_id");
    expect(identityAttrOf("google_bigquery_dataset")).toBe("dataset_id");
    expect(identityAttrOf("google_bigquery_table")).toBe("table_id");
    expect(identityAttrOf("google_secret_manager_secret")).toBe("secret_id");
    expect(identityAttrOf("google_artifact_registry_repository")).toBe("repository_id");
    expect(identityAttrOf("google_project")).toBe("project_id");
    expect(identityAttrOf("google_project_service")).toBe("service");
    expect(identityAttrOf("google_project_iam_custom_role")).toBe("role_id");
    expect(identityAttrOf("google_iam_workload_identity_pool")).toBe("workload_identity_pool_id");
    expect(identityAttrOf("google_monitoring_alert_policy")).toBe("display_name");
    expect(identityAttrOf("google_tags_tag_key")).toBe("short_name");
    expect(identityAttrOf("google_essential_contacts_contact")).toBe("email");

    // A binding has no name of its own, so it declares none and the graph
    // falls back to the Terraform logical name.
    expect(identityAttrOf("google_project_iam_member")).toBeUndefined();

    // Every identity entry is for a type the table ranks.
    for (const tfType of Object.keys(GCP_IDENTITY_ATTRS)) {
      expect(GCP_TIERS[tfType]).toBeDefined();
    }
    // No dotted paths, so `carve bridge` can render a flat data-source body.
    for (const tfType of googleTierTypes) expect(canBridge(tfType)).toBe(true);
  });

  test("advise ranks GCP and emit refuses it on both paths", () => {
    // Advise-only: the provider declares no emitTypes and no adopt, so the
    // shared emit gate says no for every ranked type rather than accepting on
    // --env what --state would reject (#2015).
    expect(gcpCarveProvider.emitTypes).toBeUndefined();
    expect(gcpCarveProvider.adopt).toBeUndefined();
    expect(gcpCarveProvider.liveSelectorType).toBeUndefined();
    for (const tfType of googleTierTypes) {
      expect(canCarveEmit(tfType)).toBe(false);
      expect(canAdoptFromState(tfType)).toBe(false);
    }
    expect(carveEmitTypes().filter((t) => t.startsWith("google_"))).toEqual([]);
  });

  test("nothing folds: google and CNRM granularity match", () => {
    expect(gcpCarveProvider.foldsInto).toBeUndefined();
    for (const tfType of googleTierTypes) expect(foldParentOf(tfType)).toBeUndefined();
  });
});

/**
 * The advisor over a google-provider estate, end to end through the registry.
 * Skips cleanly when the optional wasm HCL parser is absent, like the AWS
 * sample-estate test.
 */
let parserAvailable = false;
try {
  await loadHcl2json();
  parserAvailable = true;
} catch {
  parserAvailable = false;
}

const ESTATE = fileURLToPath(new URL("../__fixtures__/gcp-estate", import.meta.url));

describe("carve advise against the GCP sample estate (#2017)", () => {
  test("bands a google estate", async () => {
    if (!parserAvailable) return;
    const r = await carveAdvise({ from: ESTATE });
    expect(r.ok).toBe(true);
    const byAddr = Object.fromEntries((r.results ?? []).map((x) => [x.address, x]));
    expect(Object.keys(byAddr)).toHaveLength(10);

    // Clean leaves: a tier-1 bucket with no edges, and a service account whose
    // identity is account_id.
    expect(byAddr["google_storage_bucket.assets"].score).toBe(100);
    expect(byAddr["google_storage_bucket.assets"].band).toBe("clean leaf");
    expect(byAddr["google_service_account.runner"].score).toBe(100);

    // The graph read each physical name through the provider's identity attr,
    // which is account_id for a service account and name for the bucket.
    const identityOf = (address: string) => r.graph?.nodes.find((n) => n.address === address)?.identity;
    expect(identityOf("google_service_account.runner")).toBe("myapp-runner");
    expect(identityOf("google_storage_bucket.assets")).toBe("myapp-assets-prod");

    // Tier 1 with one inbound subscription.
    expect(byAddr["google_pubsub_topic.events"].score).toBe(88);
    // Tier 2 with one outbound edge to the topic.
    expect(byAddr["google_pubsub_subscription.worker"].score).toBe(81);

    // The hub: four survivors read the network, so carving it is real work.
    expect(byAddr["google_compute_network.main"].score).toBe(52);
    expect(byAddr["google_compute_network.main"].band).toBe("carvable w/ edits");
    expect(byAddr["google_compute_network.main"].breakdown.inbound).toBe(4);

    // Tier 3 with two outbound edges.
    expect(byAddr["google_container_cluster.primary"].breakdown.tier).toBe(3);
    expect(byAddr["google_container_cluster.primary"].score).toBe(62);

    // Unsupported provider still scores 0 beside a ranked google estate.
    expect(byAddr["random_pet.suffix"].score).toBe(0);
    expect(byAddr["random_pet.suffix"].band).toBe("leave in Terraform");
  });
});
