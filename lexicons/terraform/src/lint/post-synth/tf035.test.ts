import { describe, expect, test } from "vitest";
import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { blocksToEntities } from "../../hcl/parse";
import { loadFixture } from "./fixtures/load";
import { tf035 } from "./tf035";

async function inline(source: string): Promise<PostSynthContext> {
  const entities = await blocksToEntities([{ name: "main.tf", source }], "app");
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

const verdicts = (d: PostSynthDiagnostic[]) => d.map((x) => `${x.severity} ${x.entity}`).sort();

describe("TF035 over vendored real-world fixtures (cds-snc/notification-terraform)", () => {
  test("sqs_managed_sse_enabled = true is silent", async () => {
    expect(tf035.check(await loadFixture("TF035", "negative"))).toEqual([]);
  });

  test("sqs_managed_sse_enabled = false with no key is a warning", async () => {
    const diags = tf035.check(await loadFixture("TF035", "positive"));
    expect(verdicts(diags)).toEqual(["warning TF035/aws_sqs_queue.notify_internal_tasks_queue"]);
    expect(diags[0]).toMatchObject({ checkId: "TF035", lexicon: "terraform" });
  });

  test("a queue that sets neither attribute is silent: AWS encrypts it with SSE-SQS by default", async () => {
    expect(tf035.check(await loadFixture("TF035", "negative-absent"))).toEqual([]);
  });
});

describe("TF035 cases the fixtures do not isolate", () => {
  test("a KMS key beside sqs_managed_sse_enabled = false, or a variable key alone, is encrypted", async () => {
    const diags = tf035.check(
      await inline(`
resource "aws_sqs_queue" "kms" {
  kms_master_key_id = "alias/aws/sqs"
}
resource "aws_sqs_queue" "managed_key" {
  kms_master_key_id = aws_kms_key.sqs.arn
}
resource "aws_sqs_queue" "var_key_default_sse" {
  kms_master_key_id = var.kms_key
}`),
    );
    expect(diags).toEqual([]);
  });

  test("an expression for sqs_managed_sse_enabled, or a variable key beside false, is not determined", async () => {
    const diags = tf035.check(
      await inline(`
resource "aws_sqs_queue" "sse_var" {
  sqs_managed_sse_enabled = var.sse
}
resource "aws_sqs_queue" "off_var_key" {
  sqs_managed_sse_enabled = false
  kms_master_key_id       = var.kms_key
}
resource "aws_sqs_queue" "off_empty_key" {
  sqs_managed_sse_enabled = false
  kms_master_key_id       = ""
}`),
    );
    expect(verdicts(diags)).toEqual([
      "info app/aws_sqs_queue.off_var_key",
      "info app/aws_sqs_queue.sse_var",
      "warning app/aws_sqs_queue.off_empty_key",
    ]);
  });
});
