/**
 * The smoke images install chant from tarballs packed out of this checkout.
 * When a packed package depends on another workspace package the image does
 * not pack, npm fetches that one from the registry: a 404 before its first
 * publish, and a silent test of the registry copy after it (chant #2915, when
 * k8s started depending on prometheus). This reads which tarballs each smoke
 * Dockerfile packs and every workspace package's dependencies, and fails on a
 * packed package whose workspace dependency is not packed alongside it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The Dockerfiles that pack tarballs for a smoke script, and the script each feeds. */
const SMOKE_DOCKERFILES = {
  "test/Dockerfile.smoke-npm": "test/npm-smoke.sh",
  "test/Dockerfile.smoke-e2e": "test/e2e-smoke.sh",
};

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Workspace package directory (relative to the repo root) to its package.json. */
function workspaceManifests(): Map<string, Manifest> {
  const out = new Map<string, Manifest>();
  for (const parent of ["packages", "lexicons"]) {
    for (const entry of readdirSync(join(repoRoot, parent))) {
      const file = join(repoRoot, parent, entry, "package.json");
      if (existsSync(file)) out.set(`${parent}/${entry}`, JSON.parse(readFileSync(file, "utf-8")) as Manifest);
    }
  }
  return out;
}

/**
 * The workspace directories a Dockerfile packs, read from the tarball names it
 * writes: `/tarballs/core.tgz` and `/tarballs/lexicon-<dir>.tgz`, where a
 * `${lex}` name takes its values from the nearest `for lex in ...` above it.
 */
function packedDirs(dockerfile: string): string[] {
  const dirs = new Set<string>();
  for (const m of dockerfile.matchAll(/\/tarballs\/(core|lexicon-(\$\{lex\}|[\w-]+))\.tgz/g)) {
    if (m[1] === "core") {
      dirs.add("packages/core");
    } else if (m[2] === "${lex}") {
      const loops = [...dockerfile.slice(0, m.index).matchAll(/for lex in ([\w\s-]+?);/g)];
      const loop = loops.at(-1);
      if (!loop) throw new Error(`/tarballs/lexicon-\${lex}.tgz at offset ${m.index} has no "for lex in" loop above it`);
      for (const lex of loop[1].trim().split(/\s+/)) dirs.add(`lexicons/${lex}`);
    } else {
      dirs.add(`lexicons/${m[2]}`);
    }
  }
  return [...dirs].sort();
}

describe("packedDirs", () => {
  test("reads literal tarball names and expands a for-lex loop", () => {
    const dockerfile = [
      "RUN for lex in aws k8s; do jq . lexicons/$lex/package.json; done",
      "RUN cd /app/packages/core && npm pack && mv *.tgz /tarballs/core.tgz && \\",
      "    cd /app/lexicons/gcp && npm pack && mv *.tgz /tarballs/lexicon-gcp.tgz",
      "RUN for lex in fly prometheus; do \\",
      "      tar czf /tarballs/lexicon-${lex}.tgz -C /app/lexicons/$lex .; \\",
      "    done",
    ].join("\n");
    expect(packedDirs(dockerfile)).toEqual(["lexicons/fly", "lexicons/gcp", "lexicons/prometheus", "packages/core"]);
  });
});

describe("smoke images pack every workspace dependency of what they pack", () => {
  const manifests = workspaceManifests();
  const dirByName = new Map([...manifests].map(([dir, m]) => [m.name, dir]));

  /** "<packed package> depends on <workspace package the image does not pack>", per Dockerfile. */
  const unpacked = new Map<string, { pkg: string; dep: string }[]>();
  for (const dockerfilePath of Object.keys(SMOKE_DOCKERFILES)) {
    const packed = packedDirs(readFileSync(join(repoRoot, dockerfilePath), "utf-8"));
    const found: { pkg: string; dep: string }[] = [];
    for (const dir of packed) {
      const manifest = manifests.get(dir);
      if (!manifest) throw new Error(`${dockerfilePath} packs ${dir}, which is not a workspace package`);
      for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
        const depDir = dirByName.get(dep);
        if (depDir && !packed.includes(depDir)) found.push({ pkg: manifest.name, dep });
      }
    }
    unpacked.set(dockerfilePath, found);
  }

  for (const [dockerfilePath, script] of Object.entries(SMOKE_DOCKERFILES)) {
    test(`${dockerfilePath} (for ${script})`, () => {
      expect(
        unpacked.get(dockerfilePath)!.map(({ pkg, dep }) => `${pkg} depends on ${dep}`),
        `pack these in ${dockerfilePath} and install their tarballs next to their dependents in ${script}`,
      ).toEqual([]);
    });
  }
});
