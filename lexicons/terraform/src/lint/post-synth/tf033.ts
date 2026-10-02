/**
 * TF033: an RDS DB instance or cluster does not encrypt its storage
 * (chant #2288, epic #2284).
 *
 * The Terraform counterpart of the aws lexicon's WAW021, written natively.
 * WAW021 reads a template chant synthesized, where `StorageEncrypted` absent
 * means false. Reading somebody else's HCL, absence means different things
 * for the two resources and for how the database is created, so each case is
 * decided here against the provider schema and the AWS default.
 *
 * `aws_db_instance` (provider `internal/service/rds/instance.go`, v6.67.0):
 * `storage_encrypted` is optional, not computed, and the docs say "The
 * default is `false` if not specified". The plain create path and `s3_import`
 * send `StorageEncrypted: d.Get("storage_encrypted")`, so absent means false
 * and is reported. The replica (`replicate_source_db`), snapshot
 * (`snapshot_identifier`) and point-in-time (`restore_to_point_in_time`)
 * paths never send it: the new instance takes its encryption from the source
 * (and a cross-region replica from `kms_key_id`). For those the rule cannot
 * know, and says so, unless `storage_encrypted = true` is written down.
 *
 * `aws_rds_cluster` (`cluster.go`): `storage_encrypted` is optional and
 * computed, sent only when set, and "Terraform will only perform drift
 * detection if a configuration value is provided". Two engine families:
 *
 * - Aurora (`engine` `aurora-mysql`/`aurora-postgresql`, or absent, which
 *   provider v5 defaulted to `aurora`). Since 2026-02-16 AWS encrypts every
 *   new Aurora cluster at rest with an AWS-owned key whatever
 *   `StorageEncrypted` says, and reports `StorageEncrypted: false` with
 *   `StorageEncryptionType: sse-rds` for it. A cluster created before that
 *   date with storage encryption off is unencrypted, and the configuration
 *   does not say when its cluster was created. So an Aurora cluster with
 *   `storage_encrypted` absent or `false` is not determined, not a finding.
 *   `engine_mode = "serverless"` (Serverless v1) was always encrypted and
 *   is not reported at all.
 * - Multi-AZ DB clusters (`engine` `mysql`/`postgres`): the default is
 *   `false` and nothing changed it, so absent or `false` is a finding,
 *   unless the cluster is restored or replicated from a source
 *   (`snapshot_identifier`, `restore_to_point_in_time`,
 *   `replication_source_identifier`, `global_cluster_identifier`), which
 *   again decides the encryption.
 *
 * Not checked: `aws_rds_cluster_instance` (its `storage_encrypted` is
 * computed-only and never appears in a body), `aws_rds_global_cluster`, and
 * whether the key is customer managed.
 *
 * Scope: root and child modules alike (#2112).
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { BlockBody } from "../../hcl/parse";
import type { TerraformBlock } from "./blocks";
import { finding, isGiven, notDetermined, readBool, readString, resourcesOfType, type Read } from "./flat-attributes";

const ID = "TF033";

const NOT_DETERMINED_TAIL =
  "TF033 does not evaluate expressions or read the source database, so it cannot tell whether this storage is encrypted.";

/** The first source argument a body gives, if any. */
function sourceOf(body: BlockBody, names: readonly string[]): string | undefined {
  return names.find((n) => isGiven(body, n));
}

const INSTANCE_SOURCES = ["replicate_source_db", "snapshot_identifier", "restore_to_point_in_time"] as const;
const CLUSTER_SOURCES = [
  "snapshot_identifier",
  "restore_to_point_in_time",
  "replication_source_identifier",
  "global_cluster_identifier",
] as const;

function unencrypted(block: TerraformBlock, encrypted: Read<boolean>, what: string): PostSynthDiagnostic {
  const how =
    encrypted.kind === "absent"
      ? "does not set `storage_encrypted`, and the provider default is `false`"
      : "sets `storage_encrypted = false`";
  return finding(
    ID,
    "error",
    block,
    `${how}, so the ${what} stores its data unencrypted. Set \`storage_encrypted = true\` (and \`kms_key_id\` for a ` +
      "customer managed key). Encryption cannot be turned on in place: an existing database is migrated by restoring " +
      "an encrypted copy of a snapshot.",
  );
}

function checkInstance(block: TerraformBlock): PostSynthDiagnostic | undefined {
  const encrypted = readBool(block.body, "storage_encrypted");
  if (encrypted.kind === "known" && encrypted.value) return undefined;
  if (encrypted.kind === "unknown") return notDetermined(ID, block, encrypted.reason, NOT_DETERMINED_TAIL);
  const source = sourceOf(block.body, INSTANCE_SOURCES);
  if (source) {
    return notDetermined(
      ID,
      block,
      `is created from a source (\`${source}\`), and the provider does not send \`storage_encrypted\` on that path: ` +
        "the instance takes its encryption from the source",
      NOT_DETERMINED_TAIL,
    );
  }
  return unencrypted(block, encrypted, "DB instance");
}

function checkCluster(block: TerraformBlock): PostSynthDiagnostic | undefined {
  const encrypted = readBool(block.body, "storage_encrypted");
  if (encrypted.kind === "known" && encrypted.value) return undefined;
  if (encrypted.kind === "unknown") return notDetermined(ID, block, encrypted.reason, NOT_DETERMINED_TAIL);

  const engine = readString(block.body, "engine");
  if (engine.kind === "unknown") {
    return notDetermined(
      ID,
      block,
      `${engine.reason}, and whether an unset \`storage_encrypted\` means unencrypted depends on the engine`,
      NOT_DETERMINED_TAIL,
    );
  }
  const aurora = engine.kind === "absent" || engine.value.startsWith("aurora");
  if (aurora) {
    const mode = readString(block.body, "engine_mode");
    if (mode.kind === "known" && mode.value === "serverless") return undefined;
    const set = encrypted.kind === "absent" ? "does not set `storage_encrypted`" : "sets `storage_encrypted = false`";
    return notDetermined(
      ID,
      block,
      `is an Aurora cluster that ${set}. AWS encrypts every Aurora cluster created on or after 2026-02-16 with an ` +
        "AWS-owned key whatever this says; one created earlier with storage encryption off is unencrypted, and the " +
        "configuration does not say when the cluster was created",
      "Set `storage_encrypted = true` to make the answer explicit.",
    );
  }
  const source = sourceOf(block.body, CLUSTER_SOURCES);
  if (source) {
    return notDetermined(
      ID,
      block,
      `is created from a source (\`${source}\`), which decides its encryption`,
      NOT_DETERMINED_TAIL,
    );
  }
  return unencrypted(block, encrypted, "Multi-AZ DB cluster");
}

export const tf033: PostSynthCheck = {
  id: "TF033",
  description: "RDS DB instance or cluster storage is not encrypted",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const out: PostSynthDiagnostic[] = [];
    for (const block of resourcesOfType(ctx, "aws_db_instance")) {
      const d = checkInstance(block);
      if (d) out.push(d);
    }
    for (const block of resourcesOfType(ctx, "aws_rds_cluster")) {
      const d = checkCluster(block);
      if (d) out.push(d);
    }
    return out;
  },
};
