import { describe, expect, test } from "vitest";
import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { blocksToEntities } from "../../hcl/parse";
import { loadFixture } from "./fixtures/load";
import { tf037 } from "./tf037";

async function inline(source: string): Promise<PostSynthContext> {
  const entities = await blocksToEntities([{ name: "main.tf", source }], "app");
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

const verdicts = (d: PostSynthDiagnostic[]) => d.map((x) => `${x.severity} ${x.entity}`).sort();

describe("TF037 over vendored real-world fixtures", () => {
  test("IMMUTABLE is silent (aws-samples/sample-scribe-ai)", async () => {
    expect(tf037.check(await loadFixture("TF037", "negative"))).toEqual([]);
  });

  test("IMMUTABLE_WITH_EXCLUSION with named moving tags is silent (lexicalunit/spellbot)", async () => {
    expect(tf037.check(await loadFixture("TF037", "negative-exclusion"))).toEqual([]);
  });

  test("MUTABLE is an error (bridgecrewio/terragoat)", async () => {
    const diags = tf037.check(await loadFixture("TF037", "positive"));
    expect(verdicts(diags)).toEqual(["error TF037/aws_ecr_repository.repository"]);
    expect(diags[0]).toMatchObject({ checkId: "TF037", lexicon: "terraform" });
  });

  test("a repository that does not set image_tag_mutability is an error: the default is MUTABLE (outerbounds)", async () => {
    const diags = tf037.check(await loadFixture("TF037", "positive-absent"));
    expect(verdicts(diags)).toEqual(["error TF037/aws_ecr_repository.metaflow_batch_image"]);
    expect(diags[0].message).toContain("the provider default is `MUTABLE`");
  });

  test("a variable is not determined, whatever its default (turnerlabs/terraform-ecs-fargate)", async () => {
    const diags = tf037.check(await loadFixture("TF037", "not-determined"));
    expect(verdicts(diags)).toEqual(["info TF037/aws_ecr_repository.app"]);
    expect(diags[0].message).toContain("var.image_tag_mutability");
  });
});

describe("TF037 cases the fixtures do not isolate", () => {
  test("MUTABLE_WITH_EXCLUSION and a match-everything exclusion filter are errors", async () => {
    const diags = tf037.check(
      await inline(`
resource "aws_ecr_repository" "mostly_mutable" {
  image_tag_mutability = "MUTABLE_WITH_EXCLUSION"
  image_tag_mutability_exclusion_filter {
    filter      = "release-*"
    filter_type = "WILDCARD"
  }
}
resource "aws_ecr_repository" "star" {
  image_tag_mutability = "IMMUTABLE_WITH_EXCLUSION"
  image_tag_mutability_exclusion_filter {
    filter      = "*"
    filter_type = "WILDCARD"
  }
}`),
    );
    expect(verdicts(diags)).toEqual(["error app/aws_ecr_repository.mostly_mutable", "error app/aws_ecr_repository.star"]);
    expect(diags.find((d) => d.entity === "app/aws_ecr_repository.star")!.message).toContain("matches every tag");
  });

  test("an exclusion filter from an expression or a dynamic block is not determined", async () => {
    const diags = tf037.check(
      await inline(`
resource "aws_ecr_repository" "f" {
  image_tag_mutability = "IMMUTABLE_WITH_EXCLUSION"
  image_tag_mutability_exclusion_filter {
    filter      = var.moving_tag
    filter_type = "WILDCARD"
  }
}
resource "aws_ecr_repository" "d" {
  image_tag_mutability = "IMMUTABLE_WITH_EXCLUSION"
  dynamic "image_tag_mutability_exclusion_filter" {
    for_each = var.filters
    content {
      filter      = image_tag_mutability_exclusion_filter.value
      filter_type = "WILDCARD"
    }
  }
}`),
    );
    expect(verdicts(diags)).toEqual(["info app/aws_ecr_repository.d", "info app/aws_ecr_repository.f"]);
  });
});
