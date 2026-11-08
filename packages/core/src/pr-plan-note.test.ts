/**
 * A product's plan note (#4810): a report the product builds from its own
 * plan run, rendered by chant in the product's words. The golden is
 * terragucci's own (its test/__golden__/note.recurring.md), copied byte for
 * byte, and the input is the report terragucci hands chant for that plan.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { renderPrNote as renderPrLoopNote, type PrReport } from "./pr-loop";
import { diffFence, diffLines, isPlanNote, planNoteMarker, renderPlanNote, renderPrNote, type PrPlanNote } from "./pr-plan-note";
import { assertProductWords } from "./ci-product-words";
import { PLYWOOD, TERRAGUCCI, TERRAGUCCI_NOTE, YODEL } from "./__fixtures__/product-words";

const DIR = join(import.meta.dirname, "__fixtures__", "pr-loop");
const read = (name: string): string => readFileSync(join(DIR, name), "utf-8");
const input = (): PrPlanNote => JSON.parse(read("terragucci-plan.note.json")) as PrPlanNote;
const words = assertProductWords(TERRAGUCCI);
const tg = { words, note: TERRAGUCCI_NOTE };

const PLAN = [
  "OpenTofu will perform the following actions:",
  "",
  "  # aws_sqs_queue.jobs will be updated in-place",
  '  ~ resource "aws_sqs_queue" "jobs" {',
  "      ~ visibility_timeout_seconds = 60 -> 90",
  "    }",
  "",
  "Plan: 0 to add, 1 to change, 0 to destroy.",
].join("\n");

describe("terragucci's plan note from chant (#4810)", () => {
  test("is terragucci's golden, byte for byte", () => {
    expect(renderPlanNote(input(), tg)).toBe(read("terragucci-plan.note.golden.md"));
    expect(renderPrNote(input(), tg)).toBe(read("terragucci-plan.note.golden.md"));
  });

  test("a pull request loop report renders as the pr loop renders it, in every product's words", () => {
    const report = JSON.parse(read("pr-plan.golden.json")) as PrReport;
    expect(isPlanNote(report)).toBe(false);
    expect(renderPrNote(report, { approver: "github:<your-login>" })).toBe(read("pr-plan.note.golden.md"));
    for (const w of [PLYWOOD, YODEL, TERRAGUCCI]) {
      const product = assertProductWords(w);
      expect(renderPrNote(report, { words: product })).toBe(renderPrLoopNote(report, { words: product }));
    }
  });

  test("a group shows its first unit's diff, and each unit's whole plan follows with its plan file", () => {
    const note = renderPlanNote({ ...input(), unit: "member", groups: [{ id: "g1", units: ["app", "api"], changes: [{ line: "~ aws_sqs_queue.jobs", count: 2 }], diff: { unit: "app", lines: PLAN.split("\n").slice(2, 6) } }], sections: [], plans: [{ member: "app", text: PLAN, totals: "Plan: 0 to add, 1 to change, 0 to destroy.", file: "roots/app/plan.txt" }] }, tg);
    expect(note).toContain("#### [Group g1](report.html#group-g1): 2 roots, identical change\n\nAs `app` plans it:\n\n```diff\n  # aws_sqs_queue.jobs will be updated in-place\n~   resource \"aws_sqs_queue\" \"jobs\" {\n~       visibility_timeout_seconds = 60 -> 90\n    }\n```\n\nRoots: `app`, `api`\n\n");
    expect(note).toContain("**Each root's plan:**\n\n<details><summary><code>app</code>: Plan: 0 to add, 1 to change, 0 to destroy.</summary>");
    expect(note).toContain("[plan.txt](roots/app/plan.txt)\n\n</details>");
  });

  test("over the limit the whole plans go first, then diffs shrink, and a Cut line names what went", () => {
    const base = { ...input(), unit: "member" as const, sections: [], groups: [{ id: "g1", units: ["app"], changes: [{ line: "~ aws_sqs_queue.jobs", count: 1 }], diff: { unit: "app", lines: PLAN.split("\n").slice(2, 6) } }], plans: [{ member: "app", text: PLAN, file: "roots/app/plan.txt" }] };
    const whole = renderPlanNote(base, tg);
    const cut = renderPlanNote(base, { ...tg, limit: [...whole].length - 10 });
    expect(cut).not.toContain("<details>");
    expect(cut).toContain("```diff");
    expect(cut).toContain(`**Cut:** this note leaves out the whole plans of 1 root ([\`app\`](roots/app/plan.txt)), to stay within ${[...whole].length - 10} characters. [The full report](report.html) has all of it, and each root's plan.txt the whole plan.\n`);
    const tighter = renderPlanNote(base, { ...tg, limit: [...whole].length - 400 });
    expect(tighter).toContain("shows one group by attribute name, without the diff");
    expect(tighter).toContain("- [`app: aws_s3_bucket_acl.logs`](report.html#root-app) (replace, forced by `acl`)");
  });

  test("the report links three ways, and the run that keeps none", () => {
    expect(renderPlanNote({ ...input(), links: { report: "https://ci/run/9", artifacts: true } }, tg)).toContain("The full report is `report.html` in the `terragucci-report` artifact of [this run](https://ci/run/9).");
    expect(renderPlanNote({ ...input(), links: { report: "https://b/x/report.html?sig=1", expires: "2026-10-15T10:03:22.000Z" } }, tg)).toContain("[Full report](https://b/x/report.html?sig=1) The links to the bucket work until 2026-10-15 10:03 UTC.");
    const none = renderPlanNote({ ...input(), links: { run: "https://ci/run/9" } }, tg);
    expect(none).toContain("Planned in [this run](https://ci/run/9), which keeps no report artifact; with `reports` set, the note links the report in the bucket.");
    expect(none).toContain("- `app: aws_s3_bucket_acl.logs` (replace, forced by `acl`)");
  });

  test("the wave table says why a wave waits, its approve line under sealed approval, and its approval rules", () => {
    const note = renderPlanNote({ ...input(), sealed: true, waves: [{ number: 1, units: 2, digest: "d1", waits: true, unknownBy: ["app"], approvalRules: [{ units: ["app"], asks: "2 approvals" }] }, { number: 2, units: 1, digest: null, replansAfter: [1], waits: true }, { number: 3, units: 1, digest: "d3", policy: { outcome: "unattended", rules: ["ok"] } }] }, tg);
    expect(note).toContain("| 1 | 2 | `d1` | waits for an approval: `terragucci approve wave-1 --plan d1 --sign` (since `app` reads a value unknown at plan time); approval_rules: `app` 2 approvals |");
    expect(note).toContain("| 2 | 1 | after the re-plan | plans again once wave 1 applies, then waits for an approval of that plan |");
    expect(note).toContain("| 3 | 1 | `d3` | applies without an approval: allowed unattended by `ok` |");
    expect(note).toContain(planNoteMarker("terragucci:waves", { head: input().head, waves: [{ number: 1, digest: "d1", waits: true }, { number: 2, digest: null, waits: true }, { number: 3, digest: "d3", waits: false }] }));
  });

  test("policy overrides and warnings, deferred units and units planned on planned outputs", () => {
    const note = renderPlanNote({
      ...input(),
      overrides: [
        { member: "app", rules: ["no-public"], overriders: ["alice"] },
        { member: "db", rules: ["size"], overriders: [], override: { by: "bob", at: "2026-10-01T00:00:00Z", plan: "p1", reason: "load\ntest" } },
        { member: "net", rules: [], overriders: [] },
      ],
      warnings: [{ member: "app", text: "tags\nmissing" }],
      deferred: [{ unit: "web", after: ["app"], why: "reads its outputs", previewed: true }],
      linked: [{ member: "web", upstream: "app", unknown: ["url"] }],
    }, { words: assertProductWords({ ...TERRAGUCCI, override: 'terragucci override {target} --rule {rule} --reason "<why>" {sign}' }), note: TERRAGUCCI_NOTE });
    expect(note).toContain("**Policy overrides (1 of 3 denied):**\n\n- [`app`](report.html#root-app): denied by `no-public`. alice may override it once a tf-apply wave records the denial: `terragucci override app --rule no-public --reason \"<why>\"`\n- [`db`](report.html#root-db): `size` overridden by bob at 2026-10-01T00:00:00Z, for plan `p1`: load test. tf-apply applies this plan; this run still fails it\n- [`net`](report.html#root-net): denied by its rules. policy.override names nobody who may override it\n");
    expect(note).toContain("**Policy warnings (1), which fail nothing:**\n\n- [`app`](report.html#root-app): tags missing\n");
    expect(note).toContain("- `web` after `app`: reads its outputs (previewed)\n");
    expect(note).toContain("- [`web`](report.html#root-web) reads `app`; `url` known once it applies\n");
  });

  test("diff lines move the change symbol to the first column, and the fence outgrows the text's backticks", () => {
    expect(diffLines(["  ~ a", "  -/+ b", "    c"])).toEqual(["~   a", "-/+   b", "    c"]);
    expect(diffFence(["x ``` y"])).toBe("````diff\nx ``` y\n````\n");
  });
});
