/**
 * `chant kube` — the terminal surface over the typed client (chant #1079),
 * mounted through the command-group seam #1078 built and reserved this exact
 * namespace for (`lexicons/k8s/src/plugin.ts`'s `commands()`).
 *
 * Every verb below except `version` dynamically imports its own module. That
 * is not a style choice: `describe-resources.ts`, `api/connect.ts` and the
 * rest of the read/write paths sit behind a dynamic import specifically so
 * `chant build` never has to resolve `@intentius/chant-k8s-client`
 * (chant #1074, `examples/k8s-client-boundary.test.ts`). This module IS
 * statically reachable from `plugin.ts` — it is plain data, a list of verb
 * names and descriptions — so every verb whose implementation touches the
 * client must be reached from here only through `await import(...)`, exactly
 * like `version`'s existing `await import("../spec/fetch")`.
 */

import type { CommandGroup, CommandGroupContext } from "@intentius/chant/cli/command-group";
import { splitJoinedFlags, unknownFlagError } from "@intentius/chant/cli/command-group";

async function versionHandler(ctx: CommandGroupContext): Promise<number> {
  const args = splitJoinedFlags(ctx.rawArgs);
  let format: "text" | "json" = "text";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--format" || a === "-f") {
      format = args[++i] === "json" ? "json" : "text";
    } else if (a.startsWith("-")) {
      throw unknownFlagError(a, `"chant kube version" only accepts --format <text|json>.`);
    }
  }
  const { K8S_SCHEMA_VERSION } = await import("../spec/fetch");
  if (format === "json") {
    console.log(JSON.stringify({ schemaVersion: K8S_SCHEMA_VERSION }));
  } else {
    console.log(K8S_SCHEMA_VERSION);
  }
  return 0;
}

/** The full `chant kube` verb group. */
export function kubeCommandGroup(): CommandGroup {
  return {
    name: "kube",
    description: "Terminal surface over the k8s typed client — kubectl-compatible reads plus chant's own verdict, source, and gated writes",
    commands: [
      {
        name: "version",
        description: "Print the pinned Kubernetes API schema version this lexicon was generated from",
        handler: versionHandler,
      },
      {
        name: "get",
        description: "List or read live resources — kubectl's own flags, plus a declared/owned/drifted/foreign-owned column",
        async handler(ctx: CommandGroupContext): Promise<number> {
          const { runGet } = await import("./get");
          return runGet(ctx.rawArgs);
        },
      },
      {
        name: "describe",
        description: "Human-readable detail for one or more resources, including chant's provenance and the object's Events",
        async handler(ctx: CommandGroupContext): Promise<number> {
          const { runDescribe } = await import("./describe");
          return runDescribe(ctx.rawArgs);
        },
      },
      {
        name: "logs",
        description: "A Pod's log (snapshot only — no --follow)",
        async handler(ctx: CommandGroupContext): Promise<number> {
          const { runLogs } = await import("./logs");
          return runLogs(ctx.rawArgs);
        },
      },
      {
        name: "events",
        description: "List Events, oldest first, optionally filtered with --for=Kind/name",
        async handler(ctx: CommandGroupContext): Promise<number> {
          const { runEvents } = await import("./events");
          return runEvents(ctx.rawArgs);
        },
      },
      {
        name: "top",
        description: "Pod/node resource usage from metrics.k8s.io, when the cluster runs metrics-server",
        async handler(ctx: CommandGroupContext): Promise<number> {
          const { runTop } = await import("./top");
          return runTop(ctx.rawArgs);
        },
      },
      {
        name: "wait",
        description: "Block until a resource's readiness spec is met (registry-driven — the same one op/activities/wait-for-ready.ts uses)",
        async handler(ctx: CommandGroupContext): Promise<number> {
          const { runWait } = await import("./wait");
          return runWait(ctx.rawArgs);
        },
      },
      {
        name: "source",
        description: "Resolve a live object back to the .ts file and composite that declared it",
        async handler(ctx: CommandGroupContext): Promise<number> {
          const { runSource } = await import("./source");
          return runSource(ctx.rawArgs);
        },
      },
      {
        name: "apply",
        description: "Server-side apply a manifest (dry-run preview by default — pass --yes to persist); same machinery the Op activity uses",
        async handler(ctx: CommandGroupContext): Promise<number> {
          const { runApply } = await import("./apply");
          return runApply(ctx.rawArgs);
        },
      },
      {
        name: "delete",
        description: "Delete one named resource (never a bare kind sweep; preview by default — pass --yes to delete)",
        async handler(ctx: CommandGroupContext): Promise<number> {
          const { runDelete } = await import("./delete");
          return runDelete(ctx.rawArgs);
        },
      },
    ],
  };
}
