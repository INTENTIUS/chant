/**
 * `chant index diff <a> [<b>] [--store <spec>] [--json]` (#4533): what
 * changed between two versions of one index scope.
 *
 * `<a>` is `<scopeKey>/<version>`, or `<scopeKey>` alone. `<b>` is
 * `<scopeKey>/<version>`, or a version name in `<a>`'s scope. With no `<b>`,
 * the version before `<a>` is diffed against `<a>`, and a scope alone diffs
 * its last two versions.
 *
 * Versions are read through #4519's store API, from the store `chant index`
 * writes to (#4532's {@link planIndexStore}: `--store <spec>`, else the
 * project's store, else the per-user one), so a git-ref, local or s3 store
 * diffs the same way. Nothing is built, no lexicon is loaded and no cloud is
 * queried. The computation is ../../lifecycle/index-diff.ts.
 */
import { homedir } from "node:os";
import { chantUserStoreDir, IndexUsageError, planIndexStore, type StorePlan } from "../../lifecycle/cloud-index";
import { diffIndexVersionRefs, IndexScopeMismatch, NotAnIndexVersion, parseIndexVersionRef, type IndexDiff } from "../../lifecycle/index-diff";
import { createSnapshotStore, resolveSnapshotStore, snapshotStoreConfig, type SnapshotStore } from "../../lifecycle/snapshot-store";

export const INDEX_DIFF_USAGE = `chant index diff <a> [<b>] [--store <spec>] [--json]

What changed between two versions of one index scope: nodes added and
removed, properties changed, edges added and removed. A node is removed only
where the later read listed its type and location; elsewhere it is not
observed. Two versions of different scopes are refused.

  <a>              <scopeKey>/<version>, or <scopeKey> for its latest version
  <b>              <scopeKey>/<version>, or a version name in <a>'s scope.
                   Absent: the version before <a> against <a> (a scope alone:
                   its last two versions)
  --store <spec>   the store to read, as chant index takes it (local,
                   local:<dir>, git-ref, git-ref:<ref>, s3,
                   s3://<bucket>[/<prefix>]). Default: the project's store,
                   else chant's per-user store
  --json           the diff as JSON
`;

export interface IndexDiffRunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Open the planned store; tests pass a fake. */
  openStore?: (plan: StorePlan, cwd: string) => Promise<Pick<SnapshotStore, "kind" | "listIndex" | "readIndexAt" | "fetch">>;
}

async function openReadStore(plan: StorePlan, cwd: string): Promise<SnapshotStore> {
  switch (plan.kind) {
    case "user":
      return createSnapshotStore({ store: "local", dir: plan.dir }, { cwd });
    case "project":
      return resolveSnapshotStore({ cwd: plan.projectDir });
    case "spec":
      return createSnapshotStore(snapshotStoreConfig(plan.configured, plan.env), { cwd, env: plan.env });
  }
}

const show = (v: unknown) => (v === undefined ? "(absent)" : JSON.stringify(v));

/** The diff as text, one line per change. */
export function renderIndexDiff(d: IndexDiff): string {
  const lines: string[] = [];
  lines.push(`Index diff: ${d.scopeKey}`);
  lines.push(`  from ${d.from.version ?? d.from.digest.slice(0, 12)} (observed ${d.from.observedAt})`);
  lines.push(`  to   ${d.to.version ?? d.to.digest.slice(0, 12)} (observed ${d.to.observedAt})`);
  if (d.unchanged) {
    lines.push("", "Same digest: nothing changed.");
    return `${lines.join("\n")}\n`;
  }
  const c = d.counts;
  lines.push(
    "",
    `${c.added} added, ${c.removed} removed, ${c.changed} changed (${c.properties} properties), ${c.notObserved} not observed; edges ${c.edgesAdded} added, ${c.edgesRemoved} removed, ${c.edgesNotObserved} not observed`,
  );
  for (const n of d.nodes.added) lines.push(`  + ${n.key}`);
  for (const n of d.nodes.removed) lines.push(`  - ${n.key}`);
  for (const n of d.nodes.changed) {
    lines.push(`  ~ ${n.key}`);
    for (const p of n.properties) lines.push(`      ${p.path}: ${show(p.before)} -> ${show(p.after)}`);
  }
  for (const n of d.nodes.notObserved) lines.push(`  ? ${n.key} (not observed in the ${n.side} read: ${n.verdict}${n.detail ? `, ${n.detail}` : ""})`);
  for (const e of d.edges.added) lines.push(`  + edge ${e.from} -> ${e.to}${e.viaAttr ? ` via ${e.viaAttr}` : ""}`);
  for (const e of d.edges.removed) lines.push(`  - edge ${e.from} -> ${e.to}${e.viaAttr ? ` via ${e.viaAttr}` : ""}`);
  for (const e of d.edges.notObserved) lines.push(`  ? edge ${e.from} -> ${e.to} (${e.unobservedEnd} not observed in the ${e.side} read: ${e.verdict})`);
  for (const v of d.coverage) lines.push(`  coverage ${v.listedType} @ ${v.location}: ${v.before ?? "(none)"} -> ${v.after ?? "(none)"}`);
  return `${lines.join("\n")}\n`;
}

/** `chant index diff`'s argv (the words after `diff`). Exit 0 on a diff, 1 on a refusal, 2 on a usage error. */
export async function runIndexDiff(argv: readonly string[], o: IndexDiffRunOptions = {}): Promise<number> {
  const out = o.stdout ?? ((s: string) => void process.stdout.write(s));
  const err = o.stderr ?? ((s: string) => void process.stderr.write(s));
  const cwd = o.cwd ?? process.cwd();
  const env = o.env ?? process.env;
  if (argv.includes("-h") || argv.includes("--help")) {
    out(INDEX_DIFF_USAGE);
    return 0;
  }
  const refs: string[] = [];
  let store: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--store") {
      store = argv[++i];
      if (!store || store.startsWith("-")) {
        err(`chant index diff: --store needs a store spec\n\n${INDEX_DIFF_USAGE}`);
        return 2;
      }
    } else if (a.startsWith("--store=")) store = a.slice("--store=".length);
    else if (a.startsWith("-")) {
      err(`chant index diff: unknown flag ${a}\n\n${INDEX_DIFF_USAGE}`);
      return 2;
    } else refs.push(a);
  }
  if (refs.length < 1 || refs.length > 2) {
    err(`chant index diff: name one or two index versions\n\n${INDEX_DIFF_USAGE}`);
    return 2;
  }

  let d: IndexDiff;
  try {
    const from = parseIndexVersionRef(refs[0]!);
    const to = refs[1] ? parseIndexVersionRef(refs[1], from.scopeKey) : undefined;
    const plan = planIndexStore({ store, cwd, env, defaultStoreDir: () => chantUserStoreDir(env, o.home ?? homedir()), command: "chant index diff" });
    const s = await (o.openStore ?? openReadStore)(plan, cwd);
    await s.fetch();
    d = await diffIndexVersionRefs(s, from, to);
  } catch (e) {
    if (e instanceof IndexUsageError) {
      err(`${e.message}\n`);
      return 2;
    }
    if (e instanceof IndexScopeMismatch || e instanceof NotAnIndexVersion) {
      if (json) out(`${JSON.stringify({ error: e.code, message: e.message, ...(e instanceof IndexScopeMismatch ? { fromScopeKey: e.fromScopeKey, toScopeKey: e.toScopeKey } : {}) }, null, 2)}\n`);
      err(`chant index diff: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  out(json ? `${JSON.stringify(d, null, 2)}\n` : renderIndexDiff(d));
  return 0;
}
