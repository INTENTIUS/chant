/**
 * "Every shipped root example builds and lints" (chant #2249, epic #2248).
 *
 * `chant dev check-lexicon` has run every lexicon example through a real
 * build and its own post-synth checks since #1067/#1400. Nothing did the
 * same for `examples/`: `examples.test.ts` asserts README claims for the
 * examples it names, `readme-counts.test.ts` asserts resource counts, and
 * both build only the src/ directories they were written against. A survey
 * on 2026-09-08 found eight of the 35 root examples failing `chant build`
 * or `chant lint`, some since July, with nothing red.
 *
 * This file closes that. Every directory under `examples/` holding a
 * `chant.config.*` gets one test that runs the example's own
 * `package.json` `build` and `lint` scripts, in-process through
 * `cli/commands/build.ts` and `cli/commands/lint.ts` rather than as a
 * subprocess, and fails with the command's own output. The scripts are the
 * contract: some lint `src`, some `ops`, some several directories, and an
 * example with no script of its own gets its project root.
 *
 * That scoping is deliberate, and it is narrower than the survey's. Four of
 * the eight examples #2248 lists (k8s-eks-microservice, github-pr-preview,
 * fly-deploy-rollback, gitlab-cells-single-region-gke) fail `chant lint` run
 * at the project root but pass the command their own `lint` script runs:
 * the script names `src`, and the errors sit in `ops/`, in `k3d/`, or under
 * rules a `src/chant.config.json` turns off. This gate holds an example to
 * what it claims to check. Widening the claim is each sub-issue's job, and
 * the gate covers the wider claim the moment the script does.
 *
 * {@link ALLOWLIST} carries the exceptions, one reason each. An entry is
 * either "no-config" (a directory under `examples/` that is not a chant
 * project at all) or "expected-failure" (it runs, and is expected to fail,
 * naming the sub-issue that fixes it). Either way the entry is checked: an
 * expected-failure whose example now passes fails this suite, a no-config
 * directory that grows a config fails it, and a directory with neither a
 * config nor an entry fails it. #2248's burn-down empties the list rather
 * than leaving it to rot.
 */

import { describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildCommand, resolveBuildFormat } from "@intentius/chant/cli/commands/build";
import { lintCommand } from "@intentius/chant/cli/commands/lint";
import { loadPlugins, resolveProjectLexicons } from "@intentius/chant/cli";

const examplesDir = import.meta.dirname;

// ── The allowlist ────────────────────────────────────────────────────

interface AllowEntry {
  /**
   * "no-config" — a directory under `examples/` with no `chant.config.*`,
   * so there is no chant project to build or lint. Not enumerated by the
   * gate; the agreement tests at the bottom of this file assert the config
   * is still absent, so the entry cannot outlive the reason for it.
   *
   * "expected-failure" — an enumerated example whose own scripts run and are
   * expected to fail. The test fails if they pass, which is what empties
   * this list as #2248's sub-issues land.
   */
  kind: "no-config" | "expected-failure";
  reason: string;
}

const ALLOWLIST: Record<string, AllowEntry> = {
  // ── No chant project in the directory ──
  "terraform-carve-out": {
    kind: "no-config",
    reason:
      "A Terraform estate and a `demo.sh` that carves a resource out of it. There is no chant " +
      "project to build; `chant carve` reads the estate that `demo.sh` stands up.",
  },

  // ── Runs, and is expected to fail ──
  "supply-chain": {
    kind: "expected-failure",
    reason:
      "Component-only project (#630): one `*.component.ts` and no lexicon resources, so " +
      "`chant build .` reports discovering source and producing no output. There is nothing to " +
      "synthesize — `chant run --components` is the entry point.",
  },
};

// ── Reading an example's own scripts ─────────────────────────────────

interface ChantInvocation {
  verb: "build" | "lint";
  /** Path argument, relative to the example directory. */
  path: string;
  lexicon?: string;
  output?: string;
  format?: string;
  fix?: boolean;
  env?: string;
}

/** Split a shell script on `&&`, the only operator these scripts use. */
function segments(script: string): string[] {
  return script
    .split("&&")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Flatten a package.json script into the `chant build`/`chant lint`
 * invocations it performs, following `npm run <name>` indirection.
 *
 * Anything else in a script is thrown on rather than ignored: a step this
 * gate cannot reproduce is a step it would silently stop covering.
 */
function invocations(
  scripts: Record<string, string>,
  scriptName: string,
  seen: Set<string> = new Set(),
): ChantInvocation[] {
  if (seen.has(scriptName)) throw new Error(`script "${scriptName}" calls itself`);
  seen.add(scriptName);

  const script = scripts[scriptName];
  if (script === undefined) return [];

  const out: ChantInvocation[] = [];
  for (const segment of segments(script)) {
    const tokens = segment.split(/\s+/);
    if ((tokens[0] === "npm" || tokens[0] === "bun") && tokens[1] === "run") {
      // A fresh copy per branch: two sibling steps may legitimately call the
      // same script; only a script reaching itself is a cycle.
      out.push(...invocations(scripts, tokens[2], new Set(seen)));
      continue;
    }
    if (tokens[0] !== "chant" || (tokens[1] !== "build" && tokens[1] !== "lint")) {
      throw new Error(
        `unsupported step in "${scriptName}": ${segment}\n` +
          `The root-examples gate reproduces "chant build" and "chant lint" only. ` +
          `Move the step to a script this one does not call, or teach this file about it.`,
      );
    }

    const invocation: ChantInvocation = { verb: tokens[1], path: "." };
    let sawPath = false;
    for (let i = 2; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === "--lexicon") invocation.lexicon = tokens[(i += 1)];
      else if (token === "-o" || token === "--output") invocation.output = tokens[(i += 1)];
      else if (token === "--format") invocation.format = tokens[(i += 1)];
      else if (token === "--env") invocation.env = tokens[(i += 1)];
      else if (token === "--fix") invocation.fix = true;
      else if (token.startsWith("-")) {
        throw new Error(`unsupported flag in "${scriptName}": ${token}`);
      } else if (!sawPath) {
        invocation.path = token;
        sawPath = true;
      } else {
        throw new Error(`unexpected second path argument in "${scriptName}": ${token}`);
      }
    }
    out.push(invocation);
  }
  return out;
}

/**
 * What this gate runs for one example: its `build` and `lint` scripts when
 * it has them, and the project root otherwise — "chant build ." /
 * "chant lint ." is what a reader who copied the directory would type.
 */
function plan(exampleDir: string): ChantInvocation[] {
  let scripts: Record<string, string> = {};
  const pkgPath = join(exampleDir, "package.json");
  if (existsSync(pkgPath)) {
    scripts = (JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {}) as Record<string, string>;
  }

  const build = scripts.build ? invocations(scripts, "build") : [{ verb: "build" as const, path: "." }];
  const lint = scripts.lint ? invocations(scripts, "lint") : [{ verb: "lint" as const, path: "." }];
  return [...build, ...lint];
}

// ── Running one invocation ───────────────────────────────────────────

interface RunOutcome {
  ok: boolean;
  /** The failing command line and its output, for the assertion message. */
  detail: string;
}

function commandLine(invocation: ChantInvocation): string {
  const parts = ["chant", invocation.verb, invocation.path];
  if (invocation.lexicon) parts.push("--lexicon", invocation.lexicon);
  if (invocation.output) parts.push("-o", invocation.output);
  if (invocation.format) parts.push("--format", invocation.format);
  if (invocation.env) parts.push("--env", invocation.env);
  if (invocation.fix) parts.push("--fix");
  return parts.join(" ");
}

async function runBuild(
  exampleDir: string,
  invocation: ChantInvocation,
  outDir: string,
): Promise<RunOutcome> {
  const path = resolve(exampleDir, invocation.path);
  // Resolved from the build path, not the project root: that is what
  // `loadPluginsOrExit(args.path)` does in `cli/main.ts`, and a stack
  // directory can carry its own `chant.config.*`.
  const plugins = await loadPlugins(await resolveProjectLexicons(path));
  let serializers = plugins.map((p) => p.serializer);
  if (invocation.lexicon) {
    serializers = serializers.filter((s) => s.name === invocation.lexicon);
    if (serializers.length === 0) {
      return {
        ok: false,
        detail: `no serializer for lexicon "${invocation.lexicon}" (loaded: ${plugins.map((p) => p.serializer.name).join(", ") || "none"})`,
      };
    }
  }

  const { format } = resolveBuildFormat(invocation.format, invocation.output);
  // The output is redirected under a temp directory, keeping the script's
  // own relative shape so extension-inferred format and any sidecar files
  // land exactly as they would. Only the destination moves: a gate must not
  // rewrite committed files in the tree it is checking.
  const output = invocation.output ? join(outDir, invocation.output) : undefined;

  const result = await buildCommand({
    path,
    output,
    format,
    serializers,
    plugins,
    env: invocation.env,
  });

  return {
    ok: result.success,
    detail: [...result.errors, ...result.warnings].join("\n"),
  };
}

async function runLint(exampleDir: string, invocation: ChantInvocation): Promise<RunOutcome> {
  const result = await lintCommand({
    path: resolve(exampleDir, invocation.path),
    format: "stylish",
    fix: invocation.fix ?? false,
  });
  return { ok: result.success, detail: result.output };
}

/** Run an example's whole plan, stopping at the first failing step as `&&` does. */
async function runExample(name: string): Promise<RunOutcome> {
  const exampleDir = join(examplesDir, name);
  const outDir = mkdtempSync(join(tmpdir(), `chant-gate-${name}-`));
  try {
    for (const invocation of plan(exampleDir)) {
      let outcome: RunOutcome;
      try {
        outcome =
          invocation.verb === "build"
            ? await runBuild(exampleDir, invocation, outDir)
            : await runLint(exampleDir, invocation);
      } catch (err) {
        outcome = { ok: false, detail: err instanceof Error ? (err.stack ?? err.message) : String(err) };
      }
      if (!outcome.ok) {
        return {
          ok: false,
          detail: `$ ${commandLine(invocation)}   (cwd examples/${name})\n${outcome.detail}`,
        };
      }
    }
    return { ok: true, detail: "" };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// ── Enumeration ──────────────────────────────────────────────────────

/** Every directory under `examples/`, config or not. */
function exampleDirectories(): string[] {
  return readdirSync(examplesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Those of them that are chant projects — the set this gate builds and lints. */
function chantProjects(): string[] {
  return exampleDirectories().filter((name) =>
    readdirSync(join(examplesDir, name)).some((f) => f.startsWith("chant.config.")),
  );
}

// ── The gate ─────────────────────────────────────────────────────────

describe("every root example builds and lints", () => {
  for (const name of chantProjects()) {
    const allowed = ALLOWLIST[name];

    test(name, async () => {
      const outcome = await runExample(name);
      if (allowed?.kind === "expected-failure") {
        expect(
          outcome.ok,
          `examples/${name} is on the root-examples gate allowlist ("${allowed.reason}") but now ` +
            `passes. Delete its ALLOWLIST entry in examples/root-examples-gate.test.ts.`,
        ).toBe(false);
        return;
      }
      expect(outcome.ok, `examples/${name} failed:\n${outcome.detail}`).toBe(true);
    });
  }
});

// ── The allowlist and the directory tree agree ───────────────────────

describe("the root-examples allowlist", () => {
  test("names only directories that are there", () => {
    const onDisk = new Set(exampleDirectories());
    const orphans = Object.keys(ALLOWLIST).filter((name) => !onDisk.has(name));
    expect(orphans, `allowlist entries with no directory: ${orphans.join(", ")}`).toEqual([]);
  });

  test("accounts for every directory the gate does not enumerate", () => {
    const enumerated = new Set(chantProjects());
    const unaccounted = exampleDirectories().filter(
      (name) => !enumerated.has(name) && ALLOWLIST[name]?.kind !== "no-config",
    );
    expect(
      unaccounted,
      `directories under examples/ with no chant.config and no allowlist entry: ${unaccounted.join(", ")}`,
    ).toEqual([]);
  });

  test('carries no "no-config" entry for a directory that has one', () => {
    const enumerated = new Set(chantProjects());
    const stale = Object.entries(ALLOWLIST)
      .filter(([name, entry]) => entry.kind === "no-config" && enumerated.has(name))
      .map(([name]) => name);
    expect(
      stale,
      `these now hold a chant.config and are built by the gate; delete their ALLOWLIST entries: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});

// ── The contributing page and the directory tree agree ───────────────

const CONTRIBUTING_PAGE = resolve(
  examplesDir,
  "../docs/src/content/docs/contributing/examples.mdx",
);

function namesOnPage(): string[] {
  const page = readFileSync(CONTRIBUTING_PAGE, "utf8");
  return [...page.matchAll(/`examples\/([a-z0-9-]+)`/g)].map((m) => m[1]);
}

describe("docs/src/content/docs/contributing/examples.mdx", () => {
  test("names every example this gate enumerates", () => {
    const listed = new Set(namesOnPage());
    const missing = chantProjects().filter((name) => !listed.has(name));
    expect(
      missing,
      `not listed on contributing/examples.mdx: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("names nothing that is not on disk", () => {
    const onDisk = new Set(exampleDirectories());
    const stale = [...new Set(namesOnPage())].filter((name) => !onDisk.has(name));
    expect(stale, `listed on contributing/examples.mdx but gone: ${stale.join(", ")}`).toEqual([]);
  });
});
