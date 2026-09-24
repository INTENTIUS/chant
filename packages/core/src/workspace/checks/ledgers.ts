/**
 * The workspace checks behind member ledgers (#2538, #2524 D7, ws-036 and
 * ws-037).
 *
 * - `WSP071`: every `chant` member that stamps ownership markers uses its own
 *   `ownership.stack`. Markers carry no member key, so the stack is what tells
 *   two members' resources and receipts apart.
 * - `WSP072`: members that write the flat ledger layout never share an
 *   environment name. A member whose own chant is older than
 *   {@link MEMBER_LEDGER_FLOOR} still writes `<env>/...` at the top of
 *   `chant/lifecycle`, and so does the root member `.`; two flat writers with
 *   one environment name would write the same files.
 * - `WSP073` (info): a member's ledger settings could not be read without
 *   running its config, so the two checks above could not compare it.
 *
 * The checks are pure functions over {@link MemberLedgerFacts}.
 * {@link gatherLedgerFacts} collects those facts from a checkout, and
 * `chant workspace check` gathers them before it runs {@link LEDGER_CHECKS}
 * (#2641). WSP071 and WSP072 are fixed: a member that ignores either one
 * writes its records or marks its resources as another member's. Member
 * configs are read statically and never run.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { MEMBER_LEDGER_FLOOR } from "../../lifecycle/member-ledger";
import type { WorkspaceCheck, WorkspaceCheckContext, WorkspaceDiagnostic } from "../checks";
import { compareVersions, type Declaration } from "../declaration";

export const WSP_DISTINCT_STACKS = "WSP071";
export const WSP_FLAT_LEDGER_ENVIRONMENTS = "WSP072";
export const WSP_LEDGER_SETTINGS_UNREAD = "WSP073";

export interface LedgerFinding {
  id: typeof WSP_DISTINCT_STACKS | typeof WSP_FLAT_LEDGER_ENVIRONMENTS;
  severity: "error";
  /** The members the finding is about, in declaration order. */
  members: string[];
  message: string;
}

/** What the ledger checks need to know about one `chant` member. */
export interface MemberLedgerFacts {
  name: string;
  /** Relative to the workspace root; `"."` is the root member. */
  dir: string;
  /** `ownership.stack` when marking is on, else null. */
  stack: string | null;
  /** The environment names the member declares (`environments`, and a literal `ownership.env`). */
  environments: string[];
  /** The chant the member's own toolchain resolves, or null when none is installed. */
  chantVersion: string | null;
  /**
   * Why the member's ledger settings could not be read without running its
   * config. Such a member has no stack and no environments here, so neither
   * check compares it; `WSP073` reports it instead.
   */
  unread?: string;
}

/** `WSP071`: no two members share an `ownership.stack`. */
export function checkDistinctStacks(facts: readonly MemberLedgerFacts[]): LedgerFinding[] {
  const byStack = new Map<string, MemberLedgerFacts[]>();
  for (const f of facts) {
    if (f.stack === null) continue;
    byStack.set(f.stack, [...(byStack.get(f.stack) ?? []), f]);
  }
  const findings: LedgerFinding[] = [];
  for (const [stack, members] of byStack) {
    if (members.length < 2) continue;
    const names = members.map((m) => m.name);
    findings.push({
      id: WSP_DISTINCT_STACKS,
      severity: "error",
      members: names,
      message:
        `members ${names.join(", ")} all set ownership.stack to ${JSON.stringify(stack)}; ` +
        `ownership markers carry no member name, so each member needs its own stack. ` +
        `Rename all but one in their chant.config.ts (chant workspace init proposes names).`,
    });
  }
  return findings;
}

/** Whether `f` writes the flat ledger layout: the root member, or a member on a chant below the floor. */
export function writesFlatLedger(f: MemberLedgerFacts, floor: string = MEMBER_LEDGER_FLOOR): boolean {
  if (f.dir === ".") return true;
  if (f.chantVersion === null) return false;
  try {
    return compareVersions(f.chantVersion, floor) < 0;
  } catch {
    // A version chant cannot read says nothing about the layout.
    return false;
  }
}

/** `WSP072`: flat-layout writers never share an environment name. */
export function checkFlatLedgerEnvironments(
  facts: readonly MemberLedgerFacts[],
  floor: string = MEMBER_LEDGER_FLOOR,
): LedgerFinding[] {
  const flat = facts.filter((f) => writesFlatLedger(f, floor));
  const byEnv = new Map<string, MemberLedgerFacts[]>();
  for (const f of flat) {
    for (const env of new Set(f.environments)) byEnv.set(env, [...(byEnv.get(env) ?? []), f]);
  }
  const findings: LedgerFinding[] = [];
  for (const [env, members] of byEnv) {
    if (members.length < 2) continue;
    const names = members.map((m) => m.name);
    const why = members.map((m) => (m.dir === "." ? `${m.name} is the root member` : `${m.name} runs chant ${m.chantVersion}`));
    findings.push({
      id: WSP_FLAT_LEDGER_ENVIRONMENTS,
      severity: "error",
      members: names,
      message:
        `members ${names.join(", ")} ${names.length === 2 ? "both" : "all"} write the flat ledger layout and share the environment ${JSON.stringify(env)}, ` +
        `so their releases, snapshots and runs land in the same files on chant/lifecycle (${why.join("; ")}). ` +
        `Upgrade the members below chant ${floor}, which write under _members/<member>/, or rename the environment in one of them.`,
    });
  }
  return findings;
}

/** Both ledger checks, stack findings first. */
export function checkLedgers(facts: readonly MemberLedgerFacts[], floor: string = MEMBER_LEDGER_FLOOR): LedgerFinding[] {
  return [...checkDistinctStacks(facts), ...checkFlatLedgerEnvironments(facts, floor)];
}

// ── As workspace checks ──────────────────────────────────────────────────────

/**
 * A finding as a workspace diagnostic. It sits at the first member it names,
 * in declaration order, and that member's entry is the one that can carry a
 * `suppress` for a settable check.
 */
function toDiagnostic(check: WorkspaceCheck, ctx: WorkspaceCheckContext, f: LedgerFinding): WorkspaceDiagnostic {
  const member = ctx.declaration.members.find((m) => m.name === f.members[0]);
  return { checkId: check.id, severity: check.severity, message: f.message, entity: f.members[0], pointer: member?.pointer ?? "" };
}

/** The ledger checks, which read `ctx.facts.ledgers`. They find nothing when the facts were not gathered. */
export const LEDGER_CHECKS: readonly WorkspaceCheck[] = [
  {
    id: WSP_DISTINCT_STACKS,
    name: "ownership-stack-shared",
    description: "No two chant members set the same ownership.stack. Ownership markers carry no member name, so the stack tells members' resources and receipts apart.",
    severity: "error",
    configurable: false,
    check(ctx) {
      return checkDistinctStacks(ctx.facts?.ledgers ?? []).map((f) => toDiagnostic(this, ctx, f));
    },
  },
  {
    id: WSP_FLAT_LEDGER_ENVIRONMENTS,
    name: "flat-ledger-environment-shared",
    description: `No two members that write the flat ledger layout (the root member, and members on a chant older than ${MEMBER_LEDGER_FLOOR}) share an environment name.`,
    severity: "error",
    configurable: false,
    check(ctx) {
      return checkFlatLedgerEnvironments(ctx.facts?.ledgers ?? []).map((f) => toDiagnostic(this, ctx, f));
    },
  },
  {
    id: WSP_LEDGER_SETTINGS_UNREAD,
    name: "ledger-settings-unread",
    description: "A chant member's ownership and environments could not be read from its config without running it, so WSP071 and WSP072 could not compare it.",
    severity: "info",
    configurable: true,
    check(ctx) {
      return (ctx.facts?.ledgers ?? [])
        .filter((f) => f.unread !== undefined)
        .map((f) => ({
          checkId: this.id,
          severity: this.severity,
          message: `member ${f.name}'s ownership and environments were not compared with other members': ${f.unread}`,
          entity: f.name,
          pointer: ctx.declaration.members.find((m) => m.name === f.name)?.pointer ?? "",
        }));
    },
  },
];

// ── Facts from a checkout ────────────────────────────────────────────────────

/**
 * The version of `@intentius/chant` that `dir`'s own toolchain resolves: the
 * nearest `node_modules/@intentius/chant/package.json` walking up from `dir`,
 * as Node's resolution would find it. Null when there is none.
 */
export function memberChantVersion(dir: string): string | null {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const pkg = join(d, "node_modules", "@intentius", "chant", "package.json");
    if (existsSync(pkg)) {
      try {
        const version = (JSON.parse(readFileSync(pkg, "utf-8")) as { version?: unknown }).version;
        return typeof version === "string" ? version : null;
      } catch {
        return null;
      }
    }
    if (dirname(d) === d) return null;
  }
}

/** The config fields the ledger checks read. */
const LEDGER_FIELDS = ["ownership", "environments"] as const;

/**
 * Collect {@link MemberLedgerFacts} for every `chant` member of `declaration`,
 * whose workspace root is `root`. `ownership` and `environments` are read
 * from each member's config statically (../../config-static.ts), the way
 * `chant audit` reads lexicons: the config is never run (#2641). A member
 * whose settings can't be read that way gets {@link MemberLedgerFacts.unread}
 * with the reason, and no stack or environments.
 */
export async function gatherLedgerFacts(root: string, declaration: Declaration): Promise<MemberLedgerFacts[]> {
  const { readConfigFieldsStatically } = await import("../../config-static");
  const { ChantConfigSchema, environmentNames, resolveOwnershipStack } = await import("../../config");
  const facts: MemberLedgerFacts[] = [];
  for (const m of declaration.members) {
    if (m.kind !== "chant") continue;
    const dir = join(root, m.dir);
    const base = { name: m.name, dir: m.dir, chantVersion: memberChantVersion(dir) };
    const read = readConfigFieldsStatically(dir, LEDGER_FIELDS);
    // No config: the kind probe reports the member (WSP005).
    if (read.status === "no-config") continue;
    const file = relative(root, read.configPath).split(sep).join("/");
    const unread = (reason: string) => facts.push({ ...base, stack: null, environments: [], unread: `${file} can't be read without running it (${reason})` });
    if (read.status === "unknown") {
      unread(read.reason);
      continue;
    }
    const parsed = ChantConfigSchema.pick({ ownership: true, environments: true }).safeParse(read.fields);
    if (!parsed.success) {
      unread(`its ${String(parsed.error.issues[0]?.path[0] ?? "settings")} value is not what a chant config takes`);
      continue;
    }
    const config = parsed.data;
    const environments = [...(environmentNames(config.environments) ?? [])];
    const literalEnv = config.ownership?.env;
    if (typeof literalEnv === "string" && !environments.includes(literalEnv)) environments.push(literalEnv);
    facts.push({ ...base, stack: resolveOwnershipStack(config) ?? null, environments });
  }
  return facts;
}
