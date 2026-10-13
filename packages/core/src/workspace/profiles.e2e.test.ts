/**
 * #3174, ws-096: factory fields are opt-in, and the reference workspace ships
 * three profiles (ideation, app, infra) that `chant workspace init --profile`
 * copies. A records-only workspace, an infra workspace with no factory and an
 * infra workspace whose factory has no app member and no box services all
 * pass `chant workspace check`, and so does a copy of each profile.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { REPO, repo } from "./__fixtures__/contract-repo";
import { plantability } from "./box-factory";
import { runDeclarationChecks } from "./checks";
import { readDeclaration } from "./declaration";
import { PROFILES, PROFILES_DIR, profileSource } from "./init";
import { initFromCommand } from "./lineage-init";
import { workingTree } from "./tree";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

const REFERENCE = join(REPO, "reference-workspace");
const CHANT = join(REPO, "packages", "core", "bin", "chant");

/** Every file under `dir`, relative to it, sorted. */
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const p = join(at, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** The errors `chant workspace check` reports, as `<id>:<entity>: <message>`. */
async function errors(root: string): Promise<string[]> {
  const report = await runDeclarationChecks(root);
  return report.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.ruleId}:${d.entity ?? ""}: ${d.message}`);
}

/** A copy of a profile, made the way `chant workspace init --profile` makes it, from this checkout. */
async function copyOf(profile: string): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `chant-3174-${profile}-`)));
  scratch.push(dir);
  const made = await initFromCommand({ from: `${REPO}#${PROFILES_DIR}/${profile}`, path: dir, params: profile === "infra" ? {} : { name: "Fern" } });
  expect(made.success, made.error).toBe(true);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

describe("factory fields are opt-in (#3174)", () => {
  test("a records-only workspace passes check, with no member, box or factory", async () => {
    const root = repo({
      "chant.workspace.json": JSON.stringify({ name: "notes", schema: 1, members: [], records: [{ kind: "decisions/decision.kind.mjs" }] }, null, 2),
      "decisions/decision.kind.mjs": readFileSync(join(REFERENCE, "decisions", "decision.kind.mjs"), "utf-8"),
      "decisions/decision.schema.json": readFileSync(join(REFERENCE, "decisions", "decision.schema.json"), "utf-8"),
    });
    expect(await errors(root)).toEqual([]);
  });

  test("an infra workspace with no factory passes check", async () => {
    const root = repo({
      "chant.workspace.json": JSON.stringify({ name: "estate", schema: 1, members: [{ name: "network", dir: "network", kind: "chant" }] }, null, 2),
      "network/chant.config.json": '{ "lexicons": ["terraform"] }\n',
    });
    expect(await errors(root)).toEqual([]);
  });

  test("an infra workspace whose factory builds an estate member, with no app member and no box services, passes check and isn't plantable", async () => {
    const declaration = {
      name: "estate",
      schema: 1,
      members: [{ name: "network", dir: "network", kind: "chant", box: { factory: { builds: ["network"], check: { run: "chant lint", kind: "lint" } } } }],
    };
    const root = repo({ "chant.workspace.json": JSON.stringify(declaration, null, 2), "network/chant.config.json": '{ "lexicons": ["terraform"] }\n' });
    expect(await errors(root)).toEqual([]);
    expect(plantability(readDeclaration(workingTree(root), "")).reason?.code).toBe("box-none");
  });
});

describe("the reference workspace's profiles (#3174)", () => {
  test("are ideation, app and infra, each a template directory with a declaration", () => {
    expect(readdirSync(join(REPO, PROFILES_DIR)).sort()).toEqual([...PROFILES].sort());
  });

  test("carry the reference workspace's own record kinds and app kind, byte for byte", () => {
    for (const profile of PROFILES) {
      const dir = join(REPO, PROFILES_DIR, profile);
      for (const f of files(dir).filter((p) => /^(decisions|work|answers|kinds)\//.test(p))) {
        expect(readFileSync(join(dir, f), "utf-8"), `${profile}/${f}`).toBe(readFileSync(join(REFERENCE, f), "utf-8"));
      }
    }
  });

  test("ideation: records and a stub app of the app kind, no box and no factory, and check passes", async () => {
    const root = await copyOf("ideation");
    expect(await errors(root)).toEqual([]);
    const d = readDeclaration(workingTree(root), "");
    expect(d.members.map((m) => `${m.name}:${m.kind}`)).toEqual(["app:app"]);
    expect(d.members.every((m) => m.box === null)).toBe(true);
    expect(d.records.map((r) => r.kind)).toEqual(["decisions/decision.kind.mjs", "work/work.kind.mjs", "answers/answer.kind.mjs"]);
    expect(readFileSync(join(root, "app", "server.mjs"), "utf-8")).toContain('NAME = "Fern"');
  });

  test("app: the app member runs as the box's service and the factory builds it, and check passes", async () => {
    const root = await copyOf("app");
    expect(await errors(root)).toEqual([]);
    const d = readDeclaration(workingTree(root), "");
    expect(plantability(d)).toMatchObject({ plantable: true, box: "app" });
    expect(d.members[0].box?.factory?.builds).toEqual(["app"]);
  });

  test("infra: an estate member and a factory, no app member and no box services, and check passes", async () => {
    const root = await copyOf("infra");
    expect(await errors(root)).toEqual([]);
    const d = readDeclaration(workingTree(root), "");
    expect(d.members.map((m) => `${m.name}:${m.kind}`)).toEqual(["network:chant"]);
    expect(d.members[0].box?.factory?.check).toEqual({ run: "cd network && npx chant lint && npx chant build", kind: "lint" });
    expect(d.members[0].box?.services).toEqual([]);
    expect(d.pins).toEqual([]);
  });
});

describe("chant workspace init --profile (#3174)", () => {
  test("reads the profile from the chant repository at this chant's tag, or from --from", () => {
    expect(profileSource("app", undefined, "0.103.0")).toBe("https://github.com/INTENTIUS/chant@chant-v0.103.0#reference-workspace/profiles/app");
    expect(profileSource("infra", "/src/chant", "0.103.0")).toBe("/src/chant#reference-workspace/profiles/infra");
  });

  test("copies the profile with a lineage lock and names the workspace", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-3174-cli-")));
    scratch.push(dir);
    const run = spawnSync(CHANT, ["workspace", "init", dir, "--profile", "ideation", "--from", REPO, "--name", "fern", "--param", "name=Fern", "--yes"], { encoding: "utf-8" });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "chant.workspace.json"), "utf-8")).name).toBe("fern");
    expect(readdirSync(join(dir, ".chant"))).toContain("workspace.lock.json");
  });

  test("names the profiles when given another, and writes nothing without --yes", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-3174-cli-")));
    scratch.push(dir);
    const bad = spawnSync(CHANT, ["workspace", "init", dir, "--profile", "web"], { encoding: "utf-8" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/the profiles are ideation, app, infra/);
    const dry = spawnSync(CHANT, ["workspace", "init", dir, "--profile", "infra", "--from", REPO], { encoding: "utf-8", input: "" });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/Nothing written/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
