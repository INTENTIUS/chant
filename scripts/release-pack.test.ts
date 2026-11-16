/**
 * scripts/release-pack.sh <member> <label> [--train <id>] (#5135) against a
 * throwaway repo: core, lexicons/k8s and lexicons/helm (which peers on core
 * and depends on k8s), a fake `npm` whose `pack` tars the package.json it
 * finds, and a fake chant whose `workspace train list npm --json` prints the
 * trains.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;

const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf-8" });

function write(file: string, text: string) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

const HELM = {
  name: "@intentius/chant-lexicon-helm",
  version: "0.124.34",
  peerDependencies: { "@intentius/chant": "^0.124.34", zod: "^4.3.6" },
  dependencies: { "@intentius/chant-lexicon-k8s": "^0.124.34", "js-yaml": "^4.3.1" },
};

function trains(...list: { id: string; members: Record<string, string | null> }[]) {
  return JSON.stringify({
    env: "npm",
    trains: list.map((t) => ({ id: t.id, trainDigest: `sha256:${t.id}`, members: Object.entries(t.members).map(([member, label]) => ({ member, label, releaseDigest: "d", commit: "c" })) })),
  });
}

function fakes(trainJson: string) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env bash
case "$1" in
  run) echo "prepack $PWD" >> "${dir}/.log" ;;
  pack)
    dest="$3"
    stage=$(mktemp -d)
    mkdir -p "$stage/package"
    cp package.json "$stage/package/"
    tar -czf "$dest/$(jq -r .name package.json | tr -d @ | tr / -)-$(jq -r .version package.json).tgz" -C "$stage" package
    echo "pack $PWD" >> "${dir}/.log" ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(join(bin, "npm"), 0o755);
  writeFileSync(join(bin, "fake-chant"), `#!/usr/bin/env bash\n[ "$*" = "workspace train list npm --json" ] || exit 2\ncat <<'JSON'\n${trainJson}\nJSON\n`);
  chmodSync(join(bin, "fake-chant"), 0o755);
}

function pack(...args: string[]) {
  return spawnSync("bash", ["scripts/release-pack.sh", ...args], {
    cwd: dir,
    encoding: "utf-8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, RELEASE_CHANT: join(dir, "bin", "fake-chant"), TMPDIR: dir },
  });
}

/** The package.json inside a packed tarball. */
function packed(slug: string) {
  return JSON.parse(execFileSync("tar", ["-xzOf", join(dir, ".release", "packs", `${slug}.tgz`), "package/package.json"], { encoding: "utf-8" }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-release-pack-"));
  git("init", "-q", "-b", "main");
  for (const f of ["release-pack.sh", "release-lib.sh"]) {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(join(import.meta.dirname, f), join(dir, "scripts", f));
  }
  write(".gitignore", ".release/\nbin/\n.log\nchant-release-pack.*\n");
  write(
    "chant.workspace.json",
    JSON.stringify({
      members: [
        { name: "core", dir: "packages/core" },
        { name: "lexicon-k8s", dir: "lexicons/k8s" },
        { name: "lexicon-helm", dir: "lexicons/helm" },
      ],
    }),
  );
  write("release/chant.workspace.json", "{}\n");
  write("packages/core/package.json", JSON.stringify({ name: "@intentius/chant", version: "0.124.34" }, null, 2) + "\n");
  write("lexicons/k8s/package.json", JSON.stringify({ name: "@intentius/chant-lexicon-k8s", version: "0.124.34", peerDependencies: { "@intentius/chant": "^0.124.34" } }, null, 2) + "\n");
  write("lexicons/helm/package.json", JSON.stringify(HELM, null, 2) + "\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("release-pack.sh <member> <label> --train (#5135)", () => {
  it("stamps each @intentius/* range from the train's label for that package", () => {
    fakes(trains({ id: "t1", members: { core: "0.125.4", "lexicon-k8s": "0.125.2", "lexicon-helm": "0.125.7" } }));
    const r = pack("lexicon-helm", "0.125.7", "--train", "t1");
    expect(r.status, r.stderr).toBe(0);
    const pkg = packed("lexicons_helm");
    expect(pkg.version).toBe("0.125.7");
    expect(pkg.peerDependencies).toEqual({ "@intentius/chant": "^0.125.4", zod: "^4.3.6" });
    expect(pkg.dependencies).toEqual({ "@intentius/chant-lexicon-k8s": "^0.125.2", "js-yaml": "^4.3.1" });
    // The checkout is as committed again.
    expect(git("status", "--porcelain")).toBe("");
    expect(JSON.parse(readFileSync(join(dir, "lexicons/helm/package.json"), "utf-8"))).toEqual(HELM);
  });

  it("runs the prepack of each workspace dependency, core first, before packing", () => {
    fakes(trains({ id: "t1", members: { core: "0.125.4", "lexicon-k8s": "0.125.2", "lexicon-helm": "0.125.7" } }));
    expect(pack("lexicon-helm", "0.125.7", "--train", "t1").status).toBe(0);
    const log = readFileSync(join(dir, ".log"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => `${l.split(" ")[0]} ${l.split("/").slice(-2).join("/")}`);
    expect(log).toEqual(["prepack packages/core", "prepack lexicons/k8s", "pack lexicons/helm"]);
  });

  it("finds the train by digest too, and the newest record of an id", () => {
    fakes(trains({ id: "t1", members: { core: "0.125.0", "lexicon-k8s": "0.125.0", "lexicon-helm": "0.125.0" } }, { id: "t2", members: { core: "0.125.1", "lexicon-k8s": "0.125.0", "lexicon-helm": "0.125.3" } }));
    const r = pack("lexicon-helm", "0.125.3", "--train", "sha256:t2");
    expect(r.status, r.stderr).toBe(0);
    expect(packed("lexicons_helm").peerDependencies["@intentius/chant"]).toBe("^0.125.1");
  });

  it("refuses when the train pins the member at another label", () => {
    fakes(trains({ id: "t1", members: { core: "0.125.4", "lexicon-k8s": "0.125.2", "lexicon-helm": "0.125.6" } }));
    const r = pack("lexicon-helm", "0.125.7", "--train", "t1");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("train t1 pins lexicon-helm at 0.125.6, not 0.125.7");
    expect(existsSync(join(dir, ".release/packs/lexicons_helm.tgz"))).toBe(false);
  });

  it("refuses when the train pins no release of a dependency, and leaves package.json as committed", () => {
    fakes(trains({ id: "t1", members: { core: "0.125.4", "lexicon-helm": "0.125.7" } }));
    const r = pack("lexicon-helm", "0.125.7", "--train", "t1");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("the train pins no release of @intentius/chant-lexicon-k8s");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("refuses a train it can't find", () => {
    fakes(trains());
    const r = pack("lexicon-helm", "0.125.7", "--train", "nope");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no release train nope for npm");
  });

  it("without --train sets the version and keeps the committed ranges", () => {
    fakes(trains());
    const r = pack("lexicon-helm", "0.125.7");
    expect(r.status, r.stderr).toBe(0);
    const pkg = packed("lexicons_helm");
    expect(pkg.version).toBe("0.125.7");
    expect(pkg.peerDependencies).toEqual(HELM.peerDependencies);
    expect(pkg.dependencies).toEqual(HELM.dependencies);
  });

  it("keeps another member's tarball in .release/packs", () => {
    fakes(trains({ id: "t1", members: { core: "0.125.4", "lexicon-k8s": "0.125.2", "lexicon-helm": "0.125.7" } }));
    expect(pack("lexicon-k8s", "0.125.2", "--train", "t1").status).toBe(0);
    expect(pack("lexicon-helm", "0.125.7", "--train", "t1").status).toBe(0);
    expect(packed("lexicons_k8s").version).toBe("0.125.2");
    expect(packed("lexicons_k8s").peerDependencies["@intentius/chant"]).toBe("^0.125.4");
    expect(packed("lexicons_helm").version).toBe("0.125.7");
  });

  it("refuses a member the declaration does not name", () => {
    fakes(trains());
    const r = pack("lexicon-nope", "0.125.7");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no member lexicon-nope in chant.workspace.json");
  });
});
