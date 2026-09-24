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
 *
 * The checks are pure functions over {@link MemberLedgerFacts}.
 * {@link gatherLedgerFacts} collects those facts from a checkout. Wiring into
 * `WorkspaceCheck` (#2535) is left to that issue, which owns the reporter and
 * the id registry.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MEMBER_LEDGER_FLOOR } from "../../lifecycle/member-ledger";
import { compareVersions, type Declaration } from "../declaration";

export const WSP_DISTINCT_STACKS = "WSP071";
export const WSP_FLAT_LEDGER_ENVIRONMENTS = "WSP072";

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

/**
 * Collect {@link MemberLedgerFacts} for every `chant` member of `declaration`,
 * whose workspace root is `root`. Reading `ownership` and `environments`
 * loads each member's chant.config the way `chant build` does. A member whose
 * config fails to load is left out; `chant lint` in that member reports it.
 */
export async function gatherLedgerFacts(root: string, declaration: Declaration): Promise<MemberLedgerFacts[]> {
  const { loadChantConfig, resolveOwnershipStack, environmentNames } = await import("../../config");
  const facts: MemberLedgerFacts[] = [];
  for (const m of declaration.members) {
    if (m.kind !== "chant") continue;
    const dir = join(root, m.dir);
    let config;
    try {
      ({ config } = await loadChantConfig(dir));
    } catch {
      continue;
    }
    const environments = [...(environmentNames(config.environments) ?? [])];
    const literalEnv = config.ownership?.env;
    if (typeof literalEnv === "string" && !environments.includes(literalEnv)) environments.push(literalEnv);
    facts.push({
      name: m.name,
      dir: m.dir,
      stack: resolveOwnershipStack(config) ?? null,
      environments,
      chantVersion: memberChantVersion(dir),
    });
  }
  return facts;
}
