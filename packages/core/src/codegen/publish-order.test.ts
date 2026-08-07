/**
 * Publishing a package runs its prepack, and a prepack builds against and
 * imports its workspace dependencies' *generated* output — output that only
 * exists once that dependency has been published. So publish order has to be a
 * topological order, and for a long time directory order stood in for one.
 *
 * It held until it did not. chant-v0.34.0 published twelve of fourteen packages
 * and stranded lexicon-forgejo and lexicon-helm a version behind: forgejo needs
 * github's `src/generated/index` and helm needs k8s's `dist/generated`, but
 * `forgejo` < `github` and `helm` < `k8s`, so both ran before the thing they
 * import existed. Half a release shipped and the failure only surfaced from
 * npm, after the tag.
 *
 * publish-packages.sh now derives the order instead of assuming one. This
 * asserts the derivation is actually topological, so the next lexicon that
 * depends on an alphabetically earlier one fails here rather than mid-release.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Run one of publish-packages.sh's own functions and read back what it prints. */
function ask(fn: string): string[] {
  const script = readFileSync(join(REPO, "scripts/publish-packages.sh"), "utf8");
  const body = script.match(new RegExp(`^${fn}\\(\\) \\{$.*?^\\}$`, "ms"));
  if (!body) throw new Error(`${fn}() not found in scripts/publish-packages.sh`);
  return execFileSync("bash", ["-c", `${body[0]}\n${fn}`], { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

const publishOrder = () => ask("publishable_dirs");

function manifest(dir: string) {
  return JSON.parse(readFileSync(join(REPO, dir, "package.json"), "utf8"));
}

describe("publish order", () => {
  const order = publishOrder();

  it("covers every publishable workspace package", () => {
    // A package missing from the order never publishes at all, which is the
    // same stranding by a different route.
    const all = execFileSync(
      "bash",
      ["-c", 'for d in packages/*/ lexicons/*/ wardens/*/; do [ -f "$d/package.json" ] && echo "${d%/}"; done'],
      { cwd: REPO, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((d) => !manifest(d).private);

    expect([...order].sort()).toEqual([...all].sort());
  });

  it("places every package after the workspace packages it depends on", () => {
    const position = new Map(order.map((d, i) => [d, i]));
    const owner = new Map(order.map((d) => [manifest(d).name as string, d]));

    for (const dir of order) {
      const pkg = manifest(dir);
      const deps = Object.keys({
        ...pkg.dependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies,
      });
      for (const name of deps) {
        const depDir = owner.get(name);
        if (!depDir || depDir === dir) continue;
        expect(
          position.get(depDir)!,
          `${pkg.name} (${dir}) publishes before its dependency ${name} (${depDir}), ` +
            `so ${name}'s generated output will not exist when ${pkg.name} prepacks`,
        ).toBeLessThan(position.get(dir)!);
      }
    }
  });

  it("puts the two packages that stranded chant-v0.34.0 after what they import", () => {
    // The specific regression, named, so the failure says what broke rather
    // than only that some invariant did.
    expect(order.indexOf("lexicons/github")).toBeLessThan(order.indexOf("lexicons/forgejo"));
    expect(order.indexOf("lexicons/k8s")).toBeLessThan(order.indexOf("lexicons/helm"));
  });
});

/**
 * Ordering alone did not fix the release. The rerun published nothing, found
 * k8s already at 0.34.0, skipped it — and skipping the publish skipped the
 * prepack that builds `dist/generated`, so helm failed on the same missing
 * module. Anything another package compiles against has to be built whether or
 * not it needs publishing.
 */
describe("packages built even when their publish is skipped", () => {
  const built = new Set(ask("depended_on_dirs"));
  const order = publishOrder();

  it("covers every workspace dependency, transitively", () => {
    for (const dir of order) {
      const pkg = manifest(dir);
      const owner = new Map(order.map((d) => [manifest(d).name as string, d]));
      for (const name of Object.keys({
        ...pkg.dependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies,
      })) {
        const depDir = owner.get(name);
        if (!depDir || depDir === dir) continue;
        expect(
          built.has(depDir),
          `${name} (${depDir}) is a dependency of ${pkg.name} but would not be built when ` +
            `its own publish is skipped, so ${pkg.name} compiles against nothing`,
        ).toBe(true);
      }
    }
  });

  it("includes the two whose skipped build failed the chant-v0.34.0 rerun", () => {
    expect(built.has("lexicons/k8s")).toBe(true);
    expect(built.has("lexicons/github")).toBe(true);
  });

  it("does not build a leaf nothing depends on", () => {
    // The set is the reason a rerun is not a full 14-package rebuild.
    expect(built.has("lexicons/helm")).toBe(false);
    expect(built.has("lexicons/forgejo")).toBe(false);
  });
});
