import { cpus, totalmem } from "node:os";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Per-fork heap ceiling, derived from the host rather than hardcoded so the
 * same value suits a 4-core CI runner and an 18-core workstation.
 *
 * Vitest gives every fork its own V8 heap with no ceiling by default. On
 * 2026-07-25 a runaway run put fourteen forks at ~4.6GB each (~66GB on a 64GB
 * machine); the kernel's OOM killer took out ~300 system daemons and the
 * desktop session with them. A ceiling turns that into a failed test — the
 * fork dies with a heap error naming the suite — instead of a dead machine.
 *
 * Budget half of physical memory across the widest the pool can open, so even
 * a fully saturated run commits at most ~50% of RAM. The 1.5GB floor keeps
 * headroom over the suite's real high-water mark (~1.3GB in the heaviest
 * lexicon workers, which load the 15MB azure and 11MB aws generated barrels);
 * raise it if a legitimate test starts hitting the ceiling.
 *
 * Scope: this bounds the V8 heap only. Buffers and ArrayBuffers are external
 * and still allocate freely, so this is a guard against runaway object graphs
 * (AST walks, module graphs, accumulating fixtures), not a total memory cap.
 */
const forkHeapMb = Math.max(
  1536,
  Math.min(4096, Math.floor(((totalmem() / 1024 / 1024) * 0.5) / Math.max(cpus().length, 1))),
);

/**
 * Vitest is on the 4.x line for chant #1693. Vitest 3.x gave the worker side
 * of the worker<->host RPC birpc's hardcoded 60s call timeout, so when a
 * saturated CI runner was slow to drain "onTaskUpdate" during teardown the
 * worker threw `[vitest-worker]: Timeout calling "onTaskUpdate"` after every
 * test had passed and the job went red. vitest-dev/vitest#8297 (shipped in
 * 4.0.0-beta.4) sets that timeout to -1; there is no 3.x option to raise it.
 */
export default defineConfig({
  plugins: [tsconfigPaths({ ignoreConfigErrors: true })],
  test: {
    // Note: the top-level examples/ tree is not globbed wholesale — its
    // fargate docker e2e/volume suites need Docker and are not CI unit tests.
    // The shared example harness file is included explicitly.
    include: [
      "packages/**/*.test.ts",
      "lexicons/**/*.test.ts",
      "examples/examples.test.ts",
      // Repo tooling in scripts/ was covered by nothing until #1688's dogwood
      // freshness check arrived with pure comparison logic worth testing. A
      // test here must be hermetic like any other in this suite — the network
      // layer it covers is injectable for exactly that reason.
      "scripts/**/*.test.ts",
      // The alert-triage app ships colocated unit tests for its triage
      // activities. (examples/ is not globbed wholesale — fargate's docker
      // e2e/volume suites need Docker and aren't CI unit tests.)
      "examples/alert-triage/**/*.test.ts",
      // chant #1025 — the fold-vs-run differential corpus. Walks examples/
      // and lexicons/*/examples/ itself (no Docker), so it's included
      // explicitly the same way examples.test.ts is.
      "test/no-consumer-apps.test.ts",
      "examples/fold-differential.test.ts",
      // chant #1045 Phase 1 — the JSON entity-boundary differential. Same
      // corpus-walking shape as fold-differential.test.ts above (no Docker).
      "examples/json-boundary-differential.test.ts",
      // chant #1045 Phase 2 — the sandboxed-run-vs-in-process-run
      // differential. Same corpus-walking shape as the two above (no Docker;
      // spawns real, short-lived child processes of its own instead).
      "examples/sandbox-differential.test.ts",
      // chant #1093 — the sandbox execution-boundary gate: over the same
      // corpus, nothing from a project's own source directory may be imported
      // into the CLI's process during a `{ fold: true, sandbox: true }` build.
      "examples/sandbox-execution-boundary.test.ts",
      // chant #1074 — the k8s API client boundary gate: nothing on the build
      // path may statically import (or, when built for real, load) the
      // optional Kubernetes client package. Same corpus-walking shape as the
      // differentials above (no Docker, no cluster).
      "examples/k8s-client-boundary.test.ts",
    ],
    environment: "node",
    // Vitest 4 moved the per-worker node flags from poolOptions.forks.execArgv
    // to this top-level key; the default pool is still forks.
    execArgv: [`--max-old-space-size=${forkHeapMb}`],
    // The Temporal runtime/compile-smoke suites bundle workflows with webpack
    // in-process, which loads the CI runner enough to push short-timeout tests
    // (e.g. build.test.ts discovery) past the 5s default under contention.
    // 20s absorbs that without masking a genuinely hung test for long.
    testTimeout: 20_000,
  },
});
