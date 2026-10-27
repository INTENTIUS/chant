import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { applyInlineSuppressions } from "@intentius/chant/lint/suppressions";
import { ALLOW_LOCAL_RECORD_STORE_ENV, checkLocalRecordStore, isCiEnvironment } from "./tf046";
import { tf024 } from "./tf024";
import { blocksToEntities, parseTerraformRootDir } from "../../hcl/parse";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "TF046");

const CI = { CI: "true" };

async function ctxFor(fixture: string, binary: "choudoufu" | "terraform" = "choudoufu"): Promise<PostSynthContext> {
  const entities = await parseTerraformRootDir(join(fixtures, fixture), "estate", undefined, { binary });
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

describe("TF046: live root resolves to the local record store in CI", () => {
  test("fires on a live root with no record_store and no backend", async () => {
    const diags = checkLocalRecordStore(await ctxFor("implied-local"), CI);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF046");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("estate/terraform");
    expect(diags[0].message).toContain("no backend block to derive one from");
    expect(diags[0].message).toContain("declare a record_store");
    expect(diags[0].message).toContain('backend "s3"');
  });

  test("stays quiet when an ignored s3 backend with a literal bucket gives a derived store", async () => {
    // The backend sits in its own backend.tf, as most roots keep it.
    expect(checkLocalRecordStore(await ctxFor("derived-s3"), CI)).toHaveLength(0);
  });

  test("agrees with TF024 on the derived store", async () => {
    const ctx = await ctxFor("derived-s3");
    const diags = tf024.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("derives the record store");
  });

  test("fires when the backend's bucket comes only from -backend-config, and says so", async () => {
    const ctx = await ctxFor("backend-config-only");
    const diags = checkLocalRecordStore(ctx, CI);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('backend "s3" sets no literal bucket');
    // TF024 gives the same reason instead of claiming a derived store.
    const tf024Diags = tf024.check(ctx);
    expect(tf024Diags[0].message).toContain("sets no literal bucket");
    expect(tf024Diags[0].message).not.toContain("derives the record store");
  });

  test("fires on an azurerm backend that leaves out resource_group_name", async () => {
    const diags = checkLocalRecordStore(await ctxFor("azurerm-no-resource-group"), CI);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("resource_group_name");
  });

  test('fires on an explicit record_store "local", even beside a derivable backend', async () => {
    const diags = checkLocalRecordStore(await ctxFor("explicit-local"), CI);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('record_store "local"');
  });

  test("stays quiet on an explicit bucket record_store beside a local backend", async () => {
    expect(checkLocalRecordStore(await ctxFor("explicit-s3-beside-local-backend"), CI)).toHaveLength(0);
  });

  test("keys on an estate.chdf.hcl sidecar as well as a live block", async () => {
    const diags = checkLocalRecordStore(await ctxFor("sidecar-implied"), CI);
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toMatch(/^estate\/live/);
  });

  test("a sidecar estate opts out with chant-ignore-file in estate.chdf.hcl", async () => {
    const entities = await blocksToEntities(
      [{ name: "main.tf", source: "terraform {}\n" }],
      "app",
      undefined,
      { binary: "choudoufu" },
      { name: "estate.chdf.hcl", source: '# chant-ignore-file: TF046\nestate = "e"\n' },
    );
    const ctx = { outputs: new Map(), entities } as unknown as PostSynthContext;
    const diags = checkLocalRecordStore(ctx, CI);
    expect(diags).toHaveLength(1);
    expect(applyInlineSuppressions(diags, ctx.entities).diagnostics).toHaveLength(0);
  });

  test("says nothing outside CI", async () => {
    expect(checkLocalRecordStore(await ctxFor("implied-local"), {})).toHaveLength(0);
    expect(checkLocalRecordStore(await ctxFor("implied-local"), { CI: "false" })).toHaveLength(0);
  });

  test("an emulator or test lane opts out through the environment", async () => {
    const env = { ...CI, [ALLOW_LOCAL_RECORD_STORE_ENV]: "1" };
    expect(checkLocalRecordStore(await ctxFor("explicit-local"), env)).toHaveLength(0);
    expect(checkLocalRecordStore(await ctxFor("implied-local"), env)).toHaveLength(0);
  });

  test("one root opts out with chant-ignore-block above the terraform block holding live", async () => {
    const source =
      '# chant-ignore-block: TF046\nterraform {\n  live {\n    estate = "e"\n    record_store "local" {}\n  }\n}\n';
    const entities = await blocksToEntities([{ name: "main.tf", source }], "app", undefined, { binary: "choudoufu" });
    const ctx = { outputs: new Map(), entities } as unknown as PostSynthContext;
    const diags = checkLocalRecordStore(ctx, CI);
    expect(diags).toHaveLength(1);
    expect(applyInlineSuppressions(diags, ctx.entities).diagnostics).toHaveLength(0);
  });

  test("stays quiet on a Terragrunt unit whose remote_state writes the backend at run time", async () => {
    const files = [
      { name: "main.tf", source: 'terraform {\n  live {\n    estate = "e"\n  }\n}\n' },
      {
        name: "terragrunt.hcl",
        source: 'remote_state {\n  backend = "s3"\n  generate = {\n    path = "backend.tf"\n    if_exists = "overwrite"\n  }\n  config = {\n    bucket = "tfstate"\n  }\n}\n',
      },
    ];
    const entities = await blocksToEntities(files, "unit", undefined, { binary: "choudoufu" });
    const ctx = { outputs: new Map(), entities } as unknown as PostSynthContext;
    expect(checkLocalRecordStore(ctx, CI)).toHaveLength(0);
  });

  test("does not fire on a stock root", async () => {
    expect(checkLocalRecordStore(await ctxFor("implied-local", "terraform"), CI)).toHaveLength(0);
  });

  test("reads CI from the variables each forge sets", () => {
    expect(isCiEnvironment({ CI: "1" })).toBe(true);
    expect(isCiEnvironment({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(isCiEnvironment({ GITLAB_CI: "true" })).toBe(true);
    expect(isCiEnvironment({ FORGEJO_ACTIONS: "true" })).toBe(true);
    expect(isCiEnvironment({ TF_BUILD: "True" })).toBe(true);
    expect(isCiEnvironment({ CI: "0" })).toBe(false);
    expect(isCiEnvironment({})).toBe(false);
  });
});
