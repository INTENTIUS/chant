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
 * publish-packages.sh now derives the order instead of assuming one, as
 * dependency layers that pack in parallel (#3857). This asserts the
 * derivation is actually topological, so the next lexicon that depends on an
 * alphabetically earlier one fails here rather than mid-release.
 *
 * With CHANT_STAGED_PUBLISH=1 (#3903) every package publishes under `next`
 * in one batch instead, and the order that reaches consumers is the order
 * `latest` moves in, which `tag_layers` derives from peer and optional edges.
 * Both modes are checked at the end of this file.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** `layer dir name version deps` rows, in publish order. */
const publishLayers = () => ask("publish_layers").map((line) => line.split("\t"));
const publishOrder = () => publishLayers().map((row) => row[1]);

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
      ["-c", 'for d in packages/*/ lexicons/*/; do [ -f "$d/package.json" ] && echo "${d%/}"; done'],
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

  it("puts every package in a later layer than its dependencies", () => {
    // #3857: a layer publishes in parallel, so a dependency in the same layer
    // would race its dependent rather than precede it.
    const rows = publishLayers();
    const layer = new Map(rows.map(([l, d]) => [d, Number(l)]));
    for (const [l, dir, name, , deps] of rows) {
      for (const dep of deps ? deps.split(",") : []) {
        expect(layer.get(dep), `${name} (${dir}) is in layer ${l}, not after its dependency ${dep}`)
          .toBeLessThan(Number(l));
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

/**
 * #3903: a release is staged under `next` and only becomes visible to range
 * consumers when `latest` moves. The #3856 research found that when a
 * lexicon's `latest` showed before core's, pnpm, bun and yarn installed the
 * new lexicon against the old core with the peer unmet, and exited 0. So
 * `latest` moves in waves, each package after everything it peers on.
 */
describe("latest tag order", () => {
  const waves = new Map(
    ask("tag_layers").map((line) => {
      const [wave, dir] = line.split("\t");
      return [dir, Number(wave)] as const;
    }),
  );
  const order = publishOrder();

  it("covers every package that publishes", () => {
    expect([...waves.keys()].sort()).toEqual([...order].sort());
  });

  it("moves a package's latest after every package it peers on or optionally depends on", () => {
    const owner = new Map(order.map((d) => [manifest(d).name as string, d]));
    for (const dir of order) {
      const pkg = manifest(dir);
      for (const name of Object.keys({ ...pkg.peerDependencies, ...pkg.optionalDependencies })) {
        const depDir = owner.get(name);
        if (!depDir || depDir === dir) continue;
        expect(
          waves.get(depDir)!,
          `${pkg.name} would move latest in wave ${waves.get(dir)}, no later than ${name} (wave ${waves.get(depDir)}), ` +
            `so a consumer could get the new ${pkg.name} against the old ${name}`,
        ).toBeLessThan(waves.get(dir)!);
      }
    }
  });

  it("moves core and k8s-client first, and no lexicon with them", () => {
    expect(waves.get("packages/core")).toBe(0);
    expect(waves.get("packages/k8s-client")).toBe(0);
    for (const [dir, wave] of waves) {
      if (dir.startsWith("lexicons/")) expect(wave, `${dir} moves latest with core`).toBeGreaterThan(0);
    }
  });

  it("moves github before the two lexicons that peer on it", () => {
    expect(waves.get("lexicons/github")).toBeLessThan(waves.get("lexicons/forgejo")!);
    expect(waves.get("lexicons/github")).toBeLessThan(waves.get("lexicons/gitlab")!);
  });

});

/**
 * Staging is opt-in until every trusted-publisher record allows dist-tag
 * moves (#3904). Off, the script must publish exactly as it did before
 * #3903: straight to `latest`, layer by layer, with no tag moves.
 */
describe("publish modes (#3903)", () => {
  const script = readFileSync(join(REPO, "scripts/publish-packages.sh"), "utf8");
  const publishes = script
    .split("\n")
    .filter((line) => !line.trim().startsWith("#") && /\bnpm publish "\$tgz"/.test(line));

  it("passes --tag next to npm publish only when CHANT_STAGED_PUBLISH is 1", () => {
    expect(publishes.length).toBeGreaterThan(0);
    for (const line of publishes) {
      expect(line).not.toMatch(/--tag next/);
      expect(line).toContain('${TAG_ARGS[@]+"${TAG_ARGS[@]}"}');
    }
    expect(script).toMatch(/^TAG_ARGS=\(\)$/m);
    expect(script).toMatch(/^\[ -n "\$STAGED" \] && TAG_ARGS=\(--tag next\)$/m);
    expect(script).toMatch(/^\[ "\$\{CHANT_STAGED_PUBLISH:-\}" = "1" \] && STAGED=1$/m);
  });

  it("moves latest with dist-tag only in the staged flow", () => {
    const legacy = script.match(/^if \[ -z "\$STAGED" \]; then$.*?^fi$/ms);
    expect(legacy, "the default publish block").not.toBeNull();
    expect(legacy![0]).toMatch(/wait_visible/);
    expect(legacy![0]).not.toMatch(/dist-tag|move_latest/);
    expect(legacy![0]).toMatch(/^  exit 0$/m);
    expect(script).toMatch(/dist-tag add "\$name@\$version" latest/);
  });

  // A stub npm whose every answer is an old version, so every package plans
  // to publish. DRY_RUN=plan reads the registry and the graph, builds nothing.
  function plan(env: Record<string, string>): string {
    const bin = mkdtempSync(join(tmpdir(), "publish-plan-"));
    writeFileSync(join(bin, "npm"), "#!/bin/sh\necho 0.0.1\n");
    chmodSync(join(bin, "npm"), 0o755);
    return execFileSync("bash", ["scripts/publish-packages.sh"], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DRY_RUN: "plan", RUNNER_TEMP: bin, ...env },
    });
  }

  it("plans a layered publish to latest by default", () => {
    const out = plan({ CHANT_STAGED_PUBLISH: "" });
    expect(out).toMatch(/@intentius\/chant \S+: publish \(live: 0\.0\.1\)/);
    expect(out).not.toMatch(/under next|wave \d/);
  });

  it("plans a staged publish and the tag waves with CHANT_STAGED_PUBLISH=1", () => {
    const out = plan({ CHANT_STAGED_PUBLISH: "1" });
    expect(out).toMatch(/@intentius\/chant \S+: publish under next \(latest: 0\.0\.1\)/);
    expect(out).toMatch(/^  wave 0: @intentius\/chant @intentius\/chant-k8s-client$/m);
  });
});
