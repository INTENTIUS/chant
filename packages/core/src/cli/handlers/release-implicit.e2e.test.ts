/**
 * An implicit release of a project with no components, end to end (#4046):
 * the getting-started example, given two environments and a build parameter
 * set per environment, is cut from the same commit in two clones. Each
 * environment's build output must come out byte for byte the same, and the
 * two cuts must give one release digest. No cluster is touched: the release
 * is exported to files and never deployed.
 */

import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { contract, REPO } from "../../workspace/__fixtures__/contract-repo";
import releasesSchema from "../../workspace/releases.schema.json";
import { contentDigest } from "../../content-digest";

const CHANT = [process.execPath, "--import", pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href, join(REPO, "packages", "core", "src", "cli", "main.ts")];
const EXAMPLE = join(REPO, "examples", "getting-started");

function chant(cwd: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, USER: "tester" };
  for (const k of ["GITHUB_RUN_ID", "CI_PIPELINE_ID", "GITHUB_ACTOR", "GITLAB_USER_LOGIN", "CHANT_ENV", "GITHUB_SHA", "CI"]) delete env[k];
  const r = spawnSync(CHANT[0], [...CHANT.slice(1), ...args], { cwd, encoding: "utf-8", env, timeout: 180_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** Every file under `dir`, by its path relative to `dir`, as bytes. */
function filesUnder(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

/** The example as a project of its own with two environments and a parameter that differs between them. */
function writeProject(dir: string): void {
  cpSync(join(EXAMPLE, "src"), join(dir, "src"), { recursive: true });
  // The deploy Op goes under the build root, so the build writes src/dist/ops/deploy/op.json too: an Op's output goes under its build root.
  cpSync(join(EXAMPLE, "deploy.op.ts"), join(dir, "src", "deploy.op.ts"));
  const web = readFileSync(join(dir, "src", "web.ts"), "utf-8");
  writeFileSync(
    join(dir, "src", "web.ts"),
    `import { params } from "@intentius/chant/params";\n${web.replace("replicas: 2,", "replicas: params.replicas as number,")}`,
  );
  writeFileSync(
    join(dir, "chant.config.ts"),
    `export default {\n  lexicons: ["k8s"],\n  sourceDir: "src",\n  environments: ["dev", "prod"],\n  buildParams: { replicas: { type: "number", default: 2 } },\n};\n`,
  );
  writeFileSync(join(dir, "params.dev.json"), `{ "replicas": 1 }\n`);
  writeFileSync(join(dir, "params.prod.json"), `{ "replicas": 3 }\n`);
  writeFileSync(join(dir, ".gitignore"), "node_modules\ndist/\nout/\n");
}

describe("an implicit release of a project with no components", () => {
  test(
    "two cuts of one commit, in two clones, give byte-identical build output per environment and one release digest",
    () => {
      const root = mkdtempSync(join(tmpdir(), "chant-release-implicit-"));
      try {
        const a = join(root, "a");
        const b = join(root, "b");
        mkdirSync(a);
        writeProject(a);
        git(a, "init", "-q", "-b", "main");
        git(a, "config", "user.email", "t@chant.dev");
        git(a, "config", "user.name", "T");
        git(a, "add", ".");
        git(a, "commit", "-q", "-m", "init");
        const sha = git(a, "rev-parse", "HEAD");
        git(a, "tag", `ci/green/${sha}`);
        git(root, "clone", "-q", a, b);
        git(b, "remote", "remove", "origin");
        for (const d of [a, b]) symlinkSync(join(REPO, "node_modules"), join(d, "node_modules"), "dir");

        const cuts = [a, b].map((d, i) => {
          const r = chant(d, "release", "cut", ...(i === 0 ? ["v1"] : []), "--params-file", "params.{env}.json", "--json");
          expect(r.code, r.stderr).toBe(0);
          return JSON.parse(r.stdout);
        });
        const [first, second] = cuts;
        expect(second.release.releaseDigest).toBe(first.release.releaseDigest);
        expect(second.release).toEqual(first.release);
        expect(first.stored && second.stored).toBe(true);

        const release = first.release;
        expect(release.commit).toBe(sha);
        expect(release.artifactDigests).toEqual([]);
        expect(release.targets.map((t: { env: string }) => t.env)).toEqual(["dev", "prod"]);
        for (const t of release.targets) {
          expect(t.templates.map((x: { component: unknown; path: string }) => [x.component, x.path])).toEqual([
            [null, "dist/build.yaml"],
            [null, "src/dist/ops/deploy/op.json"],
          ]);
          expect(t.params).toEqual([{ name: "replicas", value: t.env === "prod" ? 3 : 1, source: "params-file" }]);
        }
        // The parameter reaches the output, so the two environments' manifests differ.
        expect(release.targets[0].templates[0].digest).not.toBe(release.targets[1].templates[0].digest);
        // Nothing was written into the member's directory by the cut.
        expect(existsSync(join(a, "dist")) || existsSync(join(a, "src", "dist"))).toBe(false);

        // Each clone's stored bytes, written out per environment, are the same bytes.
        for (const env of ["dev", "prod"]) {
          const [fromA, fromB] = [a, b].map((d) => {
            const ref = d === a ? "v1" : release.releaseDigest;
            const r = chant(d, "release", "export", ref, "--env", env, "-o", `out/${env}`);
            expect(r.code, r.stderr).toBe(0);
            return filesUnder(join(d, "out", env));
          });
          expect([...fromA.keys()].sort()).toEqual(["dist/build.yaml", "src/dist/ops/deploy/op.json"]);
          expect([...fromB.keys()].sort()).toEqual([...fromA.keys()].sort());
          for (const [path, bytes] of fromA) {
            expect(fromB.get(path)!.equals(bytes), `${env} ${path}`).toBe(true);
            const recorded = release.targets.find((t: { env: string }) => t.env === env).templates.find((x: { path: string }) => x.path === path);
            expect(contentDigest(bytes.toString("utf-8"))).toBe(recorded.digest);
          }
          expect(fromA.get("dist/build.yaml")!.toString("utf-8")).toContain(`replicas: ${env === "prod" ? 3 : 1}`);
        }

        // `release list --json` shows it as it shows any release.
        const list = chant(a, "release", "list", "--json");
        expect(list.code, list.stderr).toBe(0);
        const doc = JSON.parse(list.stdout);
        contract(releasesSchema).expectValid(doc);
        expect(doc.releases).toHaveLength(1);
        expect(doc.releases[0]).toMatchObject({ releaseDigest: release.releaseDigest, label: "v1", artifactDigests: [], environments: [] });

        // Promote has no component to deploy, and says what to run instead.
        const promote = chant(a, "components", "promote", "--from", "dev", "--to", "prod", "--release", "v1");
        expect(promote.code).toBe(1);
        expect(promote.stderr).toMatch(/release v1 is of a project with no components/);
        expect(promote.stderr).toMatch(/chant release export v1 --env prod/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    480_000,
  );
});
