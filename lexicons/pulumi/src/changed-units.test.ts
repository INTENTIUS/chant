/**
 * The stacks a change touched (INTENTIUS/plywood#22): plywood's bench edits
 * `Pulumi.dev.yaml` in a pull request, and `chant components pr-plan`
 * selected nothing because no lexicon claimed the file. Fixture repositories
 * on disk; nothing here runs Pulumi or git.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { pulumiChangedUnits, pulumiStackUnit } from "./changed-units";
import { pulumiPlugin } from "./plugin";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pulumi-changed-units-"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  return root;
}

/** plywood's bench shop: one project at the root with four stacks, and a nested project. */
const SHOP = {
  "Pulumi.yaml": "name: shop\nruntime: nodejs\n",
  "Pulumi.dev.yaml": "config: {}\n",
  "Pulumi.staging.yaml": "config: {}\n",
  "Pulumi.prod-us.yaml": "config: {}\n",
  "Pulumi.prod-eu.yaml": "config: {}\n",
  "index.ts": "export {};\n",
  "package.json": "{}\n",
  "plywood.yml": "stacks: {}\n",
  ".forgejo/workflows/plywood.yml": "name: plywood\n",
  "net/Pulumi.yaml": "name: net\nruntime: nodejs\n",
  "net/Pulumi.qa.yaml": "config: {}\n",
  "net/vpc.ts": "export {};\n",
  "docs/notes.md": "x\n",
};

describe("pulumiChangedUnits", () => {
  test("a changed stack config touches that stack alone: the PR-2 case from the bench", () => {
    const root = repo(SHOP);
    expect(pulumiChangedUnits(root, ["Pulumi.dev.yaml"])).toEqual(["dev"]);
    expect(pulumiChangedUnits(root, ["Pulumi.prod-us.yaml", "Pulumi.prod-eu.yaml"])).toEqual(["prod-eu", "prod-us"]);
    expect(pulumiChangedUnits(root, ["net/Pulumi.qa.yaml"])).toEqual(["net/qa"]);
  });

  test("a program file touches every stack of its project, and only that project", () => {
    const root = repo(SHOP);
    expect(pulumiChangedUnits(root, ["index.ts"])).toEqual(["dev", "prod-eu", "prod-us", "staging"]);
    expect(pulumiChangedUnits(root, ["Pulumi.yaml"])).toEqual(["dev", "prod-eu", "prod-us", "staging"]);
    // The nested project owns its files; the root project does not reach into it.
    expect(pulumiChangedUnits(root, ["net/vpc.ts"])).toEqual(["net/qa"]);
    // A file under the root project's tree but in no nested project is the root project's program.
    expect(pulumiChangedUnits(root, ["docs/notes.md"])).toEqual(["dev", "prod-eu", "prod-us", "staging"]);
  });

  test("dot directories, node_modules and files outside the project root are not the program", () => {
    const root = repo(SHOP);
    expect(pulumiChangedUnits(root, [".forgejo/workflows/plywood.yml", ".chant/op-waves/pulumi-up.spec.json", "node_modules/x/index.js", "../shared/lib.ts"])).toEqual([]);
  });

  test("a deleted stack config still names its stack, and a program change reaches it", () => {
    const root = repo(SHOP);
    expect(pulumiChangedUnits(root, ["Pulumi.old.yaml"])).toEqual(["old"]);
    expect(pulumiChangedUnits(root, ["index.ts", "Pulumi.old.yaml"])).toEqual(["dev", "old", "prod-eu", "prod-us", "staging"]);
  });

  test("a deleted Pulumi.yaml still names its project", () => {
    const root = repo({ "app/Pulumi.dev.yaml": "config: {}\n", "app/index.ts": "export {};\n" });
    expect(pulumiChangedUnits(root, ["app/Pulumi.yaml", "app/index.ts"])).toEqual(["app/dev"]);
  });

  test("a file in no Pulumi project touches nothing", () => {
    const root = repo({ "README.md": "x\n", "tf/main.tf": "\n" });
    expect(pulumiChangedUnits(root, ["README.md", "tf/main.tf"])).toEqual([]);
  });

  test("units are named as core names a pulumi-up step's deploy unit", () => {
    expect([pulumiStackUnit(".", "dev"), pulumiStackUnit("./infra/", "dev"), pulumiStackUnit("apps\\web", "qa")]).toEqual(["dev", "infra/dev", "apps/web/qa"]);
  });

  test("the plugin answers changedUnits from the changed files", async () => {
    const root = repo(SHOP);
    expect(await pulumiPlugin.changedUnits!({ projectRoot: root, config: {}, changedFiles: ["Pulumi.dev.yaml"] })).toEqual(["dev"]);
  });
});
