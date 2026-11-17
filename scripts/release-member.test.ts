/**
 * chant's release members: one per package npm would publish, each declared
 * after the workspace packages it depends on, so a consumer installing
 * between two publishes never finds a package whose dependency is not out yet.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";
import config from "../release/chant.config";
import { releaseMemberFiles, releasePackages } from "./generate-release-members";

const ROOT = join(import.meta.dirname, "..");

interface Pkg {
  dir: string;
  name: string;
  deps: string[];
}

function publishable(): Pkg[] {
  const out: Pkg[] = [];
  for (const base of ["packages", "lexicons"]) {
    for (const d of readdirSync(join(ROOT, base)).sort()) {
      const file = join(ROOT, base, d, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf-8")) as {
        name: string;
        private?: boolean;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      if (pkg.private) continue;
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
      out.push({ dir: `${base}/${d}`, name: pkg.name, deps });
    }
  }
  return out;
}

/**
 * One release member per npm package (#5133, #5132 decision 1): every file
 * scripts/generate-release-members.ts writes is committed as it writes it,
 * and no directory under release/ is a member the generator no longer makes.
 */
describe("release/<member>/ (#5133)", () => {
  it("is what the generator writes; run `npx tsx scripts/generate-release-members.ts` after adding or removing a package", () => {
    const stale: string[] = [];
    for (const [path, content] of releaseMemberFiles(ROOT)) {
      const file = join(ROOT, "release", path);
      if (!existsSync(file)) stale.push(`release/${path} is missing`);
      else if (readFileSync(file, "utf-8") !== content) stale.push(`release/${path} differs`);
    }
    expect(stale).toEqual([]);
  });

  it("has a member for every package npm would publish and none for anything else", () => {
    const members = releasePackages(ROOT).map((p) => p.member);
    const dirs = readdirSync(join(ROOT, "release"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(ROOT, "release", e.name, "chant.config.ts")))
      .map((e) => e.name);
    expect([...dirs].sort()).toEqual([...members].sort());
    expect(releasePackages(ROOT).map((p) => p.dir).sort()).toEqual(publishable().map((p) => p.dir).sort());
  });

  it("declares the members core first, each after the workspace packages it depends on", () => {
    const pkgs = releasePackages(ROOT);
    expect(pkgs[0]?.dir).toBe("packages/core");
    const at = new Map(pkgs.map((p, i) => [p.dir, i]));
    expect(pkgs.flatMap((p, i) => p.needs.filter((n) => (at.get(n) ?? -1) > i).map((n) => `${p.dir} before ${n}`))).toEqual([]);
    const nested = JSON.parse(readFileSync(join(ROOT, "release", "chant.workspace.json"), "utf-8")) as { members: { name: string }[] };
    expect(nested.members.map((m) => m.name)).toEqual(pkgs.map((p) => p.member));
  });

  it("repeats chant's ci.green, so a member's cut reads the root's green rule", () => {
    const outer = JSON.parse(readFileSync(join(ROOT, "chant.workspace.json"), "utf-8")) as { ci: { green: unknown } };
    const nested = JSON.parse(readFileSync(join(ROOT, "release", "chant.workspace.json"), "utf-8")) as { ci: { green: unknown } };
    expect(nested.ci.green).toEqual(outer.ci.green);
  });

  it("publishes its package directory, stamped from the train, straight to latest, with NPM_TOKEN as the fallback (#5154)", async () => {
    const { default: member } = await import("../release/lexicon-aws/chant.config");
    expect(member.release.publish).toEqual([{ type: "npm", access: "public", stage: false, tokenEnv: "NPM_TOKEN", packages: ["../../lexicons/aws"] }]);
    expect(member.release.version).toEqual({ packages: ["../../lexicons/aws"], lockfile: false, ranges: "train" });
    expect(member.release.legacyTags).toEqual(["lexicon-aws-v"]);
    const { default: core } = await import("../release/core/chant.config");
    expect(core.release.version).toEqual({ packages: ["../../packages/core"], lockfile: false, ranges: "train" });
    expect("legacyTags" in core.release).toBe(false);
  });
});

/** #5154: release/chant.config.ts declares chant's release train and the workflow that publishes it. */
describe("release/chant.config.ts's release train (#5154)", () => {
  it("records trains for npm, cuts the first one together, and reads the lockstep tags as each member's last release", () => {
    expect(config.release.train).toMatchObject({ env: "npm", first: "together" });
    expect(config.release.legacyTags).toEqual(["release/npm/", "chant-v"]);
  });

  it("writes publish.yml, the file the npm trusted-publisher records name, dispatched by hand", () => {
    expect(config.release.workflow).toMatchObject({ trigger: "dispatch", file: ".github/workflows/publish.yml" });
    expect(config.release.workflow?.env).toEqual({ CHANT_RELEASE_GATE: "1", NPM_TOKEN: "${{ secrets.NPM_TOKEN }}" });
  });
});

/** #5154: .github/workflows/publish.yml is what `chant release workflow` writes from release/chant.config.ts. */
describe("publish.yml (#5154)", () => {
  let rendered = "";
  beforeAll(() => {
    const out = join(mkdtempSync(join(tmpdir(), "chant-publish-yml-")), "publish.yml");
    const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "packages/core/src/cli/main.ts"), "release", "workflow", "--output", out], { cwd: join(ROOT, "release"), encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`chant release workflow failed: ${r.stderr}`);
    rendered = readFileSync(out, "utf-8");
  }, 120_000);

  it("is what chant release workflow writes; run it in release/ after changing release.workflow, release.train or a member's targets", () => {
    const body = (text: string) => text.split("\n").slice(1).join("\n");
    expect(body(readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf-8"))).toBe(body(rendered));
  });
});
