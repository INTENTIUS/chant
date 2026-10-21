/**
 * chant #4215: the root-examples gate's allowlist and the readers it shares
 * with the unit project. `root-examples-gate.e2e.test.ts` builds and lints
 * each example; `static-gates.test.ts` checks the allowlist and the
 * contributing page against the directory tree on every pull request.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const examplesDir = import.meta.dirname;

// ── The allowlist ────────────────────────────────────────────────────

export interface AllowEntry {
  /**
   * "no-config" — a directory under `examples/` with no `chant.config.*`,
   * so there is no chant project to build or lint. Not enumerated by the
   * gate; the agreement tests at the bottom of this file assert the config
   * is still absent, so the entry cannot outlive the reason for it.
   *
   * "expected-failure" — an enumerated example whose own scripts run and are
   * expected to fail. The test fails if they pass, which is what empties
   * this list as #2248's sub-issues land.
   *
   * chant #2347 — most of those are backlog, but not all of them are. A
   * differential fixture whose whole subject is a build that fails belongs
   * here permanently, and the entry says which kind it is. The gate treats
   * both identically, and that is the point: pinning a deliberate failure and
   * pinning a backlogged one are the same assertion, and either one silently
   * starting to pass is the same bug.
   */
  kind: "no-config" | "expected-failure";
  reason: string;
}

export const ALLOWLIST: Record<string, AllowEntry> = {
  // ── No chant project in the directory ──
  "terraform-carve-out": {
    kind: "no-config",
    reason:
      "A Terraform estate and a `demo.sh` that carves a resource out of it. There is no chant " +
      "project to build; `chant carve` reads the estate that `demo.sh` stands up.",
  },

  // ── Runs, and is expected to fail ──
  "fold-adversarial": {
    kind: "expected-failure",
    reason:
      "chant #2347 — a fold/run differential fixture, not a shipped example, and the one entry " +
      "on this list whose failure is permanent by design rather than a burn-down item. Its " +
      "`src/nullish-property-read.ts` reads a property off an object that resolves to " +
      "`undefined`: `fold()` refuses it (#2328), the file falls back to run, and running it " +
      "throws the TypeError the refusal predicted. That IS the fixture — the differential's " +
      "claim is that both paths report the same failure — so `chant build .` reports one " +
      "DiscoveryError and exits non-zero, for ever. If it ever stops failing, the fixture has " +
      "stopped testing anything and this gate says so.",
  },

  "supply-chain": {
    kind: "expected-failure",
    reason:
      "Component-only project (#630): one `*.component.ts` and no lexicon resources, so " +
      "`chant build .` reports discovering source and producing no output. There is nothing to " +
      "synthesize — `chant run --components` is the entry point.",
  },
};

// ── Enumeration ──────────────────────────────────────────────────────

/** Every directory under `examples/`, config or not. */
export function exampleDirectories(): string[] {
  return readdirSync(examplesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Those of them that are chant projects — the set this gate builds and lints. */
export function chantProjects(): string[] {
  return exampleDirectories().filter((name) =>
    readdirSync(join(examplesDir, name)).some((f) => f.startsWith("chant.config.")),
  );
}


// ── The contributing page and the directory tree agree ───────────────

export const CONTRIBUTING_PAGE = resolve(
  examplesDir,
  "../docs/src/content/docs/contributing/examples.mdx",
);

export function namesOnPage(): string[] {
  const page = readFileSync(CONTRIBUTING_PAGE, "utf8");
  return [...page.matchAll(/`examples\/([a-z0-9-]+)`/g)].map((m) => m[1]);
}
