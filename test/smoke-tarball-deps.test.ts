/**
 * The smoke images install chant from tarballs packed out of this checkout.
 * When a packed package depends on another workspace package the image does
 * not pack, npm fetches that one from the registry: a 404 before its first
 * publish, and a silent test of the registry copy after it (chant #2915, when
 * k8s started depending on prometheus). This reads which tarballs each smoke
 * Dockerfile packs and every workspace package's dependencies, and fails on a
 * packed package whose workspace dependency is not packed alongside it.
 *
 * It also checks that each image's list of lexicons does not drift: every
 * `for lex in` loop in a smoke Dockerfile names the set it packs, and the
 * smoke.sh function that prepacks for that image on the host names the same
 * set (chant #2503, #3096). The lists live in one file per image, which the
 * Dockerfile and smoke.sh both read.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The Dockerfiles that pack tarballs, with the script each feeds and the smoke.sh function that prepacks for it. */
const SMOKE_DOCKERFILES = {
  "test/Dockerfile.smoke-npm": { script: "test/npm-smoke.sh", prepackFn: "run_npm" },
  "test/Dockerfile.smoke-e2e": { script: "test/e2e-smoke.sh", prepackFn: "build_e2e_image" },
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
 * The words a `for lex in <list>; do` loop iterates over. The list is literal
 * words, `$(cat <file>)` or `$(<file>)`, or `$NAME` / `$name` for a variable
 * assigned one of those earlier in `before`. File paths are read through
 * `paths`, which maps the source's own path prefixes (`/app/`, `$SCRIPT_DIR/`)
 * to repo-relative ones.
 */
function loopWords(list: string, before: string, paths: Record<string, string>): string[] {
  const readList = (expr: string): string[] | undefined => {
    const m = /^\$\((?:cat\s+|<\s*)"?([^")\s]+)"?\)$/.exec(expr.trim());
    if (!m) return undefined;
    let file = m[1];
    for (const [prefix, to] of Object.entries(paths)) if (file.startsWith(prefix)) file = to + file.slice(prefix.length);
    return readFileSync(join(repoRoot, file), "utf-8").trim().split(/\s+/);
  };
  const expr = list.trim();
  const fromFile = readList(expr);
  if (fromFile) return fromFile;
  const variable = /^"?\$\{?(\w+)\}?"?$/.exec(expr);
  if (variable) {
    const assignments = [...before.matchAll(new RegExp(`\\b${variable[1]}=(\\$\\([^)]*\\))`, "g"))];
    const assigned = assignments.at(-1);
    const words = assigned && readList(assigned[1]);
    if (!words) throw new Error(`for lex in ${expr}: no ${variable[1]}=$(cat <file>) assignment above it`);
    return words;
  }
  return expr.split(/\s+/);
}

/** Every `for lex in ...; do` loop in `source`, as its offset and the lexicons it names. */
function lexLoops(source: string, paths: Record<string, string>): { index: number; lexicons: string[] }[] {
  return [...source.matchAll(/for lex in ([^;\n]+);\s*do/g)].map((m) => ({
    index: m.index,
    lexicons: loopWords(m[1], source.slice(0, m.index), paths),
  }));
}

const DOCKERFILE_PATHS = { "/app/": "" };
const SMOKE_SH_PATHS = { "$SCRIPT_DIR/": "test/", "$PROJECT_DIR/": "" };

/**
 * The workspace directories a Dockerfile packs, read from the tarball names it
 * writes: `/tarballs/core.tgz` and `/tarballs/lexicon-<dir>.tgz`, where a
 * `${lex}` name takes its values from the nearest `for lex in ...` above it.
 */
function packedDirs(dockerfile: string): string[] {
  const dirs = new Set<string>();
  const loops = lexLoops(dockerfile, DOCKERFILE_PATHS);
  for (const m of dockerfile.matchAll(/\/tarballs\/(core|lexicon-(\$\{lex\}|[\w-]+))\.tgz/g)) {
    if (m[1] === "core") {
      dirs.add("packages/core");
    } else if (m[2] === "${lex}") {
      const loop = loops.filter((l) => l.index < m.index).at(-1);
      if (!loop) throw new Error(`/tarballs/lexicon-\${lex}.tgz at offset ${m.index} has no "for lex in" loop above it`);
      for (const lex of loop.lexicons) dirs.add(`lexicons/${lex}`);
    } else {
      dirs.add(`lexicons/${m[2]}`);
    }
  }
  return [...dirs].sort();
}

/** The body of the shell function `name` in `script`, from its `name() {` line to the closing `}` at column 0. */
function shellFunction(script: string, name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, "m").exec(script);
  if (!m) throw new Error(`no ${name}() function`);
  return m[1];
}

const sortedLexDirs = (lexicons: string[]) => [...new Set(lexicons.map((l) => `lexicons/${l}`))].sort();

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

  test("reads a loop over a list file, directly or through a variable", () => {
    const dockerfile = [
      "RUN for lex in $(cat /app/test/smoke-e2e-lexicons.txt); do echo $lex; done",
      "RUN LEXICONS=$(cat /app/test/smoke-npm-lexicons.txt) && \\",
      "    for lex in $LEXICONS; do tar czf /tarballs/lexicon-${lex}.tgz .; done",
    ].join("\n");
    const npmList = readFileSync(join(repoRoot, "test/smoke-npm-lexicons.txt"), "utf-8").trim().split(/\s+/);
    expect(packedDirs(dockerfile)).toEqual(sortedLexDirs(npmList));
    expect(lexLoops(dockerfile, DOCKERFILE_PATHS)[0].lexicons).toEqual(
      readFileSync(join(repoRoot, "test/smoke-e2e-lexicons.txt"), "utf-8").trim().split(/\s+/),
    );
  });
});

describe("each smoke image's lexicon list does not drift", () => {
  const smokeSh = readFileSync(join(repoRoot, "test/smoke.sh"), "utf-8");

  for (const [dockerfilePath, { prepackFn }] of Object.entries(SMOKE_DOCKERFILES)) {
    const dockerfile = readFileSync(join(repoRoot, dockerfilePath), "utf-8");
    const packedLexicons = packedDirs(dockerfile).filter((d) => d.startsWith("lexicons/"));

    test(`every for-lex loop in ${dockerfilePath} names the lexicons it packs`, () => {
      for (const loop of lexLoops(dockerfile, DOCKERFILE_PATHS)) {
        expect(sortedLexDirs(loop.lexicons), `the loop at offset ${loop.index}`).toEqual(packedLexicons);
      }
    });

    test(`smoke.sh ${prepackFn} prepacks the lexicons ${dockerfilePath} packs`, () => {
      const loops = lexLoops(shellFunction(smokeSh, prepackFn), SMOKE_SH_PATHS);
      expect(loops, `${prepackFn} should have one prepack loop`).toHaveLength(1);
      expect(
        sortedLexDirs(loops[0].lexicons),
        `${prepackFn} must prepack the list ${dockerfilePath} packs; read the same list file`,
      ).toEqual(packedLexicons);
    });
  }
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

  for (const [dockerfilePath, { script }] of Object.entries(SMOKE_DOCKERFILES)) {
    test(`${dockerfilePath} (for ${script})`, () => {
      expect(
        unpacked.get(dockerfilePath)!.map(({ pkg, dep }) => `${pkg} depends on ${dep}`),
        `pack these in ${dockerfilePath} and install their tarballs next to their dependents in ${script}`,
      ).toEqual([]);
    });
  }
});
