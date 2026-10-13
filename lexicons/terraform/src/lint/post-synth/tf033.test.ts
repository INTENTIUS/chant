import { describe, expect, test } from "vitest";
import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { blocksToEntities } from "../../hcl/parse";
import { loadFixture } from "./fixtures/load";
import { tf033 } from "./tf033";

async function inline(source: string): Promise<PostSynthContext> {
  const entities = await blocksToEntities([{ name: "main.tf", source }], "app");
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

const verdicts = (d: PostSynthDiagnostic[]) => d.map((x) => `${x.severity} ${x.entity}`).sort();

describe("TF033 over vendored real-world fixtures", () => {
  test("storage_encrypted = true is silent (tmknom/example-pragmatic-terraform)", async () => {
    expect(tf033.check(await loadFixture("TF033", "negative"))).toEqual([]);
  });

  test("storage_encrypted = false is an error (bridgecrewio/terragoat)", async () => {
    const diags = tf033.check(await loadFixture("TF033", "positive"));
    expect(verdicts(diags)).toEqual(["error TF033/aws_db_instance.default"]);
    expect(diags[0]).toMatchObject({ checkId: "TF033", lexicon: "terraform" });
    expect(diags[0].message).toContain("sets `storage_encrypted = false`");
  });

  test("an instance that does not set storage_encrypted is an error; snapshot_identifier = \"\" is no source (zoitech)", async () => {
    const diags = tf033.check(await loadFixture("TF033", "positive-absent"));
    expect(verdicts(diags)).toEqual(["error TF033/aws_db_instance.postgres"]);
    expect(diags[0].message).toContain("the provider default is `false`");
  });

  test("an Aurora cluster without storage_encrypted is not determined (bridgecrewio/terragoat)", async () => {
    const diags = tf033.check(await loadFixture("TF033", "not-determined-aurora"));
    expect(verdicts(diags)).toEqual(["info TF033/aws_rds_cluster.app1-rds-cluster"]);
    expect(diags[0].message).toMatch(/^Not determined: /);
    expect(diags[0].message).toContain("2026-02-16");
  });
});

describe("TF033 cases the fixtures do not isolate", () => {
  test("an instance created from a source is not determined unless storage_encrypted = true", async () => {
    const diags = tf033.check(
      await inline(`
resource "aws_db_instance" "replica" {
  replicate_source_db = aws_db_instance.primary.identifier
}
resource "aws_db_instance" "restored" {
  snapshot_identifier = "rds:prod-2026-01-01"
  storage_encrypted   = false
}
resource "aws_db_instance" "pitr" {
  restore_to_point_in_time {
    use_latest_restorable_time = true
  }
}
resource "aws_db_instance" "explicit" {
  snapshot_identifier = "rds:prod-2026-01-01"
  storage_encrypted   = true
}`),
    );
    expect(verdicts(diags)).toEqual([
      "info app/aws_db_instance.pitr",
      "info app/aws_db_instance.replica",
      "info app/aws_db_instance.restored",
    ]);
    expect(diags.find((d) => d.entity === "app/aws_db_instance.replica")!.message).toContain("`replicate_source_db`");
  });

  test("a storage_encrypted expression is not determined; the string \"true\" is true", async () => {
    const diags = tf033.check(
      await inline(`
resource "aws_db_instance" "v" {
  storage_encrypted = var.encrypted
}
resource "aws_db_instance" "s" {
  storage_encrypted = "true"
}`),
    );
    expect(verdicts(diags)).toEqual(["info app/aws_db_instance.v"]);
    expect(diags[0].message).toContain("`storage_encrypted` is an expression (var.encrypted)");
  });

  test("a Multi-AZ DB cluster defaults to unencrypted; Aurora false and an engine expression are not determined", async () => {
    const diags = tf033.check(
      await inline(`
resource "aws_rds_cluster" "multi_az" {
  engine                    = "postgres"
  db_cluster_instance_class = "db.r6gd.large"
}
resource "aws_rds_cluster" "multi_az_off" {
  engine            = "mysql"
  storage_encrypted = false
}
resource "aws_rds_cluster" "aurora_off" {
  engine            = "aurora-postgresql"
  storage_encrypted = false
}
resource "aws_rds_cluster" "engine_var" {
  engine = var.engine
}
resource "aws_rds_cluster" "restored" {
  engine              = "postgres"
  snapshot_identifier = "arn:aws:rds:eu-west-1:111122223333:cluster-snapshot:x"
}
resource "aws_rds_cluster" "serverless_v1" {
  engine      = "aurora-mysql"
  engine_mode = "serverless"
}
resource "aws_rds_cluster" "on" {
  engine            = "postgres"
  storage_encrypted = true
}`),
    );
    expect(verdicts(diags)).toEqual([
      "error app/aws_rds_cluster.multi_az",
      "error app/aws_rds_cluster.multi_az_off",
      "info app/aws_rds_cluster.aurora_off",
      "info app/aws_rds_cluster.engine_var",
      "info app/aws_rds_cluster.restored",
    ]);
  });

  test("aws_rds_cluster_instance is never read", async () => {
    expect(tf033.check(await inline(`resource "aws_rds_cluster_instance" "i" { cluster_identifier = "c" }`))).toEqual([]);
  });
});
