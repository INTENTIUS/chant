import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { tf003 } from "./tf003";
import { loadFixture } from "./fixtures/load";
import { TERRAFORM_TYPE, terraformEntity } from "../../hcl/parse";

function makeCtx(entities: Record<string, ReturnType<typeof terraformEntity>>): PostSynthContext {
  return {
    outputs: new Map(),
    entities: new Map(Object.entries(entities)),
  } as unknown as PostSynthContext;
}

function terraformBlock(root: string, body: Record<string, unknown>): ReturnType<typeof terraformEntity> {
  return terraformEntity(TERRAFORM_TYPE, "terraform", body, "main.tf", root);
}

describe("TF003: root module's terraform block has no required_version", () => {
  test("check metadata", () => {
    expect(tf003.id).toBe("TF003");
    expect(tf003.description).toContain("required_version");
  });

  test("flags a terraform block missing required_version", async () => {
    const diags = tf003.check(await loadFixture("TF003", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF003");
    expect(diags[0].entity).toBe("TF003/terraform");
    expect(diags[0].lexicon).toBe("terraform");
  });

  test("passes a terraform block with required_version", async () => {
    const diags = tf003.check(await loadFixture("TF003", "negative"));
    expect(diags).toHaveLength(0);
  });

  test("fires once per root even split across two terraform blocks", () => {
    const diags = tf003.check(
      makeCtx({
        "app/terraform": terraformBlock("app", {}),
        "app/terraform~2": terraformBlock("app", { required_providers: [{}] }),
      }),
    );
    expect(diags).toHaveLength(1);
  });

  test("passes when required_version is declared on a later block for the same root", () => {
    const diags = tf003.check(
      makeCtx({
        "app/terraform": terraformBlock("app", {}),
        "app/terraform~2": terraformBlock("app", { required_version: ">= 1.5.0" }),
      }),
    );
    expect(diags).toHaveLength(0);
  });

  test("reports each root separately", () => {
    const diags = tf003.check(
      makeCtx({
        "legacy/terraform": terraformBlock("legacy", {}),
        "app/terraform": terraformBlock("app", { required_version: ">= 1.5.0" }),
      }),
    );
    expect(diags.map((d) => d.entity)).toEqual(["legacy/terraform"]);
  });

  test("ignores a root with no terraform block at all", () => {
    const diags = tf003.check(
      makeCtx({
        "app/null_resource.first": terraformEntity("Terraform::Resource", "null_resource.first", {}, "main.tf", "app"),
      }),
    );
    expect(diags).toHaveLength(0);
  });
});
