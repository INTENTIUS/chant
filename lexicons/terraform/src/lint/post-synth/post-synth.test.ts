import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { backendTypes, hasRemoteBackend, tf001 } from "./tf001";
import { loadFixture } from "./fixtures/load";
import { TERRAFORM_TYPE, terraformEntity } from "../../hcl/parse";

/**
 * The local context builder for the edge cases below that are about the
 * *collection* (several roots or several blocks sharing one root), not about
 * one root's parsed shape, which is what real HCL fixtures represent. The four
 * headline cases (a backendless root, a `backend "local"` root, a remote
 * backend, a `cloud` block) go through `fixtures/TF001/` and `loadFixture`
 * instead; see that module's doc comment for why.
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
    expect(diags[0].message).toContain("there is no backend block at all");
    expect(diags[0].missing).toEqual({ kind: "backend", scope: "TF001" });
  });

  // #2218: the check reads the backend block's type label, so the local
  // backend is the same finding whether it is fallen back into or asked for
  // by name, and the message says which one it found.
  test('flags a root whose backend is `backend "local"`', async () => {
    const diags = tf001.check(await loadFixture("TF001", "positive-local"));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF001");
    expect(diags[0].entity).toBe("TF001/terraform");
    expect(diags[0].message).toContain('the backend it declares is `backend "local"`');
    expect(diags[0].message).not.toContain("no backend block");
    expect(diags[0].missing).toEqual({ kind: "backend", scope: "TF001" });
  });

  test("passes a root with a remote backend block", async () => {
    const diags = tf001.check(await loadFixture("TF001", "negative"));
    expect(diags).toHaveLength(0);
  });

  test("passes a root whose cloud block is the whole state configuration", async () => {
    const diags = tf001.check(await loadFixture("TF001", "negative-cloud"));
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

  test('flags a hand-built body carrying `backend "local"`', () => {
    const diags = tf001.check(
      makeCtx({
        "app/terraform": terraformBlock("app", { backend: { local: [{ path: "terraform.tfstate" }] } }),
      }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('the backend it declares is `backend "local"`');
  });
});

/**
 * The label read itself (#2218). hcl2json nests a labelled block one level
 * deeper than an unlabelled one, and the type only survives the parse as a
 * key of that inner object, so the shape is worth pinning down apart from the
 * check that reads it.
 */
describe("backendTypes / hasRemoteBackend", () => {
  test("reads the type label out of the nested object hcl2json builds", () => {
    expect(backendTypes({ backend: { local: [{ path: "terraform.tfstate" }] } })).toEqual(["local"]);
    expect(backendTypes({ backend: { s3: [{ bucket: "tfstate" }] } })).toEqual(["s3"]);
  });

  test("has no labels to read when there is no backend block, or a malformed one", () => {
    expect(backendTypes({})).toEqual([]);
    expect(backendTypes({ backend: [{ bucket: "tfstate" }] })).toEqual([]);
    expect(backendTypes({ backend: "s3" })).toEqual([]);
  });

  test("counts every backend but `local` as remote, and counts `cloud`", () => {
    expect(hasRemoteBackend({ backend: { local: [{}] } })).toBe(false);
    expect(hasRemoteBackend({})).toBe(false);
    expect(hasRemoteBackend({ backend: { s3: [{}] } })).toBe(true);
    expect(hasRemoteBackend({ backend: { gcs: [{}] } })).toBe(true);
    expect(hasRemoteBackend({ backend: { azurerm: [{}] } })).toBe(true);
    expect(hasRemoteBackend({ backend: { http: [{}] } })).toBe(true);
    expect(hasRemoteBackend({ cloud: [{ organization: "acme" }] })).toBe(true);
  });
});
