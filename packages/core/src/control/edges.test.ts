/**
 * Cross-stack edges marked stale, current or unknown from the control
 * repo's entries and apply records, and their lines in the note (#4617).
 * Written for the ci-products session; run at epic-ready.
 */

import { describe, expect, test } from "vitest";
import { composeChangeSet } from "../change-set";
import { PR_REPORT_SCHEMA_ID, prOp, renderPrNote, type PrReport } from "../pr-loop";
import { crossStackReadsOf } from "../components/pr-run";
import type { ControlAppliedRecord } from "./applied";
import { markCrossStackEdges, remarkCrossStackEdges, type ControlEdgeFacts } from "./edges";
import type { ControlEntry } from "./records";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function entry(project: string, estates: string[], settings: Record<string, unknown> = {}): ControlEntry {
  return { id: `ctl-${project.length}`, entry: "project", project, settings, estates, digest: "sha256:x", at: "2026-10-01T00:00:00.000Z" };
}

function applied(member: string, at: string): ControlAppliedRecord {
  return { version: 1, kind: "control-applied", member, op: "pulumi-up", sha: SHA, outcome: "applied", at, digest: "sha256:y" };
}

const facts: ControlEdgeFacts = {
  entries: [entry("github.com/acme/network", ["acme/network/prod"]), entry("github.com/acme/shared", ["shared/prod"], { member: "shared-infra" })],
  applies: new Map([
    ["network", applied("network", "2026-10-27T12:00:00.000Z")],
    ["shared-infra", applied("shared-infra", "2026-10-20T12:00:00.000Z")],
  ]),
};

describe("cross-stack edge marks (#4617)", () => {
  test("stale when the owner applied after the reader last updated, current when the reader updated after", () => {
    const edges = markCrossStackEdges(
      [
        { member: "app", stack: "acme/network/prod", lastUpdate: "2026-10-26T00:00:00.000Z" },
        { member: "app", stack: "shared/prod", lastUpdate: "2026-10-26T00:00:00.000Z" },
      ],
      facts,
    );
    expect(edges.map((e) => [e.stack, e.status, e.owner])).toEqual([
      ["acme/network/prod", "stale", "github.com/acme/network"],
      ["shared/prod", "current", "github.com/acme/shared"],
    ]);
    expect(edges[0]!.ownerApplied).toEqual({ at: "2026-10-27T12:00:00.000Z", sha: SHA, outcome: "applied" });
  });

  test("a name with its org matches an estate without one, and the member comes from settings.member or the repository's name", () => {
    const [edge] = markCrossStackEdges([{ member: "app", stack: "acme/shared/prod", lastUpdate: "2026-10-26T00:00:00.000Z" }], facts);
    expect(edge).toMatchObject({ status: "current", owner: "github.com/acme/shared" });
  });

  test("unknown, with why, for every case the facts cannot settle", () => {
    const two: ControlEdgeFacts = { entries: [...facts.entries, entry("github.com/acme/other", ["acme/network/prod"])], applies: facts.applies };
    const none: ControlEdgeFacts = { entries: facts.entries, applies: new Map() };
    const why = (stack: string, f: ControlEdgeFacts | undefined, lastUpdate?: string) => markCrossStackEdges([{ member: "app", stack, ...(lastUpdate ? { lastUpdate } : {}) }], f)[0]!;
    expect(why("acme/network/prod", undefined, "2026-10-26T00:00:00.000Z")).toMatchObject({ status: "unknown", why: "the control repo was not read" });
    expect(why("acme/billing/prod", facts, "2026-10-26T00:00:00.000Z")).toMatchObject({ status: "unknown", why: "no control entry claims the stack" });
    expect(why("acme/network/prod", two, "2026-10-26T00:00:00.000Z").why).toBe("claimed by github.com/acme/network and github.com/acme/other");
    expect(why("acme/network/prod", none, "2026-10-26T00:00:00.000Z")).toMatchObject({ status: "unknown", owner: "github.com/acme/network", why: "the owner has no apply on record" });
    expect(why("acme/network/prod", facts)).toMatchObject({ status: "unknown", why: "the reader has not updated yet" });
  });

  test("a report's own marks never show: they are made again from the facts, or unknown without them", () => {
    const forged = { crossStackEdges: [{ member: "app", stack: "acme/network/prod", lastUpdate: "2026-10-26T00:00:00.000Z", status: "current" as const, why: "trust me" }] };
    expect(remarkCrossStackEdges(forged, facts).crossStackEdges![0]).toMatchObject({ status: "stale" });
    expect(remarkCrossStackEdges(forged, undefined).crossStackEdges![0]).toMatchObject({ status: "unknown", why: "the control repo was not read" });
  });

  test("the reads come from a capability's artifact that lists its outside references", () => {
    const reads = crossStackReadsOf({
      app: { app: { kind: "pulumi-up", stackReferences: { read: [], outside: [{ name: "acme/network/prod", why: "no other pulumi-up step in this project applies that stack" }], lastUpdate: "2026-10-26T00:00:00.000Z" } } },
      net: { net: { kind: "pulumi-up" } },
    });
    expect(reads).toEqual([{ member: "app", stack: "acme/network/prod", lastUpdate: "2026-10-26T00:00:00.000Z" }]);
  });
});

describe("the note's cross-stack table (#4617)", () => {
  const doc = composeChangeSet([]);
  const report: PrReport = {
    $schema: PR_REPORT_SCHEMA_ID,
    contract: 1,
    stage: "plan",
    pr: 7,
    env: "prod",
    base: "1".repeat(40),
    head: "2".repeat(40),
    op: prOp(7),
    gate: "pr-apply",
    digest: doc.digest,
    status: "planned",
    approval: { status: "pending" },
    selection: { changed: ["app"], dependents: [], unclaimed: [], indeterminate: [], waves: [["app"]] },
    members: [],
    changeSet: doc,
    crossStackEdges: markCrossStackEdges([{ member: "app", stack: "acme/network/prod", lastUpdate: "2026-10-26T00:00:00.000Z" }], facts),
  };

  test("lists each edge with its owner and mark, and names the stale ones", () => {
    const note = renderPrNote(report);
    expect(note).toContain("| Reader | Reads stack | Owner | Edge | Why |");
    expect(note).toContain("| `app` | `acme/network/prod` | `github.com/acme/network` | stale |");
    expect(note).toContain("Stale: `app` reads `acme/network/prod`.");
  });

  test("a report with no edges has no table", () => {
    const { crossStackEdges: _drop, ...rest } = report;
    expect(renderPrNote(rest as PrReport)).not.toContain("Reads stack");
  });
});
