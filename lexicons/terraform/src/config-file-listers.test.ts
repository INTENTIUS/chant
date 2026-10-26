/**
 * Every file lister in the lexicon reads the same configuration files for one
 * root, through `./hcl/files.ts` (chant#4457): `.tf` and `.tf.json`, plus
 * `.tofu` and `.tofu.json` when the root runs tofu or choudoufu, with `x.tofu`
 * shadowing `x.tf`. One test per lister that changed. The fast `live` readers
 * also read a `.tf.json` file's `live` block (chant#4504).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadHcl2json } from "@intentius/chant/terraform/hcl2json";
import { listConfigFiles, readsTofuFiles, selectConfigFiles } from "./hcl/files";
import { configFiles, liveEstate, localModules, rootState } from "./compose/hcl";
import { hasCloudBlock, stateObject } from "./state/backend";
import { estateOfDir } from "./report";
import { detectLiveEstate, detectLivePolicyVerbs } from "./op/activities/live-detect";
import { rootWatchPaths } from "./changed-roots";
import { editPins } from "./pin/edit";
import { runPinRollout } from "./pin/rollout";
import { terragruntAffected } from "./terragrunt/affected";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temporary directory holding `files`, by path relative to it. */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-4457-"));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("hcl/files: the one lister", () => {
  test("which binaries read .tofu files", () => {
    expect(readsTofuFiles(undefined)).toBe(false);
    expect(readsTofuFiles("terraform")).toBe(false);
    expect(readsTofuFiles("/opt/bin/terraform")).toBe(false);
    expect(readsTofuFiles("tofu")).toBe(true);
    expect(readsTofuFiles("/usr/local/bin/tofu")).toBe(true);
    expect(readsTofuFiles("choudoufu")).toBe(true);
  });

  test("the file set follows the binary, and x.tofu shadows x.tf", () => {
    const names = ["main.tf", "main.tofu", "extra.tf.json", "extra.tofu.json", "vars.tf", "notes.md", "terraform.tfvars", "estate.chdf.hcl"];
    expect(selectConfigFiles(names)).toEqual(["extra.tf.json", "main.tf", "vars.tf"]);
    expect(selectConfigFiles(names, "terraform")).toEqual(["extra.tf.json", "main.tf", "vars.tf"]);
    expect(selectConfigFiles(names, "tofu")).toEqual(["extra.tofu.json", "main.tofu", "vars.tf"]);
    expect(selectConfigFiles(names, "choudoufu")).toEqual(["extra.tofu.json", "main.tofu", "vars.tf"]);
  });

  test("a directory is listed by its files only, not a directory named like one", () => {
    const dir = tree({ "main.tf": "", "a.tofu": "", "odd.tf/inner.txt": "" });
    expect(listConfigFiles(dir)).toEqual(["main.tf"]);
    expect(listConfigFiles(dir, "tofu")).toEqual(["a.tofu", "main.tf"]);
  });
});

describe("compose/hcl reads the lister's set", () => {
  test("configFiles follows the binary", () => {
    const dir = tree({ "main.tf": "", "main.tofu": "", "x.tf.json": "{}" });
    expect(configFiles(dir).map((p) => p.slice(dir.length + 1))).toEqual(["main.tf", "x.tf.json"]);
    expect(configFiles(dir, "tofu").map((p) => p.slice(dir.length + 1))).toEqual(["main.tofu", "x.tf.json"]);
  });

  test("a backend in a .tofu file is seen under tofu only", () => {
    const dir = tree({ "backend.tofu": 'terraform {\n  backend "gcs" {\n    bucket = "b"\n    prefix = "p"\n  }\n}\n' });
    expect(rootState(dir, "app", { env: {}, recorded: null }).own).toEqual({ key: "local:app/terraform.tfstate" });
    expect(rootState(dir, "app", { env: {}, recorded: null, binary: "tofu" }).own).toEqual({ bucket: "b", key: "p" });
  });

  test("a live block in a .tofu file is a choudoufu root's estate", () => {
    const dir = tree({ "main.tofu": 'terraform {\n  live {\n    estate = "prod"\n  }\n}\n' });
    expect(liveEstate(dir)).toEqual({ live: true, estate: "prod" });
    expect(liveEstate(dir, "terraform")).toEqual({ live: false });
  });

  test("a local module called from a .tofu file is followed under tofu", () => {
    const dir = tree({ "root/main.tofu": 'module "net" {\n  source = "../net"\n}\n', "net/main.tf": "" });
    expect(localModules(join(dir, "root"))).toEqual([]);
    expect(localModules(join(dir, "root"), "tofu")).toEqual([join(dir, "net")]);
  });
});

describe("state/backend reads the lister's set", () => {
  test("a cloud block in a .tofu file is refused under tofu, and unseen under terraform", () => {
    const dir = tree({ "main.tofu": 'terraform {\n  cloud {\n    organization = "o"\n  }\n}\n' });
    expect(hasCloudBlock(dir)).toBe(false);
    expect(hasCloudBlock(dir, "tofu")).toBe(true);
    expect(hasCloudBlock(dir, "choudoufu")).toBe(true);
    expect(stateObject(dir, {}, undefined, "tofu")).toMatchObject({ refused: "cloud" });
    expect(stateObject(dir, {}, undefined, "terraform")).toMatchObject({ backend: "local" });
  });

  test("a cloud block in a .tofu.json file is seen under tofu", () => {
    const dir = tree({ "main.tofu.json": JSON.stringify({ terraform: { cloud: { organization: "o" } } }) });
    expect(hasCloudBlock(dir, "tofu")).toBe(true);
  });
});

describe("report and live-detect read choudoufu's set", () => {
  const live = 'terraform {\n  live {\n    estate = "prod"\n  }\n}\n';

  test("estateOfDir finds a live block in a .tofu file", () => {
    expect(estateOfDir(tree({ "main.tofu": live }))).toBe("prod");
    expect(estateOfDir(tree({ "main.tofu": live }), "terraform")).toBeUndefined();
  });

  test("detectLiveEstate finds a live block in a .tofu file, and x.tofu shadows x.tf", () => {
    expect(detectLiveEstate(tree({ "main.tofu": live }))).toBe("prod");
    expect(detectLiveEstate(tree({ "main.tf": live, "main.tofu": "" }))).toBeUndefined();
    expect(detectLiveEstate(tree({ "main.tf": live, "main.tofu": "" }), "terraform")).toBe("prod");
  });

  const liveJson = JSON.stringify({ terraform: { required_version: ">= 1.5.0", live: { estate: "prod" } } });

  test("estateOfDir finds a live block in a .tf.json file (chant#4504)", () => {
    expect(estateOfDir(tree({ "main.tf.json": liveJson }))).toBe("prod");
    expect(estateOfDir(tree({ "main.tf.json": liveJson }), "terraform")).toBe("prod");
    // JSON syntax may write the terraform block as an array of bodies.
    expect(estateOfDir(tree({ "main.tf.json": JSON.stringify({ terraform: [{}, { live: [{ estate: "second" }] }] }) }))).toBe("second");
    expect(estateOfDir(tree({ "main.tf.json": JSON.stringify({ terraform: { live: { estate: "" } } }) }))).toBeUndefined();
    expect(estateOfDir(tree({ "main.tf.json": "{ not json" }))).toBeUndefined();
    // A live key outside the terraform block is not a live block.
    expect(estateOfDir(tree({ "main.tf.json": JSON.stringify({ live: { estate: "prod" } }) }))).toBeUndefined();
  });

  test("estateOfDir takes the first live block in filename order across .tf and .tf.json", () => {
    expect(estateOfDir(tree({ "a.tf.json": liveJson, "b.tf": live.replace("prod", "other") }))).toBe("prod");
    expect(estateOfDir(tree({ "a.tf": live.replace("prod", "other"), "b.tf.json": liveJson }))).toBe("other");
  });

  test("estateOfDir reads a .tofu.json live block under choudoufu, and x.tofu.json shadows x.tf.json", () => {
    expect(estateOfDir(tree({ "main.tofu.json": liveJson }))).toBe("prod");
    expect(estateOfDir(tree({ "main.tofu.json": liveJson }), "terraform")).toBeUndefined();
    expect(estateOfDir(tree({ "main.tf.json": liveJson, "main.tofu.json": "{}" }))).toBeUndefined();
  });

  test("detectLiveEstate finds a live block in a .tf.json file (chant#4504)", () => {
    expect(detectLiveEstate(tree({ "main.tf.json": liveJson }))).toBe("prod");
    expect(detectLiveEstate(tree({ "main.tf.json": liveJson }), "terraform")).toBe("prod");
    expect(detectLiveEstate(tree({ "main.tofu.json": liveJson }))).toBe("prod");
    expect(detectLiveEstate(tree({ "main.tf.json": JSON.stringify({ terraform: { live: { estate: "" } } }) }))).toBeUndefined();
    expect(detectLiveEstate(tree({ "main.tf.json": "{ not json" }))).toBeUndefined();
    // The sidecar still comes first.
    expect(detectLiveEstate(tree({ "estate.chdf.hcl": 'estate = "side"\n', "main.tf.json": liveJson }))).toBe("side");
  });

  test("detectLivePolicyVerbs reads a .tf.json live block's policy, as an object or an array", () => {
    const policy = { undeclared_tagged: "adopt", undeclared_untagged: "report" };
    expect(detectLivePolicyVerbs(tree({ "main.tf.json": JSON.stringify({ terraform: { live: { estate: "prod", policy } } }) }))).toEqual({
      undeclaredTagged: "adopt",
      undeclaredUntagged: "report",
    });
    expect(detectLivePolicyVerbs(tree({ "main.tf.json": JSON.stringify({ terraform: { live: { estate: "prod", policy: [{ undeclared_untagged: "delete" }] } } }) }))).toEqual({
      undeclaredTagged: undefined,
      undeclaredUntagged: "delete",
    });
    expect(detectLivePolicyVerbs(tree({ "main.tf.json": liveJson }))).toBeUndefined();
  });
});

describe("pin rollout's listers follow the binary (chant#4504)", () => {
  const REGISTRY = "app.terraform.io/acme/vpc/aws";
  const call = (version: string) => `module "vpc" {\n  source  = "${REGISTRY}"\n  version = "${version}"\n}\n`;

  /** A git repository on `main` holding `files`, committed. */
  function repo(files: Record<string, string>): string {
    const dir = tree(files);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "--quiet", "--initial-branch=main");
    git("add", ".");
    git("commit", "--quiet", "-m", "fixture");
    return dir;
  }

  async function roots(cwd: string, binary?: string) {
    const r = await runPinRollout({ cwd, module: REGISTRY, from: "1.3.0", to: "1.4.0", parser: await loadHcl2json(), mode: "report", ...(binary ? { binary } : {}) });
    return Object.fromEntries(r.roots.map((x) => [x.root, { state: x.state, files: x.files }]));
  }

  test("candidateRoots and rootFiles read .tofu files under tofu only, with x.tofu shadowing x.tf", async () => {
    const cwd = repo({
      "only-tofu/main.tofu": call("1.3.0"),
      "shadowed/main.tf": call("1.2.0"),
      "shadowed/main.tofu": call("1.3.0"),
      "plain/main.tf": call("1.3.0"),
      "plain/notes.md": call("1.3.0"),
    });
    expect(await roots(cwd)).toEqual({
      plain: { state: "from", files: ["plain/main.tf"] },
      shadowed: { state: "elsewhere", files: ["shadowed/main.tf"] },
    });
    expect(await roots(cwd, "tofu")).toEqual({
      "only-tofu": { state: "from", files: ["only-tofu/main.tofu"] },
      plain: { state: "from", files: ["plain/main.tf"] },
      shadowed: { state: "from", files: ["shadowed/main.tofu"] },
    });
  });

  test("a .tf.json root is a candidate, and its moving call is refused by name", async () => {
    const cwd = repo({ "json/main.tf.json": JSON.stringify({ module: { vpc: { source: REGISTRY, version: "1.3.0" } } }) });
    const r = await runPinRollout({ cwd, module: REGISTRY, from: "1.3.0", to: "1.4.0", parser: await loadHcl2json(), mode: "report" });
    expect(r.roots).toEqual([expect.objectContaining({ root: "json", state: "refused", files: ["json/main.tf.json"], reason: expect.stringContaining("JSON syntax") })]);
    expect(r.waves).toEqual([]);
  });
});

describe("terragrunt affected follows a module's .tofu calls (chant#4504)", () => {
  const unit = { path: "live/app", dependencies: [], reading: ["live/app/terragrunt.hcl", "modules/app/main.tofu"] };

  test("a change under a module called from a .tofu file is a module-call reason", () => {
    const dir = tree({
      "live/app/terragrunt.hcl": 'terraform {\n  source = "../../modules/app"\n}\n',
      "modules/app/main.tofu": 'module "net" {\n  source = "../net"\n}\n',
      "modules/net/main.tf": "",
    });
    expect(terragruntAffected({ dir, units: [unit], terragruntSelected: [], changedFiles: ["modules/net/main.tf"] })).toEqual({
      units: [{ path: "live/app", reasons: [{ kind: "module-call", files: ["modules/net/main.tf"], via: "modules/net" }] }],
      notes: [],
    });
  });

  test("a call in an x.tf that x.tofu shadows is not followed", () => {
    const dir = tree({
      "live/app/terragrunt.hcl": 'terraform {\n  source = "../../modules/app"\n}\n',
      "modules/app/main.tofu": "",
      "modules/app/main.tf": 'module "old" {\n  source = "../old"\n}\n',
      "modules/old/main.tf": "",
    });
    expect(terragruntAffected({ dir, units: [unit], terragruntSelected: [], changedFiles: ["modules/old/main.tf"] })).toEqual({ units: [], notes: [] });
  });
});

describe("changed-roots reads the lister's set", () => {
  test("a module called from a .tofu file is watched for a tofu root only", () => {
    const dir = tree({ "app/main.tofu": 'module "net" {\n  source = "../modules/net"\n}\n', "modules/net/main.tf": "" });
    expect(rootWatchPaths(dir, { dir: "app" })).toEqual(["app"]);
    expect(rootWatchPaths(dir, { dir: "app" }, "tofu")).toEqual(["app", "modules/net"]);
  });
});

describe("pin edit on a JSON-syntax file", () => {
  const REGISTRY = "app.terraform.io/acme/vpc/aws";

  test("a call that would move is refused by name, and the file is left as written", async () => {
    const text = JSON.stringify({ module: { vpc: { source: REGISTRY, version: "1.3.0" } } });
    const result = await editPins(text, "main.tf.json", { module: REGISTRY, from: "1.3.0", to: "1.4.0" }, await loadHcl2json());
    expect(result.content).toBe(text);
    expect(result.calls).toEqual([expect.objectContaining({ outcome: "refused", file: "main.tf.json", call: "module.vpc" })]);
  });

  test("a call already at the new pin reads as already", async () => {
    const text = JSON.stringify({ module: { vpc: { source: REGISTRY, version: "1.4.0" } } });
    const result = await editPins(text, "main.tofu.json", { module: REGISTRY, from: "1.3.0", to: "1.4.0" }, await loadHcl2json());
    expect(result.calls.map((c) => c.outcome)).toEqual(["already"]);
  });
});
