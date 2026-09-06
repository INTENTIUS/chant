import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { tf002 } from "./tf002";
import { loadFixture } from "./fixtures/load";
import { TERRAFORM_TYPE, PROVIDER_TYPE, RESOURCE_TYPE, terraformEntity } from "../../hcl/parse";

function makeCtx(entities: Record<string, ReturnType<typeof terraformEntity>>): PostSynthContext {
  return {
    outputs: new Map(),
    entities: new Map(Object.entries(entities)),
  } as unknown as PostSynthContext;
}

describe("TF002: provider implied by the root has no required_providers entry", () => {
  test("check metadata", () => {
    expect(tf002.id).toBe("TF002");
    expect(tf002.description).toContain("required_providers");
  });

  test("flags a provider implied by a resource type prefix with no entry at all", async () => {
    const diags = tf002.check(await loadFixture("TF002", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF002");
    expect(diags[0].message).toContain("google");
    expect(diags[0].lexicon).toBe("terraform");
  });

  test("flags the legacy shorthand form as lacking source", async () => {
    const diags = tf002.check(await loadFixture("TF002", "positive-legacy"));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("aws");
    expect(diags[0].message).toContain("source");
  });

  test("flags an entry missing version", async () => {
    const diags = tf002.check(await loadFixture("TF002", "positive-no-version"));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("version");
  });

  test("passes a fully constrained provider", async () => {
    const diags = tf002.check(await loadFixture("TF002", "negative"));
    expect(diags).toHaveLength(0);
  });

  test("fires once per provider, not once per resource", () => {
    const diags = tf002.check(
      makeCtx({
        "app/terraform": terraformEntity(TERRAFORM_TYPE, "terraform", { required_version: ">= 1.5.0" }, "main.tf", "app"),
        "app/aws_instance.a": terraformEntity(RESOURCE_TYPE, "aws_instance.a", {}, "main.tf", "app"),
        "app/aws_instance.b": terraformEntity(RESOURCE_TYPE, "aws_instance.b", {}, "main.tf", "app"),
      }),
    );
    expect(diags).toHaveLength(1);
  });

  test("skips the builtin terraform provider (terraform_remote_state)", () => {
    const diags = tf002.check(
      makeCtx({
        "app/terraform": terraformEntity(TERRAFORM_TYPE, "terraform", { required_version: ">= 1.5.0" }, "main.tf", "app"),
        "app/data.terraform_remote_state.other": terraformEntity(
          "Terraform::Data",
          "data.terraform_remote_state.other",
          {},
          "main.tf",
          "app",
        ),
      }),
    );
    expect(diags).toHaveLength(0);
  });

  test("anchors on the explicit provider block over the resource that also implies it", () => {
    const diags = tf002.check(
      makeCtx({
        "app/terraform": terraformEntity(TERRAFORM_TYPE, "terraform", { required_version: ">= 1.5.0" }, "main.tf", "app"),
        "app/aws_instance.web": terraformEntity(RESOURCE_TYPE, "aws_instance.web", {}, "main.tf", "app"),
        "app/provider.aws": terraformEntity(PROVIDER_TYPE, "provider.aws", {}, "main.tf", "app"),
      }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("app/provider.aws");
  });

  test("ignores a root with no terraform block at all", () => {
    const diags = tf002.check(
      makeCtx({
        "app/aws_instance.web": terraformEntity(RESOURCE_TYPE, "aws_instance.web", {}, "main.tf", "app"),
      }),
    );
    expect(diags).toHaveLength(0);
  });
});
