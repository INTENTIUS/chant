import { describe, expect, test } from "vitest";
import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { blocksToEntities } from "../../hcl/parse";
import { loadFixture } from "./fixtures/load";
import { tf036 } from "./tf036";

async function inline(source: string): Promise<PostSynthContext> {
  const entities = await blocksToEntities([{ name: "main.tf", source }], "app");
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

const verdicts = (d: PostSynthDiagnostic[]) => d.map((x) => `${x.severity} ${x.entity}`).sort();

describe("TF036 over vendored real-world fixtures", () => {
  test("encrypted = true is silent (ned1313/terraform-tuesdays)", async () => {
    expect(tf036.check(await loadFixture("TF036", "negative"))).toEqual([]);
  });

  test("encrypted = false is a warning (stelligent/config-lint)", async () => {
    const diags = tf036.check(await loadFixture("TF036", "positive"));
    expect(verdicts(diags)).toEqual(["warning TF036/aws_ebs_volume.vol2"]);
    expect(diags[0]).toMatchObject({ checkId: "TF036", lexicon: "terraform" });
    expect(diags[0].message).toContain("replace it on every apply");
  });

  test("a volume that does not set encrypted is not determined (bridgecrewio/terragoat)", async () => {
    const diags = tf036.check(await loadFixture("TF036", "not-determined"));
    expect(verdicts(diags)).toEqual(["info TF036/aws_ebs_volume.web_host_storage"]);
    expect(diags[0].message).toMatch(/^Not determined: .*EBS encryption by default/);
  });
});

describe("TF036 cases the fixtures do not isolate", () => {
  test("depends_on an enabled aws_ebs_encryption_by_default settles absence", async () => {
    const diags = tf036.check(
      await inline(`
resource "aws_ebs_encryption_by_default" "on" {}
resource "aws_ebs_volume" "ordered" {
  availability_zone = "eu-west-1a"
  size              = 10
  depends_on        = [aws_ebs_encryption_by_default.on]
}
resource "aws_ebs_volume" "unordered" {
  availability_zone = "eu-west-1a"
  size              = 10
}`),
    );
    expect(verdicts(diags)).toEqual(["info app/aws_ebs_volume.unordered"]);
    expect(diags[0].message).toContain("`aws_ebs_encryption_by_default.on` turns the default on in this module");
  });

  test("a disabled default, or one on another provider, does not settle it", async () => {
    const diags = tf036.check(
      await inline(`
resource "aws_ebs_encryption_by_default" "off" {
  enabled = false
}
resource "aws_ebs_encryption_by_default" "west" {
  provider = aws.west
}
resource "aws_ebs_volume" "a" {
  size       = 10
  depends_on = [aws_ebs_encryption_by_default.off]
}
resource "aws_ebs_volume" "b" {
  size       = 10
  depends_on = [aws_ebs_encryption_by_default.west]
}`),
    );
    expect(verdicts(diags)).toEqual(["info app/aws_ebs_volume.a", "info app/aws_ebs_volume.b"]);
  });

  test("snapshot_id is named in the reason; an encrypted expression is not determined", async () => {
    const diags = tf036.check(
      await inline(`
resource "aws_ebs_volume" "snap" {
  snapshot_id = aws_ebs_snapshot.s.id
}
resource "aws_ebs_volume" "v" {
  size      = 10
  encrypted = var.encrypted
}`),
    );
    expect(verdicts(diags)).toEqual(["info app/aws_ebs_volume.snap", "info app/aws_ebs_volume.v"]);
    expect(diags.find((d) => d.entity === "app/aws_ebs_volume.snap")!.message).toContain("`snapshot_id`");
  });
});
