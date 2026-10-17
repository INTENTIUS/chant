/**
 * A stored change set's node ids against the spawned `chant graph --format ir`
 * of a real terraform root (#4022).
 *
 * The root is `__fixtures__/change-set/v2.tf.txt` with its local module
 * `v2-module-app.tf.txt` (less the sensitive variable's default), and the plan is `terraform.plan.json`, the real
 * `show -json` of applying v2 over v1 (`../change-set.test.ts`). The graph is
 * read the way `components pr-apply` reads it, by starting chant. The fast
 * pull-request loop test (`pr-loop.tofu.test.ts`) reads the same ids in
 * process instead; the first test here holds the two equal.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { composeChangeSet } from "@intentius/chant/change-set";
import { buildGraphIr } from "@intentius/chant/graph-ir";
import { readGraphIds, storeGateChangeSet } from "@intentius/chant/lifecycle/gate-change-set";
import { readStoredChangeSet } from "@intentius/chant/lifecycle/change-set-store";
import { terraformChangeSetPart } from "../change-set";
import { renderTerraformRoots } from "../hcl/roots";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const FIXTURES = join(import.meta.dirname, "..", "__fixtures__", "change-set");
const TIMEOUT = 240_000;

describe("a terraform change set mapped onto the spawned chant graph", () => {
  let dir: string;
  const git = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-tf-change-set-graph-")));
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
    mkdirSync(join(dir, "estate", "modules", "app"), { recursive: true });
    // The sensitive variable's committed default is dropped: `chant graph` refuses source that fails
    // `chant lint` (TF006, TF007), and the block, which is all the graph needs, stays.
    writeFileSync(join(dir, "estate", "main.tf"), readFileSync(join(FIXTURES, "v2.tf.txt"), "utf8").replace(/\n\s*default\s*=\s*"s3cr3t-2"/, ""));
    writeFileSync(join(dir, "estate", "modules", "app", "main.tf"), readFileSync(join(FIXTURES, "v2-module-app.tf.txt"), "utf8"));
    writeFileSync(join(dir, "chant.config.json"), JSON.stringify({ lexicons: ["terraform"], terraform: { roots: { estate: { dir: "estate" } } } }));
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ci@example.test");
    git("config", "user.name", "ci");
    git("add", "-A");
    git("commit", "-qm", "estate");
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("the in-process graph has the ids chant graph --format ir prints", async () => {
    const spawned = await readGraphIds(dir);
    if ("error" in spawned) throw new Error(spawned.error);
    const rendered = await renderTerraformRoots({ projectRoot: dir, roots: { estate: { dir: "estate" } } });
    expect(buildGraphIr(rendered.entities).nodes.map((n) => n.id).sort()).toEqual([...spawned.ids].sort());
  }, TIMEOUT);

  test("each entry is stored on the block the graph names, and a deleted block has no node", async () => {
    const plan = JSON.parse(readFileSync(join(FIXTURES, "terraform.plan.json"), "utf8"));
    const doc = composeChangeSet([terraformChangeSetPart({ member: "estate", plan })]);
    const head = git("rev-parse", "HEAD");
    const stored = await storeGateChangeSet({ doc, cwd: dir, at: head });
    expect(stored.warning).toBeUndefined();
    expect(stored).toMatchObject({ written: true, graph: { member: null, at: head } });
    const read = await readStoredChangeSet(doc.digest, { cwd: dir });
    if (read.status !== "found") throw new Error(read.status);
    expect(read.document.entries.map((e) => [e.address, e.node])).toEqual([
      ["module.app.terraform_data.instance[0]", "estate/module.app/terraform_data.instance"],
      ["module.app.terraform_data.instance[1]", "estate/module.app/terraform_data.instance"],
      ["terraform_data.config", "estate/terraform_data.config"],
      ["terraform_data.keep", "estate/terraform_data.keep"],
      ["terraform_data.old", null],
      ["terraform_data.secret", "estate/terraform_data.secret"],
      ["terraform_data.worker", "estate/terraform_data.worker"],
    ]);
  }, TIMEOUT);
});
