/**
 * chant #1984 — the offline half of chant, tested rather than asserted.
 *
 * The claim under test is that the phases an adopter runs on every commit —
 * `chant build`, `chant lint`, `chant scenario check`, `chant search` — reach
 * no network at all, and that the phases which *do* reach one are a closed,
 * named set. Both halves are checked here, by two different mechanisms,
 * because either alone is weaker than it looks.
 *
 * ## Why not grep
 *
 * A grep-based test ("no file on the build path contains `fetch(`") is easy to
 * fool and easy to break. It cannot see egress that arrives through a
 * dependency, it cannot see a socket opened by a spelling it was not taught,
 * and it goes red on a comment. Worse, it proves the wrong thing: what matters
 * is whether a build *makes a call*, not whether some module it can reach
 * contains the word.
 *
 * ## The mechanism
 *
 * `net.Socket.prototype.connect` is replaced, for the duration of each guarded
 * phase, by a recording throw. That one patch is the whole TCP surface of the
 * process: `net.connect`, `tls.connect`, `http.request`, `https.request` and
 * the global `fetch` (undici) all construct a `net.Socket` — or a `TLSSocket`,
 * which extends it — and call `.connect()` on it. Patching the prototype works
 * regardless of how the calling module imported the builtin, which patching
 * the module's exports does not: an ESM `import { createConnection } from
 * "node:net"` binds the original and never sees a mutated exports object.
 *
 * `globalThis.fetch` is patched too, not for coverage but for the error
 * message: a violation names the URL that was requested instead of a host and
 * port. The socket patch is what makes the guarantee.
 *
 * Nothing here touches a real network, so there is nothing to be flaky about:
 * the guard is armed synchronously around a call and disarmed in a `finally`,
 * and a passing run makes no connection attempts to time out.
 *
 * ## What the mechanism cannot cover, and what covers it instead
 *
 * A child process is not in this process, so nothing this file patches applies
 * to one. Rather than imply coverage it does not have, the guard **records
 * every spawn** the guarded phases make — through a `vi.mock` recorder that
 * catches the sync variants too — and fails on a binary that is not in
 * `OFFLINE_SHELL_OUTS` (./egress-catalogue.ts). That list is the enumeration
 * #1984 asks for: `git check-ignore` on the lint path, `git fetch` on the one
 * `scenario check` branch that reads the lifecycle branch, and the sandbox
 * child. What a child then does of its own is outside the guard, and is stated
 * as such on the published page.
 *
 * A bare DNS query is also outside it: `node:dns` is not reached through a
 * socket. Nothing in the tree imports it, and the static half below is what
 * keeps that true.
 *
 * ## This is a regression gate, not a security boundary
 *
 * `docs/.../architecture/sandbox.mdx` argues that a bootstrap-time patch over
 * `fetch`/`http`/`net` inside the sandbox child would be dishonest to call a
 * boundary, because a hostile file defeats it by importing its own copy of
 * `node:http` or shelling out. That argument is correct and it applies here
 * too — with a different subject. The code this file guards is chant's own,
 * it is not trying to escape, and what is being caught is a maintainer adding
 * a call by accident. Nothing here is claimed to constrain project code; that
 * remains the sandbox page's deployment guidance (no route out of the
 * container).
 *
 * ## The static half
 *
 * The runtime half can only prove things about paths it can execute. Apply,
 * Ops and codegen need credentials, a substrate, or an upstream endpoint, so
 * they are covered the other way: {@link scanEgressSites} enumerates every
 * module in `packages/`, `lexicons/`, `scripts/` and `ops/` that names a
 * network primitive, and the enumeration must equal `EGRESS_CATALOGUE`
 * exactly. A new `fetch` anywhere fails here; a removed one fails here too.
 * The published page is generated from that same catalogue, so it cannot drift
 * from what the tree does.
 */

import { describe, expect, test, vi, afterAll } from "vitest";
import { Socket } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

// ── The shell-out recorder ───────────────────────────────────────────────────
//
// `ChildProcess.prototype.spawn` would catch `spawn`/`exec`/`execFile`/`fork`
// but not `spawnSync`/`execSync`/`execFileSync`, which reach the internal
// binding directly — and `chant lint` uses `execFileSync`. vitest's module
// runner transforms workspace source, so mocking the builtin catches every
// form. Both specifiers are mocked: core imports `"child_process"` in some
// modules and `"node:child_process"` in others.

const spawns: string[] = [];

function recordSpawns(actual: typeof import("node:child_process")): typeof import("node:child_process") {
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
    const original = actual[name] as (...args: unknown[]) => unknown;
    wrapped[name] = (...args: unknown[]) => {
      if (armed) spawns.push(basename(String(args[0]).split(/\s+/)[0]));
      return original(...args);
    };
  }
  return wrapped as unknown as typeof import("node:child_process");
}

vi.mock("node:child_process", async (importOriginal) =>
  recordSpawns(await importOriginal<typeof import("node:child_process")>()),
);
vi.mock("child_process", async (importOriginal) =>
  recordSpawns(await importOriginal<typeof import("node:child_process")>()),
);

const { build } = await import("@intentius/chant/build");
const { buildCommand } = await import("@intentius/chant/cli/commands/build");
const { lintCommand } = await import("@intentius/chant/cli/commands/lint");
const { runSearch } = await import("../packages/core/src/cli/handlers/search");
const { runScenarioCheck } = await import("../packages/core/src/cli/handlers/scenario");
const { discoverCorpus, entryBuildParams, ALL_SERIALIZERS, ALL_PLUGINS } = await import(
  "../examples/differential-corpus"
);
const {
  EGRESS_CATALOGUE,
  EGRESS_CATALOGUE_DOCS,
  OFFLINE_SHELL_OUTS,
  extractEgressCatalogueBlock,
  renderEgressCatalogueBlock,
  scanEgressSites,
} = await import("./egress-catalogue");

const ROOT = resolve(import.meta.dirname, "..");

// ── The egress guard ─────────────────────────────────────────────────────────

interface EgressAttempt {
  /** Which guarded phase was running. */
  phase: string;
  /** The primitive that was reached for. */
  via: string;
  /** Host/port or URL, as far as the call site gave one. */
  target: string;
}

/** Thrown at the call site so the phase under test fails loudly rather than hanging. */
class EgressBlocked extends Error {}

const attempts: EgressAttempt[] = [];
let armed = false;
let currentPhase = "";

function describeTarget(arg: unknown): string {
  // `net.connect(...)` normalizes its arguments itself and hands
  // `Socket.prototype.connect` the resulting `[options, callback]` array, so
  // the target is one level in for that call shape and not for the others.
  if (Array.isArray(arg)) return describeTarget(arg[0]);
  if (typeof arg === "string" || typeof arg === "number") return String(arg);
  if (arg && typeof arg === "object") {
    const o = arg as { host?: string; hostname?: string; port?: number; path?: string; href?: string };
    if (o.href) return o.href;
    if (o.path && !o.host && !o.hostname) return `unix:${o.path}`;
    return `${o.hostname ?? o.host ?? "?"}:${o.port ?? "?"}`;
  }
  return "?";
}

const realConnect = Socket.prototype.connect;
const realFetch = globalThis.fetch;

Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
  if (!armed) return (realConnect as (...a: unknown[]) => Socket).apply(this, args);
  const target = describeTarget(args[0]);
  attempts.push({ phase: currentPhase, via: "net.Socket.prototype.connect", target });
  throw new EgressBlocked(`${currentPhase} opened a socket to ${target}`);
} as typeof realConnect;

globalThis.fetch = ((input: unknown, init?: unknown) => {
  if (!armed) return (realFetch as (...a: unknown[]) => Promise<Response>)(input, init);
  const target = describeTarget(
    typeof input === "string" ? input : ((input as { url?: string })?.url ?? input),
  );
  attempts.push({ phase: currentPhase, via: "globalThis.fetch", target });
  throw new EgressBlocked(`${currentPhase} called fetch(${target})`);
}) as typeof fetch;

afterAll(() => {
  Socket.prototype.connect = realConnect;
  globalThis.fetch = realFetch;
});

/** Run `fn` with every in-process network primitive replaced by a recording throw. */
async function withoutEgress<T>(phase: string, fn: () => Promise<T> | T): Promise<T> {
  currentPhase = phase;
  armed = true;
  try {
    return await fn();
  } finally {
    armed = false;
  }
}

/** Attempts recorded since `mark`, formatted for an assertion message. */
function attemptsSince(mark: number): string[] {
  return attempts.slice(mark).map((a) => `${a.phase}: ${a.via} → ${a.target}`);
}

/** Run `fn` in `dir`, restoring the working directory afterwards. */
async function inDirectory<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

const CORPUS = await discoverCorpus();

/**
 * One entry per corpus group — `examples/` and each `lexicons/<name>/examples/`
 * — for the phases too slow to run over all of it. Derived rather than listed,
 * so a new lexicon's fixtures are covered the day they land.
 */
const REPRESENTATIVE = (() => {
  const byGroup = new Map<string, (typeof CORPUS)[number]>();
  for (const entry of CORPUS) {
    const parts = entry.name.split("/");
    const group = parts[0] === "lexicons" ? `lexicons/${parts[1]}` : parts[0];
    if (!byGroup.has(group)) byGroup.set(group, entry);
  }
  return [...byGroup.values()];
})();

interface PhaseReport {
  phase: string;
  projects: number;
  violations: number;
}
const report: PhaseReport[] = [];

// ── The guarded phases ───────────────────────────────────────────────────────

describe("chant #1984 — the phases an adopter runs reach no network", () => {
  test(`the corpus is non-empty (found ${CORPUS.length} projects)`, () => {
    expect(CORPUS.length).toBeGreaterThan(0);
    expect(REPRESENTATIVE.length).toBeGreaterThan(1);
  });

  test("chant build: no corpus project's build opens a connection", async () => {
    const violations: string[] = [];
    for (const entry of CORPUS) {
      const mark = attempts.length;
      const result = await withoutEgress(`build ${entry.name}`, async () =>
        build(entry.srcDir, entry.serializers, undefined, {
          intrinsics: entry.intrinsics,
          lexicons: entry.lexicons,
          buildParams: await entryBuildParams(entry),
        }),
      );
      expect(result.errors, `${entry.name}: the build itself failed`).toEqual([]);
      violations.push(...attemptsSince(mark));
    }
    report.push({ phase: "chant build", projects: CORPUS.length, violations: violations.length });
    expect(violations, "a plain build reached the network").toEqual([]);
  });

  test("chant build --fold: folding a project opens no connection either", async () => {
    const violations: string[] = [];
    for (const entry of CORPUS) {
      const mark = attempts.length;
      const result = await withoutEgress(`build --fold ${entry.name}`, async () =>
        build(entry.srcDir, entry.serializers, undefined, {
          fold: true,
          intrinsics: entry.intrinsics,
          lexicons: entry.lexicons,
          buildParams: await entryBuildParams(entry),
        }),
      );
      expect(result.errors, `${entry.name}: the folded build itself failed`).toEqual([]);
      violations.push(...attemptsSince(mark));
    }
    report.push({ phase: "chant build --fold", projects: CORPUS.length, violations: violations.length });
    expect(violations, "a folded build reached the network").toEqual([]);
  });

  test("chant build (CLI, with post-synth checks): no lexicon's checks reach out", async () => {
    // `build()` above stops at serialization. `buildCommand` is what a real
    // `chant build` runs: it also loads the project's config and policies and
    // runs every plugin's post-synth checks, which is where a lexicon could
    // reach for a live lookup without the corpus loop ever noticing.
    const outDir = mkdtempSync(join(tmpdir(), "chant-1984-"));
    const violations: string[] = [];
    try {
      for (const entry of REPRESENTATIVE) {
        const mark = attempts.length;
        await withoutEgress(`buildCommand ${entry.name}`, () =>
          buildCommand({
            path: entry.srcDir,
            format: "json",
            serializers: entry.serializers,
            plugins: entry.plugins,
            output: join(outDir, `${entry.name.replace(/[/\\]/g, "_")}.json`),
          }),
        );
        violations.push(...attemptsSince(mark));
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
    report.push({ phase: "chant build (CLI)", projects: REPRESENTATIVE.length, violations: violations.length });
    expect(violations, "the CLI build path — config, policies, post-synth checks — reached the network").toEqual([]);
  });

  test("chant build --sandbox: neither the CLI process nor the child dials out", async () => {
    // The child evaluates project code in its own process, so this asserts the
    // parent only. What the child does is covered by the shell-out enumeration
    // below, not by this patch.
    const violations: string[] = [];
    for (const entry of REPRESENTATIVE) {
      const mark = attempts.length;
      await withoutEgress(`build --sandbox ${entry.name}`, async () =>
        build(entry.srcDir, entry.serializers, undefined, {
          fold: true,
          sandbox: true,
          intrinsics: entry.intrinsics,
          lexicons: entry.lexicons,
          buildParams: await entryBuildParams(entry),
        }),
      );
      violations.push(...attemptsSince(mark));
    }
    report.push({ phase: "chant build --sandbox", projects: REPRESENTATIVE.length, violations: violations.length });
    expect(violations, "a sandboxed build reached the network from the CLI process").toEqual([]);
  });

  test("chant lint: no rule, no post-synth check and no policy reaches out", async () => {
    const violations: string[] = [];
    for (const entry of CORPUS) {
      const mark = attempts.length;
      await withoutEgress(`lint ${entry.name}`, () => lintCommand({ path: entry.srcDir, format: "json" }));
      violations.push(...attemptsSince(mark));
    }
    report.push({ phase: "chant lint", projects: CORPUS.length, violations: violations.length });
    expect(violations, "linting reached the network").toEqual([]);
  });

  test("chant search: answering from the declared graph reaches nothing", async () => {
    const project = resolve(ROOT, "examples/k8s-eks-microservice");
    const mark = attempts.length;
    const code = await inDirectory(project, () =>
      withoutEgress("search", () =>
        runSearch({
          args: {
            command: "search",
            path: "kind:Deployment",
            format: "",
            fix: false,
            watch: false,
            verbose: false,
            help: false,
            live: false,
            src: "src",
          },
          plugins: ALL_PLUGINS,
          serializers: ALL_SERIALIZERS,
        }),
      ),
    );
    expect(code, "chant search failed on the example project").toBe(0);
    report.push({ phase: "chant search", projects: 1, violations: attemptsSince(mark).length });
    expect(attemptsSince(mark), "chant search reached the network without --live").toEqual([]);
  });

  test("chant scenario check: a file fixture stands in for the live read", async () => {
    const project = resolve(ROOT, "test/fixtures/egress-scenario");
    const mark = attempts.length;
    const code = await inDirectory(project, () =>
      withoutEgress("scenario check", () =>
        runScenarioCheck({
          args: {
            command: "scenario",
            path: "check",
            format: "",
            fix: false,
            watch: false,
            verbose: false,
            help: false,
            live: false,
            src: "src",
            json: true,
          },
          plugins: ALL_PLUGINS,
          serializers: ALL_SERIALIZERS,
        }),
      ),
    );
    expect(code, "the fixture scenario did not pass — the guard would be measuring a failed run").toBe(0);
    report.push({ phase: "chant scenario check", projects: 1, violations: attemptsSince(mark).length });
    expect(attemptsSince(mark), "chant scenario check reached the network").toEqual([]);
  });
});

// ── The shell-outs the guard cannot cover ────────────────────────────────────

describe("chant #1984 — the offline phases' shell-outs are enumerated, not covered", () => {
  test("every binary spawned during a guarded phase is in the catalogue", () => {
    const allowed = new Set(OFFLINE_SHELL_OUTS.map((s) => s.binary));
    // The recorder reduces every spawn to a basename: a binary for
    // `spawn`/`exec`, and the forked module for `fork` — which is why the
    // sandbox child appears as `child.mjs` rather than as `node`.
    const observed = [...new Set(spawns)].sort();
    const unlisted = observed.filter((binary) => !allowed.has(binary));
    expect(
      unlisted,
      `these binaries were spawned by a guarded phase and are not in OFFLINE_SHELL_OUTS — add them to test/egress-catalogue.ts with what they do, or stop spawning them: ${observed.join(", ")}`,
    ).toEqual([]);
  });

  test("the recorder is not silently inert — the guarded phases did spawn something", () => {
    // `chant lint` runs `git check-ignore` on every corpus project. If this is
    // empty the mock never installed and the assertion above proved nothing.
    expect(spawns.length, "no child process was recorded at all — the child_process mock did not install").toBeGreaterThan(0);
  });
});

// ── The probes can fire ──────────────────────────────────────────────────────

describe("chant #1984 — the guard itself is not vacuous", () => {
  test("a deliberate fetch inside a guarded window is caught", async () => {
    const mark = attempts.length;
    await expect(
      withoutEgress("probe", () => fetch("https://example.invalid/probe")),
    ).rejects.toBeInstanceOf(EgressBlocked);
    expect(attemptsSince(mark)).toEqual(["probe: globalThis.fetch → https://example.invalid/probe"]);
    attempts.length = mark;
  });

  test("a deliberate socket, opened without fetch, is caught by the same guard", async () => {
    const mark = attempts.length;
    const { connect } = await import("node:net");
    await expect(
      withoutEgress("probe", () => {
        connect({ host: "example.invalid", port: 443 });
      }),
    ).rejects.toBeInstanceOf(EgressBlocked);
    expect(attemptsSince(mark)).toEqual(["probe: net.Socket.prototype.connect → example.invalid:443"]);
    attempts.length = mark;
  });

  test("an https request, which never touches globalThis.fetch, is caught too", async () => {
    const mark = attempts.length;
    const https = await import("node:https");
    await expect(
      withoutEgress("probe", () => {
        https.get("https://example.invalid/probe");
      }),
    ).rejects.toBeInstanceOf(EgressBlocked);
    expect(attemptsSince(mark).length, "https.get escaped the socket patch").toBe(1);
    attempts.length = mark;
  });

  test("the patches stay installed, and stay disarmed between phases", () => {
    // Installed for the whole file so nothing has to remember to arm them, and
    // disarmed outside a window so an unrelated suite in the same worker is
    // never affected by this one.
    expect(globalThis.fetch, "the fetch patch fell off").not.toBe(realFetch);
    expect(Socket.prototype.connect, "the socket patch fell off").not.toBe(realConnect);
    expect(armed, "a guarded window was left open").toBe(false);
  });
});

// ── The catalogue is closed, and the page is generated from it ───────────────

describe("chant #1984 — the egress catalogue matches the tree", () => {
  const scanned = scanEgressSites(ROOT);

  test(`the scan is non-trivial (found ${scanned.length} modules)`, () => {
    expect(scanned.length).toBeGreaterThan(10);
    expect(scanned.map((s) => s.file)).toContain("packages/core/src/codegen/fetch.ts");
  });

  test("every module that calls a network primitive is catalogued", () => {
    const catalogued = new Set(EGRESS_CATALOGUE.map((site) => site.file));
    const uncatalogued = scanned.filter((site) => !catalogued.has(site.file));
    expect(
      uncatalogued.map((site) => `${site.file} [${site.primitives.join(", ")}]`),
      "these modules reach the network and are not in EGRESS_CATALOGUE — add a row in test/egress-catalogue.ts saying which phase reaches it and why, then run `npm run generate:egress-catalogue`",
    ).toEqual([]);
  });

  test("no catalogue entry has gone stale", () => {
    const found = new Set(scanned.map((site) => site.file));
    const stale = EGRESS_CATALOGUE.filter((site) => !found.has(site.file)).map((site) => site.file);
    expect(
      stale,
      "these catalogue entries no longer call a network primitive (moved, or the call was removed) — delete their rows and run `npm run generate:egress-catalogue`",
    ).toEqual([]);
  });

  test("each entry names the primitives it actually reaches for", () => {
    const scannedBy = new Map(scanned.map((site) => [site.file, site.primitives.join(", ")]));
    const drifted = EGRESS_CATALOGUE.filter(
      (site) => scannedBy.has(site.file) && scannedBy.get(site.file) !== site.primitives.join(", "),
    ).map((site) => `${site.file}: declared [${site.primitives.join(", ")}], found [${scannedBy.get(site.file)}]`);
    expect(drifted, "a catalogue entry's declared primitives no longer match its source").toEqual([]);
  });

  test("no catalogue entry is listed twice", () => {
    const files = EGRESS_CATALOGUE.map((site) => site.file);
    expect(files.length).toBe(new Set(files).size);
  });

  test("every entry carries a destination and a reason", () => {
    for (const site of EGRESS_CATALOGUE) {
      expect(site.destination.length, `${site.file}: no destination`).toBeGreaterThan(0);
      expect(site.why.length, `${site.file}: no reason`).toBeGreaterThan(20);
    }
  });

  test("the two api.github.com callers on no adopter path are marked maintenance", () => {
    // #1984's own acceptance criterion: a reader of the page must not mistake
    // the freshness checks for a runtime dependency.
    for (const file of ["packages/core/src/op/emulator-freshness.ts", "scripts/dogwood-freshness.ts"]) {
      const site = EGRESS_CATALOGUE.find((s) => s.file === file);
      expect(site, `${file} is no longer catalogued`).toBeDefined();
      expect(site!.phase, `${file} must stay classified as maintenance-only`).toBe("maintenance");
    }
  });

  test("the published page matches the catalogue byte for byte", () => {
    for (const relPath of EGRESS_CATALOGUE_DOCS) {
      const doc = readFileSync(join(ROOT, relPath), "utf-8");
      expect(
        extractEgressCatalogueBlock(doc),
        `${relPath} is out of date — run \`npm run generate:egress-catalogue\` and commit the result`,
      ).toBe(renderEgressCatalogueBlock());
    }
  });
});

afterAll(() => {
  const lines = report.map((r) => `  ${r.phase.padEnd(24)} ${String(r.projects).padStart(4)} projects  ${r.violations} egress attempts`);
  console.log(
    [
      "",
      "── no-egress guard (chant #1984) ───────────────────────────────────",
      ...lines,
      `  shell-outs observed:     ${[...new Set(spawns)].sort().join(", ") || "none"}`,
      `  modules cleared to reach the network: ${EGRESS_CATALOGUE.length}`,
      "────────────────────────────────────────────────────────────────────",
    ].join("\n"),
  );
});
