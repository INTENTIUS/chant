/**
 * chant's own release member (#4040): release/chant.config.ts names the
 * tarballs scripts/release-pack.sh writes, and `chant release publish`
 * publishes them in the order listed. The list must name every package npm
 * would publish, once, and each after the workspace packages it depends on,
 * as publish-packages.sh's layers order them: a consumer installing between
 * two publishes must never find a package whose dependency is not out yet.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../release/chant.config";

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

describe("release/chant.config.ts (#4040)", () => {
  const npm = config.release.publish.find((t) => t.type === "npm");
  const listed = (npm?.packages ?? []).map((p) => p.replace(/^\.\.\/\.release\/packs\//, "").replace(/\.tgz$/, "").replace("_", "/"));

  it("publishes straight to latest, core first, with NPM_TOKEN as the fallback", () => {
    expect(npm?.stage).toBe(false);
    expect(npm?.tokenEnv).toBe("NPM_TOKEN");
    expect(listed[0]).toBe("packages/core");
  });

  it("names every package npm would publish, once", () => {
    expect([...listed].sort()).toEqual(publishable().map((p) => p.dir).sort());
  });

  it("lists each package after the workspace packages it depends on", () => {
    const pkgs = publishable();
    const byName = new Map(pkgs.map((p) => [p.name, p.dir]));
    const late: string[] = [];
    for (const p of pkgs) {
      for (const dep of p.deps) {
        const dir = byName.get(dep);
        if (dir && listed.indexOf(dir) > listed.indexOf(p.dir)) late.push(`${p.dir} before its dependency ${dir}`);
      }
    }
    expect(late).toEqual([]);
  });
});
