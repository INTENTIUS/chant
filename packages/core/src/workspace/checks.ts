/**
 * Declaration checks (#2535; #2524 D16, ws-028).
 *
 * A {@link WorkspaceCheck} looks at the declaration, the tree it describes
 * and the kinds the workspace can read, and returns findings in the
 * post-synth diagnostic shape with a `WSP` id. `chant workspace check` runs
 * them and prints the findings through lint's reporters, so `--format json`
 * and `--format sarif` come for free. `chant lint` never loads this module.
 *
 * The declaration sets the severity of a check through `checks`, and
 * suppresses a check for one entry through that entry's `suppress`. Some
 * checks are fixed: an unknown kind, a tie between probes and a probe that
 * claims an `other` directory always fail (#2524 D3), and a declaration that
 * can't be read has no settings to apply.
 *
 * Checks that need more than the declaration and the tree read facts
 * gathered before any check runs ({@link WorkspaceFacts}): member ledgers
 * (./checks/ledgers.ts), recorded pipelines (./checks/pipelines.ts) and
 * generated files (./checks/generated.ts). All of them share one id range
 * (#2641):
 *
 * | Ids | Checks |
 * |---|---|
 * | WSP001 to WSP011 | the declaration and member kinds (this file) |
 * | WSP071, WSP072 | member ledgers |
 * | WSP081 to WSP083 | recorded pipelines |
 * | WSP091 to WSP097 | member links (#2539) |
 * | WSP101 to WSP106 | generated files |
 * | WSP111 to WSP114 | records read with `--kind` (#2549) |
 * | WSP115 | the record kinds the declaration names (#2680) |
 * | WSP116 | the decision points file of each declared answer kind (ws-058) |
 * | WSP117 | a done work item's acceptance criteria all met (#2772) |
 * | WSP121, WSP122 | boxes: no literal credential, every capability brokered (#2726) |
 * | WSP123, WSP124 | box isolation: no shared port, state path or cookie, no literal machine path (#2727) |
 * | WSP125 | boxes: a fountain Box declares the callback token fountain gives its sandbox (#2780) |
 * | WSP126, WSP127 | box intent: the decision record a box names exists, and constrains a member or path of this workspace (#2850, #2857) |
 * | WSP131 to WSP133 | diagram artifacts: source and render exist, a recorded source hash still matches (#2764) |
 */

import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import type { LintDiagnostic, LintRule, Severity } from "../lint/rule";
import type { PostSynthDiagnostic } from "../lint/post-synth";
import { readDeclaration, resolveGroups, WorkspaceReadError, type Declaration, type Entry, type ErrorLocation, type ResolvedGroup } from "./declaration";
import type { ReasonCode } from "./reason-codes";
import { parseJsonText, pointerToken, type TextLocation } from "./jsonc";
import { loadKindRegistry, probeKind, resolveKind, type KindLoadProblem, type KindRegistry } from "./kinds";
import { gitTop, workingTree, type WorkspaceTree } from "./tree";
import { LINK_CHECKS, linkTable } from "./checks/links";
import type { LinkTableRow } from "./links";
import { gatherGeneratedFacts, GENERATED_CHECKS, type GeneratedFileFacts } from "./checks/generated";
import { gatherLedgerFacts, LEDGER_CHECKS, type MemberLedgerFacts } from "./checks/ledgers";
import { gatherPipelineFacts, PIPELINE_CHECKS, type MemberPipelineFacts } from "./checks/pipelines";
import { RECORD_CHECKS, type RecordFacts } from "./checks/records";
import { BOX_CHECKS } from "./checks/boxes";
import { DIAGRAM_CHECKS } from "./checks/diagrams";
import { loadDeclaredKinds, type DeclaredKind } from "./declared-kinds";
import { resolveBoxIntents, type ResolvedBoxIntent } from "./box-intent";

/**
 * What the checks beyond the declaration read, gathered from the checkout
 * before any check runs. A field left out was not gathered, and the checks
 * that read it find nothing.
 */
export interface WorkspaceFacts {
  /** Each `chant` member's ownership stack, environments and chant version. */
  ledgers?: readonly MemberLedgerFacts[];
  /** Each member's recorded generated files and the environments they deploy. */
  pipelines?: readonly MemberPipelineFacts[];
  /** Each declared or implicit generated file, with what its generator produced. */
  generated?: readonly GeneratedFileFacts[];
  /** The records of the kind named with `--kind`, with their pins checked (#2549). */
  records?: RecordFacts;
  /** The record kinds the declaration names, each loaded, or only looked for under `--at` (#2680). */
  declaredKinds?: readonly DeclaredKind[];
  /** The decision record each box's intent names, read from the working tree (#2850). */
  boxIntents?: readonly ResolvedBoxIntent[];
}

/** What every declaration check reads. */
export interface WorkspaceCheckContext {
  declaration: Declaration;
  tree: WorkspaceTree;
  groups: ResolvedGroup[];
  kinds: KindRegistry;
  /** Why some pinned kinds could not be read. */
  kindProblems: KindLoadProblem[];
  /** The facts gathered before the checks ran. */
  facts?: WorkspaceFacts;
}

/**
 * A finding from a declaration check: the post-synth diagnostic shape, with
 * `entity` naming the entry it is about and `pointer` the place in the
 * declaration to show.
 */
export interface WorkspaceDiagnostic extends PostSynthDiagnostic {
  /** A JSON Pointer into the declaration. */
  pointer: string;
  /** An absolute path, for a finding about a file other than the declaration, such as a record (#2549). It is reported at its first line. */
  file?: string;
  /** A path in the tree checked, relative to the workspace root, for a finding about a file there (#2726). It is reported at `line` and `column`. */
  treeFile?: string;
  line?: number;
  column?: number;
  /** The read contract's code for the finding, when it has one (#2726). */
  code?: ReasonCode;
}

export interface WorkspaceCheck {
  /** `WSP` and three digits. Public once shipped. */
  id: string;
  /** A short name, for listings. */
  name: string;
  description: string;
  severity: Severity;
  /** False when the declaration may neither change the severity nor suppress it. */
  configurable: boolean;
  check(ctx: WorkspaceCheckContext): WorkspaceDiagnostic[];
}

/** A diagnostic ready for lint's reporters, with the entry it is about. */
export interface WorkspaceFinding extends LintDiagnostic {
  entity?: string;
  /** The read contract's reason code: for a WSP001 finding, why the declaration can't be read (#2536); for a box check, its finding code (#2726). */
  code?: ReasonCode;
}

export interface SuppressedFinding extends WorkspaceFinding {
  reason: string;
}

export interface DeclarationCheckReport {
  /** The declaration file, relative to the directory the report was made for. */
  file: string;
  diagnostics: WorkspaceFinding[];
  suppressed: SuppressedFinding[];
  /** The member links, declared and inferred, as resolved in source (#2539). */
  links: LinkTableRow[];
  /** Whether an error-severity finding is active. */
  ok: boolean;
}

const HELP = "https://intentius.io/chant/cli/workspace-check/#declaration-checks";

const memberDir = (dir: string) => (dir === "." ? "" : dir);

function entryFinding(check: WorkspaceCheck, entry: Entry, field: string | null, message: string): WorkspaceDiagnostic {
  return {
    checkId: check.id,
    severity: check.severity,
    message,
    entity: entry.name,
    pointer: field ? `${entry.pointer}/${field}` : entry.pointer,
  };
}

/** The dir exists and the kind is known: the members every probe check reads. */
function readableMembers(ctx: WorkspaceCheckContext) {
  return ctx.declaration.members.filter((m) => ctx.tree.stat(memberDir(m.dir)) === "dir" && ctx.kinds.get(m.kind) !== undefined);
}

/** The first id of the read failure, used by {@link runDeclarationChecks} when the declaration can't be read. */
export const UNREADABLE_CHECK_ID = "WSP001";

export const WORKSPACE_CHECKS: readonly WorkspaceCheck[] = [
  {
    id: "WSP001",
    name: "declaration-unreadable",
    description: "The declaration can be read: it parses, matches the schema and keeps the placement rules.",
    severity: "error",
    configurable: false,
    // Reported by runDeclarationChecks, since a declaration that can't be read gives no context.
    check: () => [],
  },
  {
    id: "WSP002",
    name: "kinds-unreadable",
    description: "Every pinned package's kinds can be read: it is installed at the pinned version, and its ./workspace-kinds file is valid kind data.",
    severity: "error",
    configurable: false,
    check(ctx) {
      return ctx.kindProblems.map((p) => ({ checkId: this.id, severity: this.severity, message: p.message, pointer: `/pins/${p.pin}` }));
    },
  },
  {
    id: "WSP003",
    name: "kind-unknown",
    description: "Every member's kind is built in or supplied by a pinned package. Unknown kinds fail closed.",
    severity: "error",
    configurable: false,
    check(ctx) {
      return ctx.declaration.members
        .filter((m) => ctx.kinds.get(m.kind) === undefined)
        .map((m) => entryFinding(this, m, "kind", `member ${m.name} has kind ${m.kind}, which no built-in kind or pinned package supplies; known kinds: ${ctx.kinds.names().join(", ")}`));
    },
  },
  {
    id: "WSP004",
    name: "member-dir-missing",
    description: "Every member's directory exists.",
    severity: "error",
    configurable: true,
    check(ctx) {
      return ctx.declaration.members
        .filter((m) => ctx.tree.stat(memberDir(m.dir)) !== "dir")
        .map((m) => entryFinding(this, m, "dir", `member ${m.name}'s directory ${m.dir} does not exist${ctx.tree.label}`));
    },
  },
  {
    id: "WSP005",
    name: "kind-probe-failed",
    description: "Every member's directory is what its kind reads, such as a chant config for a chant member.",
    severity: "error",
    configurable: true,
    check(ctx) {
      return readableMembers(ctx)
        .filter((m) => !probeKind(ctx.kinds.get(m.kind)!, ctx.tree, memberDir(m.dir)))
        .map((m) => entryFinding(this, m, "kind", `member ${m.name} (${m.dir}) is not ${ctx.kinds.get(m.kind)!.description}`));
    },
  },
  {
    id: "WSP006",
    name: "kind-probe-tie",
    description: "No directory is claimed by two kinds of the same highest precedence. Ties fail.",
    severity: "error",
    configurable: false,
    check(ctx) {
      const out: WorkspaceDiagnostic[] = [];
      for (const m of readableMembers(ctx)) {
        const { tie } = resolveKind(ctx.kinds, ctx.tree, memberDir(m.dir), m.dir === "." ? ["workspace"] : []);
        if (tie.length === 0) continue;
        const names = tie.map((k) => `${k.name} (${k.source})`).join(" and ");
        out.push(entryFinding(this, m, "kind", `the probes of ${names} all claim ${m.dir} with precedence ${tie[0].precedence}; a tie fails, so one of those kinds needs a different precedence`));
      }
      return out;
    },
  },
  {
    id: "WSP007",
    name: "kind-outranked",
    description: "When several kinds claim a member's directory, the declared kind is the one the precedence order picks.",
    severity: "error",
    configurable: true,
    check(ctx) {
      const out: WorkspaceDiagnostic[] = [];
      for (const m of readableMembers(ctx)) {
        if (m.kind === "other") continue;
        const { winner } = resolveKind(ctx.kinds, ctx.tree, memberDir(m.dir), m.dir === "." ? ["workspace"] : []);
        if (!winner || winner.name === m.kind) continue;
        out.push(entryFinding(this, m, "kind", `member ${m.name} is declared ${m.kind}, and kind ${winner.name} (precedence ${winner.precedence}) claims ${m.dir} first; declare it as ${winner.name}`));
      }
      return out;
    },
  },
  {
    id: "WSP008",
    name: "other-claimed",
    description: "No other member's directory is claimed by a registered kind's probe.",
    severity: "error",
    configurable: false,
    check(ctx) {
      const out: WorkspaceDiagnostic[] = [];
      for (const m of readableMembers(ctx)) {
        if (m.kind !== "other") continue;
        const { claims } = resolveKind(ctx.kinds, ctx.tree, memberDir(m.dir), m.dir === "." ? ["workspace"] : []);
        if (claims.length === 0) continue;
        out.push(entryFinding(this, m, "kind", `member ${m.name} is declared other, and kind ${claims[0].name} claims ${m.dir}: it is ${claims[0].description}; declare it as ${claims[0].name}`));
      }
      return out;
    },
  },
  {
    id: "WSP009",
    name: "other-member",
    description: "A member of kind other is one chant does not read. It is reported so that it stays a decision.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      return ctx.declaration.members
        .filter((m) => m.kind === "other")
        .map((m) => entryFinding(this, m, null, `member ${m.name} (${m.dir}) is kind other, which chant does not read: ${m.because}`));
    },
  },
  {
    id: "WSP010",
    name: "group-empty",
    description: "Every example group matches at least one chant project.",
    severity: "warning",
    configurable: true,
    check(ctx) {
      return ctx.groups
        .filter((g) => g.matches.length === 0)
        .map((g) => entryFinding(this, g.group, "glob", `example group ${g.group.name} matches no chant project${ctx.tree.label}`));
    },
  },
  {
    id: "WSP011",
    name: "check-settings-invalid",
    description: "The declaration's checks and suppress settings name known, configurable WSP ids.",
    severity: "error",
    configurable: false,
    check(ctx) {
      const out: WorkspaceDiagnostic[] = [];
      for (const id of Object.keys(ctx.declaration.checks)) {
        const problem = settingProblem(id);
        if (problem) out.push({ checkId: this.id, severity: this.severity, message: `checks sets ${id}, which ${problem}`, pointer: `/checks/${pointerToken(id)}` });
      }
      for (const e of ctx.declaration.entries) {
        e.suppress.forEach((s, i) => {
          const problem = settingProblem(s.check);
          if (problem) out.push(entryFinding(this, e, `suppress/${i}/check`, `${e.name} suppresses ${s.check}, which ${problem}`));
        });
      }
      return out;
    },
  },
  // Member ledgers (#2538).
  ...LEDGER_CHECKS,
  // Recorded pipelines (#2542).
  ...PIPELINE_CHECKS,
  // Member links (#2539), WSP091 to WSP097.
  ...LINK_CHECKS,
  // Generated files (#2541).
  ...GENERATED_CHECKS,
  // Records read with --kind (#2549).
  ...RECORD_CHECKS,
  // Boxes and their brokered capabilities (#2726).
  ...BOX_CHECKS,
  // Diagram artifacts (#2764).
  ...DIAGRAM_CHECKS,
];

const BY_ID = new Map(WORKSPACE_CHECKS.map((c) => [c.id, c]));

function settingProblem(id: string): string | undefined {
  const check = BY_ID.get(id);
  if (!check) return `is not a declaration check; known checks: ${WORKSPACE_CHECKS.map((c) => c.id).join(", ")}`;
  if (!check.configurable) return `is fixed: it can't be turned down or suppressed`;
  return undefined;
}

/**
 * The checks' metadata as lint rules, for the SARIF reporter's rule list.
 * They are never run as lint rules.
 */
export function workspaceCheckRules(): LintRule[] {
  return WORKSPACE_CHECKS.map((c) => ({
    id: c.id,
    severity: c.severity,
    category: "correctness",
    description: `${c.name}: ${c.description}`,
    helpUri: HELP,
    check: () => [],
  }));
}

/** Run every check over a readable declaration. The settings are not applied yet. */
export function runWorkspaceChecks(ctx: WorkspaceCheckContext): WorkspaceDiagnostic[] {
  return WORKSPACE_CHECKS.flatMap((c) => c.check(ctx));
}

/**
 * Apply the declaration's `checks` severities and entries' `suppress` to the
 * findings. Fixed checks keep their severity and can't be suppressed; a
 * setting that tries is itself a WSP011 finding.
 */
export function applyCheckSettings(
  declaration: Declaration,
  findings: WorkspaceDiagnostic[],
): { active: WorkspaceDiagnostic[]; suppressed: (WorkspaceDiagnostic & { reason: string })[] } {
  const active: WorkspaceDiagnostic[] = [];
  const suppressed: (WorkspaceDiagnostic & { reason: string })[] = [];
  const byName = new Map(declaration.entries.map((e) => [e.name, e]));
  for (const f of findings) {
    const check = BY_ID.get(f.checkId);
    if (!check?.configurable) {
      active.push(f);
      continue;
    }
    const setting = declaration.checks[f.checkId];
    if (setting === "off") continue;
    const finding = setting ? { ...f, severity: setting } : f;
    const suppression = f.entity !== undefined ? byName.get(f.entity)?.suppress.find((s) => s.check === f.checkId) : undefined;
    if (suppression) suppressed.push({ ...finding, reason: suppression.because });
    else active.push(finding);
  }
  return { active, suppressed };
}

export interface DeclarationCheckOptions {
  /**
   * Gather the facts the ledger, pipeline and generated-file checks read.
   * On by default. Off, only the declaration and kind checks find anything,
   * and no member config is read.
   */
  gather?: boolean;
  /** Run each declared generator and compare its output (`--generated`). Off by default: generators run member code. */
  runGenerators?: boolean;
  /**
   * The files to check, such as a revision's (`chant workspace check --at`,
   * #2536); the working tree under `root` by default. Kinds still come from
   * the packages installed under `root`. With a tree, no facts are
   * gathered: they describe the working tree, not the revision.
   */
  tree?: WorkspaceTree;
  /** The records read with `--kind`, in the same tree (#2549). Given with or without `tree`. */
  records?: RecordFacts;
}

/**
 * Gather {@link WorkspaceFacts} for the declaration in `root`. Member
 * configs are read statically, never run: the ledger facts read `ownership`
 * and `environments`, and the generated-file facts read `lexicons`. Declared
 * generators run only when `runGenerators` says so, and they are the only
 * member code this runs.
 */
export async function gatherWorkspaceFacts(root: string, declaration: Declaration, options: { runGenerators?: boolean } = {}): Promise<WorkspaceFacts> {
  // Pipeline records hold paths relative to the repository root.
  const top = gitTop(root);
  const prefix = top ? relative(realpath(top), realpath(root)).split(sep).join("/") || "." : ".";
  return {
    ledgers: await gatherLedgerFacts(root, declaration),
    pipelines: gatherPipelineFacts(root, declaration, prefix),
    generated: await gatherGeneratedFacts(root, declaration, { runGenerators: options.runGenerators === true }),
  };
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Read the declaration in `root` (an absolute directory holding one, or the
 * files of `options.tree` when given, such as a revision's), load the kinds
 * its pins supply from `root`, gather the facts the member checks read, run
 * every check and apply the declaration's settings. `file` in the findings
 * is the declaration's path as `display` says, relative to where the
 * command runs. Never throws a {@link WorkspaceReadError}: a declaration that
 * can't be read is one WSP001 finding.
 */
export async function runDeclarationChecks(
  root: string,
  display: (file: string) => string = (f) => f,
  options: DeclarationCheckOptions = {},
): Promise<DeclarationCheckReport> {
  const tree = options.tree ?? workingTree(root);
  let declaration: Declaration;
  let groups: ResolvedGroup[];
  try {
    declaration = readDeclaration(tree, "", { rootChant: true });
    groups = resolveGroups(declaration, tree);
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    const location: ErrorLocation = err.location ?? { file: "chant.workspace.json", line: 1, column: 1 };
    const diagnostic: WorkspaceFinding = {
      file: display(location.file),
      line: location.line,
      column: location.column,
      ruleId: UNREADABLE_CHECK_ID,
      severity: "error",
      message: `${err.code}: ${err.message}`,
      code: err.code,
    };
    return { file: display(location.file), diagnostics: [diagnostic], suppressed: [], links: [], ok: false };
  }
  const { registry, problems } = loadKindRegistry(declaration.pins, root);
  const gathered = options.gather === false || options.tree ? {} : await gatherWorkspaceFacts(root, declaration, options);
  // The declared record kinds load from the working tree; under --at only whether each exists at the revision is checked (#2680).
  // A declared work kind's acceptance criteria are counted in the working tree too (#2772).
  const declaredKinds = options.gather === false ? undefined : await loadDeclaredKinds(declaration, tree, root, { load: !options.tree, acceptance: !options.tree });
  // A box's intent is read from the working tree's records, so not under --at (#2850).
  const boxIntents = declaredKinds && !options.tree ? await resolveBoxIntents(declaration, root, declaredKinds) : undefined;
  const facts: WorkspaceFacts = {
    ...gathered,
    ...(options.records ? { records: options.records } : {}),
    ...(declaredKinds ? { declaredKinds } : {}),
    ...(boxIntents ? { boxIntents } : {}),
  };
  const ctx: WorkspaceCheckContext = { declaration, tree, groups, kinds: registry, kindProblems: problems, facts };
  const findings = runWorkspaceChecks(ctx);
  const { active, suppressed } = applyCheckSettings(declaration, findings);

  const parsed = parseJsonText(tree.read(declaration.file), { jsonc: declaration.file.endsWith(".jsonc") });
  const locate = (pointer: string): TextLocation => (parsed.ok ? parsed.locate(pointer) : { line: 1, column: 1 });
  const file = display(declaration.file);
  const toFinding = (d: WorkspaceDiagnostic): WorkspaceFinding => ({
    ...(d.treeFile !== undefined
      ? { file: display(d.treeFile), line: d.line ?? 1, column: d.column ?? 1 }
      : d.file !== undefined
        ? { file: display(relative(root, d.file).split(sep).join("/")), line: 1, column: 1 }
        : { file, ...locate(d.pointer) }),
    ruleId: d.checkId,
    severity: d.severity,
    message: d.message,
    ...(d.entity !== undefined ? { entity: d.entity } : {}),
    ...(d.code !== undefined ? { code: d.code } : {}),
  });
  const order = (a: LintDiagnostic, b: LintDiagnostic) => a.line - b.line || a.column - b.column || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0);
  const diagnostics = active.map(toFinding).sort(order);
  return {
    file,
    diagnostics,
    suppressed: suppressed.map((s) => ({ ...toFinding(s), reason: s.reason })).sort(order),
    links: linkTable(ctx),
    ok: !diagnostics.some((d) => d.severity === "error"),
  };
}
