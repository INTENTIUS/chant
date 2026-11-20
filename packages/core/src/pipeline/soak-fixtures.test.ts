/**
 * terragucci's `rollouts.soak` decisions, run on chant's soak (#5326).
 *
 * `__fixtures__/soak/` is a byte-for-byte copy of terragucci's
 * `packages/terragucci/test/fixtures/soak/` (INTENTIUS/terragucci#1497); its
 * README gives the format. Each case's world is mapped onto chant's soak the
 * way a product maps its config:
 *
 * - `rollouts.soak` becomes a `Soak`: `after` is `duration`, each condition a
 *   check of that kind with `onFail: "hold"` (terragucci reads a condition
 *   only once the wait is up, and a finding holds with the time kept), and
 *   an override of the rollout's kind becomes an override by member glob.
 *   An override of the other kind can never name the rollout and is left
 *   out.
 * - each merged pull request is a member that applied: the project, its
 *   roots as targets, its merge time as the apply time, and the rollout's
 *   names (as written, with and without its registry host, and its
 *   aliases) as the spellings an override glob may match.
 * - the drift issue, the applies and the denials are the check sources; the
 *   rules over them (code spans, failure only, newest denial since the
 *   clock) are chant's.
 * - the first skip comment, in merge order, is a person ending the soak.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decideSoak, soakDurationMs, type Soak, type SoakCheck, type SoakDecision, type SoakOverride } from "./soak";
import { soakCheckReader, type SoakApplyState } from "./soak-checks";

type Condition = "drift" | "apply" | "policy";
interface FixtureSoak {
  after: string;
  conditions?: Condition[];
  overrides?: { module?: string; provider?: string; after?: string; conditions?: Condition[] }[];
}
interface FixtureCase {
  name: string;
  why: string;
  soak: string | FixtureSoak | null;
  rollout: { kind: "module" | "provider"; name: string; aliases: string[] };
  wave: { number: number; merged: { project: string; roots: string[]; branch: string; at?: string }[] };
  now: string;
  world: {
    projects: Record<string, { driftIssue: { url: string; roots: string[]; text?: string } | null; applies: Record<string, SoakApplyState>; skips: Record<string, { by: string; url?: string }[]> }>;
    denials: { root: string; at: string; rules: string[] }[];
  };
  decision: {
    outcome: "hold" | "release";
    via?: "no-soak" | "skip" | "soaked";
    rule: { after: string; afterMs: number; conditions: Condition[] } | null;
    clockStart: string | null;
    due: string | null;
    holds: ({ reason: "time" } | { reason: "condition"; condition: Condition; project: string; roots: string[] } | { reason: "merge-time-unknown"; projects: string[] })[];
    skippedBy?: { by: string; url?: string };
  };
}

const DIR = join(__dirname, "__fixtures__", "soak");
const FILES = ["clock", "conditions", "overrides", "skip"] as const;
const load = (file: string): FixtureCase[] => (JSON.parse(readFileSync(join(DIR, `${file}.json`), "utf-8")) as { cases: FixtureCase[] }).cases;

const checksOf = (conditions: Condition[] | undefined): SoakCheck[] | undefined => conditions?.map((kind) => ({ kind, onFail: "hold" as const }));

/** terragucci's config onto chant's soak, for a rollout of `kind`. */
function soakOf(soak: FixtureCase["soak"], kind: "module" | "provider"): Soak | undefined {
  if (soak === null) return undefined;
  const s: FixtureSoak = typeof soak === "string" ? { after: soak } : soak;
  const overrides: SoakOverride[] = (s.overrides ?? [])
    .filter((o) => (kind === "module" ? o.module : o.provider) !== undefined)
    .map((o) => ({ members: [(kind === "module" ? o.module : o.provider)!], ...(o.after !== undefined ? { duration: o.after } : {}), ...(o.conditions !== undefined ? { checks: checksOf(o.conditions)! } : {}) }));
  return { duration: s.after, ...(s.conditions ? { checks: checksOf(s.conditions)! } : {}), ...(overrides.length > 0 ? { overrides } : {}) };
}

/** The spellings of a rollout's name: as written, with the registry host, without it, and its aliases. */
function namesOf(rollout: FixtureCase["rollout"]): string[] {
  const n = rollout.name;
  if (/^oci:\/\//.test(n)) return [n, n.replace(/^oci:\/\//, ""), ...rollout.aliases];
  const segments = n.split("/");
  const parts = rollout.kind === "module" ? 3 : 2;
  const full = segments.length === parts && !segments[0]!.includes(".") && !segments[0]!.includes(":") ? `registry.terraform.io/${n}` : n;
  const bare = full.replace(/^[^/]*[.:][^/]*\//, "");
  return [...new Set([n, full, bare, ...rollout.aliases])];
}

async function decide(c: FixtureCase): Promise<SoakDecision> {
  const skip = c.wave.merged.map((m) => c.world.projects[m.project]?.skips[m.branch]?.[0]).find((s) => s !== undefined);
  const read = soakCheckReader({
    async driftIssue(_env, member) {
      const issue = c.world.projects[member!]?.driftIssue;
      return issue ? { body: [...issue.roots.map((r) => `- \`${r}\``), issue.text ?? ""].join("\n"), url: issue.url } : null;
    },
    async applies(_env, member) {
      return { ...(c.world.projects[member!]?.applies ?? {}) };
    },
    async denials() {
      return c.world.denials.map((d) => ({ target: d.root, at: d.at, rules: d.rules }));
    },
  });
  return decideSoak({
    soak: soakOf(c.soak, c.rollout.kind),
    subjects: c.wave.merged.map((m) => ({ member: m.project, names: namesOf(c.rollout), targets: m.roots, ...(m.at !== undefined ? { appliedAt: m.at } : {}) })),
    environment: "rollout",
    now: new Date(c.now),
    ...(skip ? { ended: skip } : {}),
    read,
  });
}

/** chant's decision in the fixtures' words. */
function asFixture(d: SoakDecision): Omit<FixtureCase["decision"], "rule"> & { rules: unknown[] } {
  return {
    outcome: d.outcome,
    ...(d.via ? { via: d.via === "ended" ? "skip" : d.via } : {}),
    rules: d.rules.map((r) => ({ after: r.rule.duration, afterMs: r.rule.durationMs, conditions: r.rule.checks.map((c) => c.kind) })),
    clockStart: d.clockStart,
    due: d.due,
    holds: d.holds.map((h) =>
      h.reason === "time"
        ? { reason: "time" as const }
        : h.reason === "clock-unknown"
          ? { reason: "merge-time-unknown" as const, projects: h.members }
          : { reason: "condition" as const, condition: h.kind as Condition, project: h.member!, roots: h.targets! },
    ),
    ...(d.endedBy ? { skippedBy: d.endedBy } : {}),
  };
}

describe("terragucci's rollouts.soak fixtures on chant's soak", () => {
  test("every file loads, and the cases are the 83 terragucci keeps", () => {
    expect(FILES.reduce((n, f) => n + load(f).length, 0)).toBe(83);
  });

  for (const file of FILES) {
    describe(file, () => {
      for (const c of load(file)) {
        test(c.name, async () => {
          const got = asFixture(await decide(c));
          const { rule, ...want } = c.decision;
          // A rollout has one rule, so each member that applied soaks under it.
          expect(got.rules).toEqual(rule === null ? [] : c.wave.merged.map(() => rule));
          expect(soakDurationMs(rule?.after ?? "0")).toBe(rule?.afterMs ?? 0);
          const { rules: _rules, ...rest } = got;
          expect(rest).toEqual(want);
        });
      }
    });
  }
});
