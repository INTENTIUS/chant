/**
 * #5230: a cut refuses an npm package the registry has never published,
 * before anything is recorded. The registry lookup is stubbed; nothing here
 * reaches npm.
 */
import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { cutRelease, ReleaseCutError } from "./release-cut";
import { checkPackagesPublished, declaredNpmPackages } from "./publish-npm";
import { PublishTargetError } from "./release-publish";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import type { ReleaseArtifact } from "./release-store";
import { TestRepo } from "../workspace/trust/test-repo";

const dirs: string[] = [];
const repos: TestRepo[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const tree = () => {
  const dir = mkdtempSync(join(tmpdir(), "npm-first-"));
  dirs.push(dir);
  for (const [path, pkg] of [["a", { name: "@acme/a", version: "1.0.0" }], ["b", { name: "@acme/b", version: "1.0.0" }], ["p", { name: "@acme/p", version: "1.0.0", private: true }]] as const) {
    mkdirSync(join(dir, path));
    writeFileSync(join(dir, path, "package.json"), JSON.stringify(pkg));
  }
  return dir;
};

describe("checkPackagesPublished", () => {
  test("lists the public packages the npm targets name, once each, with their registry", () => {
    const dir = tree();
    const decls = [{ type: "npm", packages: ["a", "p", "missing"], registry: "https://r.example" }, { type: "npm", packages: ["a", "b"] }, { type: "oci" }];
    expect(declaredNpmPackages(decls, dir)).toEqual([
      { name: "@acme/a", registry: "https://r.example" },
      { name: "@acme/a", registry: undefined },
      { name: "@acme/b", registry: undefined },
    ]);
  });

  test("passes when every package is published, and asks the declared registry", () => {
    const asked: Array<[string, string | undefined]> = [];
    checkPackagesPublished([{ type: "npm", packages: ["a"], registry: "https://r.example" }], tree(), (n, r) => (asked.push([n, r]), true));
    expect(asked).toEqual([["@acme/a", "https://r.example"]]);
  });

  test("refuses a package never published, naming it and the first-publish step", () => {
    const err = (() => {
      try {
        checkPackagesPublished([{ type: "npm", packages: ["a", "b"] }], tree(), (n) => n !== "@acme/b");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(PublishTargetError);
    expect((err as PublishTargetError).code).toBe("publish-npm-never-published");
    expect((err as PublishTargetError).message).toContain("@acme/b has never been published to npm");
    expect((err as PublishTargetError).fix).toContain("placeholder version of @acme/b");
    expect((err as PublishTargetError).fix).toContain("trusted publisher");
  });

  test("a registry that can't answer is a refusal, not a pass", () => {
    const lookup = () => {
      throw new PublishTargetError("publish-npm-registry-unreadable", "ENOTFOUND");
    };
    expect(() => checkPackagesPublished([{ type: "npm", packages: ["a"] }], tree(), lookup)).toThrow(/ENOTFOUND/);
  });
});

describe("the cut", () => {
  const compiler: TargetCompiler = {
    async compile(env): Promise<CompiledTarget> {
      return { env, params: [], components: [], buildSteps: {}, buildInputs: {}, componentFiles: {}, templates: [{ component: null, path: "dist/out.json", content: "{}\n" }] };
    },
    async buildArtifacts(): Promise<ReleaseArtifact[]> {
      return [];
    },
  };
  const repo = () => {
    const r = new TestRepo("npm-first-cut");
    repos.push(r);
    r.write("chant.config.ts", `export default { environments: ["dev"], release: { publish: [{ type: "npm", packages: ["."] }] } };\n`);
    r.write("package.json", JSON.stringify({ name: "@acme/app", version: "2.0.0" }));
    const head = r.commit("init");
    r.git(["tag", `ci/green/${head}`]);
    return r;
  };

  test("refuses a never-published package before it records anything, so the label is not spent", async () => {
    const r = repo();
    const err = await cutRelease({ cwd: r.dir, compiler, label: "v2", actor: "alice", env: {}, npmPublished: () => false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseCutError);
    expect((err as ReleaseCutError).code).toBe("publish-npm-never-published");
    expect((err as ReleaseCutError).message).toMatch(/^no release was cut: @acme\/app has never been published/);
    expect(() => r.git(["rev-parse", "--verify", "--quiet", "refs/heads/chant/lifecycle"])).toThrow();
  });

  test("an unreadable registry refuses the cut", async () => {
    const r = repo();
    const err = await cutRelease({
      cwd: r.dir,
      compiler,
      label: "v2",
      actor: "alice",
      env: {},
      npmPublished: () => {
        throw new PublishTargetError("publish-npm-registry-unreadable", "offline");
      },
    }).catch((e: unknown) => e);
    expect((err as ReleaseCutError).code).toBe("publish-npm-registry-unreadable");
  });

  test("an npm target that comes from an imported preset file is still checked", async () => {
    const r = new TestRepo("npm-first-preset");
    repos.push(r);
    r.write("preset.ts", `export const publish = [{ type: "npm", packages: ["."] }];\n`);
    r.write("chant.config.ts", `import { publish } from "./preset";\nexport default { environments: ["dev"], release: { publish } };\n`);
    r.write("package.json", JSON.stringify({ name: "@acme/app", version: "2.0.0" }));
    const head = r.commit("init");
    r.git(["tag", `ci/green/${head}`]);
    const err = await cutRelease({ cwd: r.dir, compiler, label: "v2", actor: "alice", env: {}, npmPublished: () => false }).catch((e: unknown) => e);
    expect((err as ReleaseCutError).code).toBe("publish-npm-never-published");
  });

  test("a published package cuts", async () => {
    const r = repo();
    const out = await cutRelease({ cwd: r.dir, compiler, label: "v2", actor: "alice", env: {}, npmPublished: () => true });
    expect(out.label).toBe("v2");
  });
});
