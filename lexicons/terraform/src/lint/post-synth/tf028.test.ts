import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { tf028 } from "./tf028";
import { parseTerraformRootDir } from "../../hcl/parse";
import { TerraformWatchOp, type TerraformWatchOpConfig } from "../../composites/terraform-watch-op";
import { TerraformApplyOp } from "../../composites/terraform-apply-op";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "TF028");

/** The entities of one fixture root, parsed the way `buildRoots` parses a configured root. */
async function rootEntities(fixture: string, root: string, binary = "choudoufu"): Promise<Map<string, Declarable>> {
  return parseTerraformRootDir(join(fixtures, fixture), root, undefined, { binary });
}

/** A `Chant::Op` entity from the real composite, keyed the way a discovered Op is. */
function watchOp(config: TerraformWatchOpConfig): [string, Declarable] {
  const { op } = TerraformWatchOp(config);
  return [config.name, op as unknown as Declarable];
}

function ctxOf(...maps: Array<Map<string, Declarable> | [string, Declarable]>): PostSynthContext {
  const entities = new Map<string, Declarable>();
  for (const m of maps) {
    if (Array.isArray(m)) entities.set(m[0], m[1]);
    else for (const [k, v] of m) entities.set(k, v);
  }
  return { outputs: new Map(), entities } as unknown as PostSynthContext;
}

describe("TF028: a live root planned by a stock terraformPlan step", () => {
  test("fires on a TerraformWatchOp built without live: true", async () => {
    const diags = tf028.check(
      ctxOf(await rootEntities("live", "estate"), watchOp({ name: "estate-watch", root: "estate" })),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TF028");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].lexicon).toBe("terraform");
    expect(diags[0].entity).toBe("estate-watch");
    expect(diags[0].message).toContain('Op "estate-watch"');
    expect(diags[0].message).toContain('root module "estate"');
    expect(diags[0].message).toContain("live: true");
  });

  test("passes when the same Op is built with live: true", async () => {
    const diags = tf028.check(
      ctxOf(
        await rootEntities("live", "estate"),
        watchOp({ name: "estate-watch", root: "estate", live: true }),
      ),
    );
    expect(diags).toEqual([]);
  });

  test("passes on a stock root, which is what terraformPlan is for", async () => {
    const diags = tf028.check(
      ctxOf(await rootEntities("stock", "app", "terraform"), watchOp({ name: "app-watch", root: "app" })),
    );
    expect(diags).toEqual([]);
  });

  test("names the Op that plans the live root, not a sibling Op on another root", async () => {
    const diags = tf028.check(
      ctxOf(
        await rootEntities("live", "estate"),
        await rootEntities("stock", "app", "terraform"),
        watchOp({ name: "estate-watch", root: "estate" }),
        watchOp({ name: "app-watch", root: "app" }),
      ),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("estate-watch");
  });

  test("does not fire on a TerraformApplyOp, whose stock plan step is correct on a live root", async () => {
    const { op } = TerraformApplyOp({ name: "estate-apply", root: "estate" });
    const diags = tf028.check(
      ctxOf(await rootEntities("live", "estate"), ["estate-apply", op as unknown as Declarable]),
    );
    expect(diags).toEqual([]);
  });

  test("ignores a build with no live root at all", async () => {
    const diags = tf028.check(
      ctxOf(await rootEntities("stock", "estate", "terraform"), watchOp({ name: "estate-watch", root: "estate" })),
    );
    expect(diags).toEqual([]);
  });
});
