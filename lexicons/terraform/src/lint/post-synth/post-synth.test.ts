import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { tf001 } from "./tf001";
import { loadFixture } from "./fixtures/load";
import { TERRAFORM_TYPE, terraformEntity } from "../../hcl/parse";

/**
 * The local context builder for the edge cases below that are about the
 * *collection* (several roots or several blocks sharing one root), not about
 * one root's parsed shape, which is what real HCL fixtures represent. The two
 * headline cases (a backendless root, a root with a backend) go through
 * `fixtures/TF001/` and `loadFixture` instead; see that module's doc comment
 * for why.
 */
function makeCtx(entities: Record<string, ReturnType<typeof terraformEntity>>): PostSynthContext {
  return {
    outputs: new Map(),
    entities: new Map(Object.entries(entities)),
  } as unknown as PostSynthContext;
}

/** A `terraform` block entity for root `name`, carrying `body` verbatim. */
function terraformBlock(root: string, body: Record<string, unknown>): ReturnType<typeof terraformEntity> {
  return terraformEntity(TERRAFORM_TYPE, "terraform", body, "main.tf", root);
}

describe("TF001: root module declares no remote backend", () => {
  test("flags a root whose terraform block has no backend", async () => {
    const diags = tf001.check(await loadFixture("TF001", "positive"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF001");
    expect(diags[0].entity).toBe("TF001/terraform");
    expect(diags[0].lexicon).toBe("terraform");
    expect(diags[0].message).toContain("TF001");
    expect(diags[0].missing).toEqual({ kind: "backend", scope: "TF001" });
  });

  test("passes a root with a backend block", async () => {
    const diags = tf001.check(await loadFixture("TF001", "negative"));
    expect(diags).toHaveLength(0);
  });

  test("passes a root using Terraform Cloud's cloud block", () => {
    const diags = tf001.check(
      makeCtx({
        "app/terraform": terraformBlock("app", {
          cloud: [{ organization: "acme", workspaces: { name: "app" } }],
        }),
      }),
    );
    expect(diags).toHaveLength(0);
  });

  test("fires once per root, not once per terraform block", () => {
    const diags = tf001.check(
      makeCtx({
        "legacy/terraform": terraformBlock("legacy", {}),
        "legacy/terraform~2": terraformBlock("legacy", { required_version: ">= 1.5.0" }),
      }),
    );
    expect(diags).toHaveLength(1);
  });

  test("reports each backendless root separately", () => {
    const diags = tf001.check(
      makeCtx({
        "legacy/terraform": terraformBlock("legacy", {}),
        "other/terraform": terraformBlock("other", {}),
        "app/terraform": terraformBlock("app", { backend: { s3: [{ bucket: "tfstate" }] } }),
      }),
    );
    expect(diags.map((d) => d.entity).sort()).toEqual(["legacy/terraform", "other/terraform"]);
  });

  test("ignores a root with no terraform block at all", () => {
    const diags = tf001.check(
      makeCtx({
        "app/null_resource.first": terraformEntity(
          "Terraform::Resource",
          "null_resource.first",
          {},
          "main.tf",
          "app",
        ),
      }),
    );
    expect(diags).toHaveLength(0);
  });

  test("treats an empty backend value as absent", () => {
    const diags = tf001.check(makeCtx({ "app/terraform": terraformBlock("app", { backend: {} }) }));
    expect(diags).toHaveLength(1);
  });
});
