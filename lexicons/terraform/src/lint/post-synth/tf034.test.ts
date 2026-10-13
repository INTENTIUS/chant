import { describe, expect, test } from "vitest";
import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { blocksToEntities } from "../../hcl/parse";
import { loadFixture } from "./fixtures/load";
import { tf034 } from "./tf034";

async function inline(source: string): Promise<PostSynthContext> {
  const entities = await blocksToEntities([{ name: "main.tf", source }], "app");
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

const verdicts = (d: PostSynthDiagnostic[]) => d.map((x) => `${x.severity} ${x.entity}`).sort();

describe("TF034 over vendored real-world fixtures", () => {
  test("a key from a managed KMS alias is silent (covidgreen/covid-green-infra)", async () => {
    expect(tf034.check(await loadFixture("TF034", "negative"))).toEqual([]);
  });

  test('kms_master_key_id = "" is a warning (KICS test corpus)', async () => {
    const diags = tf034.check(await loadFixture("TF034", "positive"));
    expect(verdicts(diags)).toEqual(["warning TF034/aws_sns_topic.user_updates"]);
    expect(diags[0]).toMatchObject({ checkId: "TF034", lexicon: "terraform" });
    expect(diags[0].message).toContain('sets `kms_master_key_id = ""`');
  });

  test("a topic with no key is a warning: absence is insecure for SNS (radian-software/riju)", async () => {
    const diags = tf034.check(await loadFixture("TF034", "positive-absent"));
    expect(verdicts(diags)).toEqual(["warning TF034/aws_sns_topic.riju"]);
    expect(diags[0].message).toContain("does not set `kms_master_key_id`");
  });
});

describe("TF034 cases the fixtures do not isolate", () => {
  test("the AWS managed alias, a template with literal text and a data source attribute are keys", async () => {
    const diags = tf034.check(
      await inline(`
resource "aws_sns_topic" "managed" {
  kms_master_key_id = "alias/aws/sns"
}
resource "aws_sns_topic" "templated" {
  kms_master_key_id = "alias/\${var.env}-sns"
}
resource "aws_sns_topic" "data" {
  kms_master_key_id = data.aws_kms_key.sns.arn
}`),
    );
    expect(diags).toEqual([]);
  });

  test("a variable, a conditional or a bare interpolation is not determined", async () => {
    const diags = tf034.check(
      await inline(`
resource "aws_sns_topic" "v" {
  kms_master_key_id = var.kms_key_id
}
resource "aws_sns_topic" "c" {
  kms_master_key_id = var.encrypt ? aws_kms_key.k.arn : null
}
resource "aws_sns_topic" "t" {
  kms_master_key_id = "\${var.a}\${var.b}"
}`),
    );
    expect(verdicts(diags)).toEqual(["info app/aws_sns_topic.c", "info app/aws_sns_topic.t", "info app/aws_sns_topic.v"]);
    for (const d of diags) expect(d.message).toMatch(/^Not determined: /);
  });

  test("kms_master_key_id = null is the same as absent", async () => {
    const diags = tf034.check(await inline(`resource "aws_sns_topic" "n" {\n  kms_master_key_id = null\n}`));
    expect(verdicts(diags)).toEqual(["warning app/aws_sns_topic.n"]);
  });
});
