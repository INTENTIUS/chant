import { describe, expect, test } from "vitest";
import { detectDrift, lifecycleDiffDigest } from "./lifecycle";
import { declaredDefinitions } from "../../lifecycle/digest";
import { diffLive, missingRow } from "../../lifecycle/live-diff";
import type { ResourceMetadata } from "../../lexicon";

const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

// Renders as `chant lifecycle diff <env> --live` printed them against the sql
// emulator (#3642), bold headers included: the activity reads them off a
// child process, colour and all.
const HEAD = `${BOLD}sql${RESET} — environment: watch\n`;
const CLEAN = `${HEAD}0 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 3 unchanged\n${"-".repeat(80)}\n\u001b[32mNo drift detected across 1 lexicon(s)${RESET}`;
const PROPERTY = `${HEAD}0 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 3 unchanged\n${"-".repeat(80)}\n\n${BOLD}sql (properties)${RESET}\n1 property drift across 1 resource(s), 0 accepted, 2 unchanged\n${"-".repeat(80)}\n${BOLD}\nPROPERTY DRIFT (declared vs live; baseline shown where one exists):${RESET}\n  - events (ClickHouse::Table)\n      ttl: ts + INTERVAL 180 DAY → ts + toIntervalDay(30) [from: authored]`;
const MISSING = `${HEAD}1 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 2 unchanged\n${"-".repeat(80)}\n${BOLD}\nMISSING (declared, provider reports not in cloud):${RESET}\n  - byKind [queried http://127.0.0.1:8123 yodel_3642.by_kind]`;

describe("detectDrift", () => {
  test("a clean render is not drift", () => {
    expect(detectDrift(CLEAN)).toBe(false);
  });

  test("an owned object's property changed out of band is drift (PROPERTY DRIFT)", () => {
    expect(detectDrift(PROPERTY)).toBe(true);
  });

  test("a declared object gone from the server is drift (MISSING)", () => {
    expect(detectDrift(MISSING)).toBe(true);
  });

  test("a privilege an apply would revoke is drift (PENDING, #3706)", () => {
    const pending = `${HEAD}0 missing, 0 orphan, 0 disappeared, 0 newly observed, 0 drifted, 3 unchanged\n${"-".repeat(80)}\n\n${BOLD}sql (properties)${RESET}\n0 property drift across 0 resource(s), 0 accepted, 2 unchanged, 1 pending\n${"-".repeat(80)}\n${BOLD}\nPENDING (changes an apply would make that no declared property shows):${RESET}\n  ~ relation app.orders TO writer: REVOKE INSERT ON TABLE app.orders FROM writer`;
    expect(detectDrift(pending)).toBe(true);
  });

  test("the counts line alone, lower case, is not drift", () => {
    expect(detectDrift("1 property drift across 1 resource(s)")).toBe(false);
  });
});

// #3652: the digest ApplyOp's gate binds is taken over the diff render. A
// create used to be listed by name only, so an approval for "create events"
// stood after `events` was edited. The MISSING row now carries the declared
// definition's fingerprint, and the digest moves with it.
describe("lifecycleDiffDigest over a create (#3652)", () => {
  const env = { env: "dev", live: true };
  const eventsA = { entityType: "ClickHouse::Table", props: { name: "events", columns: { id: { type: "UInt64" } } } };
  const eventsB = {
    entityType: "ClickHouse::Table",
    props: { name: "events", columns: { id: { type: "UInt64" }, kind: { type: "String" } } },
  };

  function render(events: { entityType: string; props: Record<string, unknown> }, live: Record<string, ResourceMetadata> = {}): string {
    const entities = new Map([["events", events]]);
    const diff = diffLive({
      declared: new Set(entities.keys()),
      observedNow: live,
      observedThen: undefined,
      queried: { events: "http://emulator:8123 yodel_3652.events" },
      definitions: declaredDefinitions(entities),
    });
    const rows = diff.missing.map((name) => missingRow(diff, name));
    return `${HEAD}${diff.missing.length} missing\n${rows.length > 0 ? `MISSING (declared, provider reports not in cloud):\n${rows.join("\n")}` : ""}`;
  }

  test("a create of different props is a different plan", () => {
    expect(lifecycleDiffDigest(env, render(eventsA))).not.toBe(lifecycleDiffDigest(env, render(eventsB)));
  });

  test("a create of the same props is the same plan, whatever order the props were written in", () => {
    const reordered = { entityType: "ClickHouse::Table", props: { columns: { id: { type: "UInt64" } }, name: "events" } };
    expect(lifecycleDiffDigest(env, render(eventsA))).toBe(lifecycleDiffDigest(env, render(reordered)));
  });

  test("a create of another type with the same props is a different plan", () => {
    const view = { ...eventsA, entityType: "ClickHouse::View" };
    expect(lifecycleDiffDigest(env, render(eventsA))).not.toBe(lifecycleDiffDigest(env, render(view)));
  });

  test("a no-op prints no definition, so its digest is what it was before #3652 and stable across runs", () => {
    const live = { events: { type: "ClickHouse::Table", status: "present" } as ResourceMetadata };
    const once = render(eventsA, live);
    expect(once).not.toContain("[definition");
    expect(lifecycleDiffDigest(env, once)).toBe(lifecycleDiffDigest(env, render(eventsA, live)));
    // An edit to an object that exists is the deep read's to report, not this row's.
    expect(lifecycleDiffDigest(env, once)).toBe(lifecycleDiffDigest(env, render(eventsB, live)));
  });
});
