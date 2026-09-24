/**
 * The workspace checks behind per-member pipelines (#2542; #2524 D19,
 * ws-040, ws-041 and ws-042).
 *
 * - `WSP081`: each generated file has exactly one declarer. Two members that
 *   both list `.github/workflows/deploy.yml` would each overwrite the other's
 *   pipeline on every regeneration.
 * - `WSP082`: a member declares generated files only inside its own
 *   directory, with one exception: forge CI files, which forges read from
 *   fixed paths at the repository root ({@link isForgePath}).
 * - `WSP083`: linked members share at least one environment name. Names are
 *   matched exactly, with no mapping (ws-040), so this is a warning: a
 *   member with its own names still builds.
 *
 * The checks are pure functions over {@link MemberPipelineFacts}.
 * {@link gatherPipelineFacts} collects those facts from a checkout, reading
 * each member's generated-file record (../member-pipeline.ts), and
 * `chant workspace check` gathers them before it runs {@link PIPELINE_CHECKS}
 * (#2641).
 */

import { join } from "node:path";
import type { WorkspaceCheck, WorkspaceCheckContext, WorkspaceDiagnostic } from "../checks";
import type { Declaration } from "../declaration";
import { declaredMemberLinks } from "../links";
import { readGeneratedRecord } from "../member-pipeline";

export const WSP_ONE_DECLARER = "WSP081";
export const WSP_GENERATED_PLACEMENT = "WSP082";
export const WSP_LINKED_ENVIRONMENTS = "WSP083";

export interface PipelineFinding {
  id: typeof WSP_ONE_DECLARER | typeof WSP_GENERATED_PLACEMENT | typeof WSP_LINKED_ENVIRONMENTS;
  severity: "error" | "warning";
  /** The members the finding is about, in declaration order. */
  members: string[];
  /** The generated file the finding is about, when there is one. */
  path?: string;
  message: string;
}

/** What the pipeline checks need to know about one member. */
export interface MemberPipelineFacts {
  name: string;
  /** Relative to the repository root, with `/` separators; `"."` is the root. */
  dir: string;
  /** The generated files the member declares, relative to the repository root. */
  generated: string[];
  /** The environment names the member's pipelines deploy. */
  environments: string[];
}

/** A link between two members: `consumer` reads something `producer` exposes (#2524 D6). */
export interface MemberLink {
  consumer: string;
  producer: string;
}

/**
 * Whether `path` (repository-relative) is a forge CI file: a file directly in
 * `.github/workflows/`, `.forgejo/workflows/` or `.gitea/workflows/`, the
 * root `.gitlab-ci.yml`, or a file directly in `.gitlab/ci/`, which the root
 * `.gitlab-ci.yml` includes. The exemption is this narrow on purpose (ws-042).
 */
export function isForgePath(path: string): boolean {
  if (path === ".gitlab-ci.yml") return true;
  return /^(\.github\/workflows|\.forgejo\/workflows|\.gitea\/workflows|\.gitlab\/ci)\/[^/]+$/.test(path);
}

function inside(path: string, dir: string): boolean {
  return dir === "." || path === dir || path.startsWith(`${dir}/`);
}

/** `WSP081`: no two members declare the same generated file. */
export function checkOneDeclarer(facts: readonly MemberPipelineFacts[]): PipelineFinding[] {
  const byPath = new Map<string, string[]>();
  for (const f of facts) {
    for (const path of new Set(f.generated)) byPath.set(path, [...(byPath.get(path) ?? []), f.name]);
  }
  const findings: PipelineFinding[] = [];
  for (const [path, members] of [...byPath].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (members.length < 2) continue;
    findings.push({
      id: WSP_ONE_DECLARER,
      severity: "error",
      members,
      path,
      message:
        `members ${members.join(", ")} all declare ${path} as a generated file; each would overwrite ` +
        `the others' output. Keep it in one member, and give the others their own file ` +
        `(a member's pipeline is named after it by default).`,
    });
  }
  return findings;
}

/** `WSP082`: a member's generated files sit in its own directory, or are forge CI files. */
export function checkGeneratedPlacement(facts: readonly MemberPipelineFacts[]): PipelineFinding[] {
  const findings: PipelineFinding[] = [];
  for (const f of facts) {
    for (const path of f.generated) {
      if (inside(path, f.dir) || isForgePath(path)) continue;
      findings.push({
        id: WSP_GENERATED_PLACEMENT,
        severity: "error",
        members: [f.name],
        path,
        message:
          `member ${f.name} declares ${path}, which is outside its directory (${f.dir}) and is not a forge ` +
          `CI file. Only files in .github/workflows/, .forgejo/workflows/, .gitea/workflows/ or .gitlab/ci/, ` +
          `and .gitlab-ci.yml, may sit outside the member that generates them.`,
      });
    }
  }
  return findings;
}

/** `WSP083`: every link joins members that share an environment name, when both name any. */
export function checkLinkedEnvironments(facts: readonly MemberPipelineFacts[], links: readonly MemberLink[]): PipelineFinding[] {
  const byName = new Map(facts.map((f) => [f.name, f]));
  const order = new Map(facts.map((f, i) => [f.name, i]));
  const seen = new Set<string>();
  const findings: PipelineFinding[] = [];
  for (const link of links) {
    const a = byName.get(link.consumer);
    const b = byName.get(link.producer);
    if (!a || !b || a === b) continue;
    const [first, second] = order.get(a.name)! <= order.get(b.name)! ? [a, b] : [b, a];
    const key = `${first.name}\0${second.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A member that names no environment has nothing to line up yet.
    if (first.environments.length === 0 || second.environments.length === 0) continue;
    const shared = first.environments.filter((e) => second.environments.includes(e));
    if (shared.length > 0) continue;
    const list = (f: MemberPipelineFacts) => [...new Set(f.environments)].sort().join(", ");
    findings.push({
      id: WSP_LINKED_ENVIRONMENTS,
      severity: "warning",
      members: [first.name, second.name],
      message:
        `linked members ${first.name} (${list(first)}) and ${second.name} (${list(second)}) share no ` +
        `environment name. Names are matched exactly, so a view across members, such as ` +
        `chant workspace status <env>, can't line their releases up. Rename one side to match.`,
    });
  }
  return findings;
}

/**
 * Collect the facts from a checkout. `prefix` is the workspace root relative
 * to the repository root (`"."` when they are the same). Each member's
 * generated files and environments come from its generated-file record.
 */
export function gatherPipelineFacts(workspaceRoot: string, declaration: Declaration, prefix = "."): MemberPipelineFacts[] {
  return declaration.members.map((m) => {
    const record = readGeneratedRecord(m.dir === "." ? workspaceRoot : join(workspaceRoot, m.dir));
    const dir = prefix === "." ? m.dir : m.dir === "." ? prefix : `${prefix}/${m.dir}`;
    return {
      name: m.name,
      dir,
      generated: record.files.map((f) => f.path),
      environments: [...new Set(record.files.flatMap((f) => (f.env ? [f.env] : [])))],
    };
  });
}

/**
 * Run the three checks. `links` defaults to none; `chant workspace check`
 * passes the declared member links (#2539).
 */
export function checkPipelines(facts: readonly MemberPipelineFacts[], links: readonly MemberLink[] = []): PipelineFinding[] {
  return [...checkOneDeclarer(facts), ...checkGeneratedPlacement(facts), ...checkLinkedEnvironments(facts, links)];
}

// ── As workspace checks ──────────────────────────────────────────────────────

/**
 * A finding as a workspace diagnostic. It sits at the first member it names,
 * in declaration order, and that member's entry is the one that can carry a
 * `suppress`.
 */
function toDiagnostic(check: WorkspaceCheck, ctx: WorkspaceCheckContext, f: PipelineFinding): WorkspaceDiagnostic {
  const member = ctx.declaration.members.find((m) => m.name === f.members[0]);
  return { checkId: check.id, severity: check.severity, message: f.message, entity: f.members[0], pointer: member?.pointer ?? "" };
}

/** The member links `WSP083` compares: the pairs the declaration links (#2539). */
function declaredLinks(ctx: WorkspaceCheckContext): MemberLink[] {
  return declaredMemberLinks(ctx.declaration);
}

/** The pipeline checks, which read `ctx.facts.pipelines`. They find nothing when the facts were not gathered. */
export const PIPELINE_CHECKS: readonly WorkspaceCheck[] = [
  {
    id: WSP_ONE_DECLARER,
    name: "generated-declared-twice",
    description: "No two members record the same generated file, so no member's regeneration overwrites another's pipeline.",
    severity: "error",
    configurable: true,
    check(ctx) {
      return checkOneDeclarer(ctx.facts?.pipelines ?? []).map((f) => toDiagnostic(this, ctx, f));
    },
  },
  {
    id: WSP_GENERATED_PLACEMENT,
    name: "generated-outside-member",
    description: "A member's recorded generated files sit in its own directory, or are forge CI files at the fixed paths forges read.",
    severity: "error",
    configurable: true,
    check(ctx) {
      return checkGeneratedPlacement(ctx.facts?.pipelines ?? []).map((f) => toDiagnostic(this, ctx, f));
    },
  },
  {
    id: WSP_LINKED_ENVIRONMENTS,
    name: "linked-environments-disjoint",
    description: "Linked members share at least one environment name, matched exactly, when both name any.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      return checkLinkedEnvironments(ctx.facts?.pipelines ?? [], declaredLinks(ctx)).map((f) => toDiagnostic(this, ctx, f));
    },
  },
];
