/**
 * The writer conformance suite run end to end (#3159): a writer that
 * conforms, with a cache in its state directory, passes every action; a
 * writer that breaks each rule once is caught at the step that broke it. Both
 * run on a workspace generated from the shipped fixtures, at the same time.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  referenceWriter,
  runWorkspaceWriterConformance,
  WRITE_CONTRACT_ACTIONS,
  WRITE_CONTRACT_JSON_FLAGS,
  WRITER_INPUTS,
  WRITER_KINDS,
  WRITER_SCRIPT,
  type ChantTransport,
  type WorkspaceWriterFactory,
  type WriteStep,
} from "./index";

/** One call of the step's command, as a writer makes it. */
const perform = async (chant: ChantTransport, step: WriteStep, extra: string[] = []) => {
  const run = await chant.run(["workspace", ...step.action.split(" "), ...step.args, ...WRITE_CONTRACT_JSON_FLAGS[step.action][0], ...extra], step.input === undefined ? undefined : { input: step.input });
  return JSON.parse(run.stdout) as Record<string, unknown>;
};

/** The reference writer with a cache of its facts in its state directory: rebuilt from chant when it is gone. */
const cachingWriter: WorkspaceWriterFactory = (chant, { stateDir }) => {
  const inner = referenceWriter(chant, { stateDir });
  const cache = join(stateDir, "cache", "facts.json");
  return {
    write: (step) => inner.write(step),
    async facts() {
      if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf-8"));
      const facts = await inner.facts();
      // A cache is private state the suite allows; the suite deletes it for amnesia.
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(stateDir, "cache"), { recursive: true });
      writeFileSync(cache, JSON.stringify(facts));
      return facts;
    },
    holds: () => [
      { record: "fix-002", kind: WRITER_KINDS.decision },
      { run: "writer-run-1" },
      { lease: "W-001", kind: WRITER_KINDS.work },
      { exempt: "cache", what: "cache/facts.json, the facts as last read" },
    ],
  };
};

/** A writer that breaks one rule at each step it performs, and keeps a review only in its own state. */
const leakyWriter: WorkspaceWriterFactory = (chant, { stateDir }) => {
  const reviews = join(stateDir, "reviews.json");
  return {
    async write(step) {
      if (step.id === "decision") return { ...(await perform(chant, step)), note: "the writer's own field" };
      if (step.id === "amend") {
        const doc = await perform(chant, step);
        // A second write the step did not ask for: another decision.
        const extra = WRITER_SCRIPT.find((s) => s.id === "decision")!;
        await chant.run(["workspace", "records", "new", WRITER_KINDS.decision, "--from", "-"], { input: JSON.stringify({ ...(extra.params({}) as { fields: object }).fields, title: "A decision nobody asked for" }) });
        return doc;
      }
      if (step.id === "review") {
        const doc = await perform(chant, step);
        writeFileSync(reviews, JSON.stringify([{ id: doc.id, by: "conformance-reviewer", verdict: "agree" }]));
        writeFileSync(join(stateDir, "notes.txt"), "kept and not declared");
        return doc;
      }
      if (step.id === "answer") return perform(chant, step, ["--dry-run"]);
      return perform(chant, step);
    },
    async facts() {
      // A write made while reading: refused by chant, still not a read.
      await chant.run(["workspace", "runs", "start", "--from", "-"], { input: "{}" });
      return { reviews: existsSync(reviews) ? JSON.parse(readFileSync(reviews, "utf-8")) : [] };
    },
    holds: () => [
      { record: "fix-999", kind: WRITER_KINDS.decision },
      { exempt: "database" as never, what: "events" },
    ],
  };
};

describe("the writer conformance suite (#3159)", () => {
  test.concurrent("a writer that writes only through chant passes every action, the amnesia test and its holdings", async () => {
    const report = await runWorkspaceWriterConformance(cachingWriter, { privateState: [{ path: "cache", is: "cache" }] });
    expect(report.problems).toEqual([]);
    expect(report.checked).toEqual([...WRITE_CONTRACT_ACTIONS]);
    expect(report.skipped).toEqual([]);
    expect(report.results.map((r) => [r.id, r.by])).toEqual(WRITER_SCRIPT.map((s) => [s.id, "writer"]));
    expect(report.facts.after).toEqual(report.facts.before);
    expect(report.facts.before).toMatchObject({
      decision: [["fix-001", "decided"], ["fix-002", "proposed"]],
      session: [["S-0001", "closed"]],
      answer: [[expect.stringMatching(/^slice-tier-/), "answered"]],
      work: [["W-001", "open"]],
      runs: [["conformance-run", "ended"], ["writer-run-1", "ended"], ["writer-run-2", "ended"]],
      // #3308: the box's listing, set through chant with its cover copied in, survives amnesia.
      listing: {
        app: {
          published: true,
          title: "The writer suite's box",
          line: "Listed through chant, read back after amnesia.",
          cover: { path: "app/listing/cover.png", sha256: createHash("sha256").update(WRITER_INPUTS.cover.bytes).digest("hex") },
        },
      },
    });
  }, 900_000);

  test.concurrent("a writer that breaks the rules is caught at each step and after", async () => {
    const report = await runWorkspaceWriterConformance(leakyWriter, {
      actions: ["records new", "records amend", "records review", "points answer"],
      privateState: [{ path: "reviews.json", is: "cache" }],
    });
    expect(report.checked).toEqual(["records new", "records amend", "records review", "points answer"]);
    const by = Object.fromEntries(report.results.map((r) => [r.id, r]));
    expect(by.claim.by).toBe("suite");
    expect(by.listing).toMatchObject({ by: "suite", problems: [] });
    expect(by.session.problems).toEqual([]);
    expect(by.decision.problems).toEqual(["decision (records new): the writer must return the document chant printed, unchanged, and it returned something else"]);
    expect(by.amend.problems).toHaveLength(2);
    expect(by.amend.problems[0]).toMatch(/^amend \(records amend\): made 2 chant calls .* expected exactly one$/);
    expect(by.amend.problems[1]).toMatch(/^amend \(records amend\): files changed that chant did not report writing: decisions\/fix-003-a-decision-nobody-asked-for\.md \(added\)$/);
    expect(by.review.problems).toEqual([]);
    expect(by.answer.problems).toEqual([expect.stringMatching(/^answer \(points answer\): .* it may add only nothing or --json, and it added --dry-run$/)]);
    expect(report.after.facts).toEqual([
      "facts: before amnesia, facts() made calls outside the read contract: workspace runs start --from -",
      "facts: after amnesia, facts() made calls outside the read contract: workspace runs start --from -",
    ]);
    expect(report.after.state).toEqual(["state: the writer keeps notes.txt in its state directory, and privateState does not declare it"]);
    expect(report.after.amnesia).toEqual([expect.stringMatching(/^amnesia: after its private state was deleted, the writer shows other facts; before: \{"reviews":\[\{"id":"fix-002".*after: \{"reviews":\[\]\}$/)]);
    expect(report.after.holds).toEqual([
      "holds: the writer holds record fix-999 of decisions/decision.kind.mjs, which the repository does not have",
      'holds: events is held as "database"; outside the repo a tool keeps only cache, telemetry, secret, runtime (ws-074)',
    ]);
    expect(report.after.readBack).toEqual([]);
  }, 900_000);
});
