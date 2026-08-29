import { describe, test, expect } from "vitest";
import {
  annotateDisruption,
  disruptionNotices,
  summarizeDisruption,
  worstDisruption,
  type DisruptionClassifier,
} from "./disruption";
import { renderChangeSet, type ChangeSet, type ChangeSetEntry } from "./change-set";

function entry(overrides: Partial<ChangeSetEntry> = {}): ChangeSetEntry {
  return {
    name: "db",
    type: "AWS::RDS::DBInstance",
    lexicon: "aws",
    action: "update",
    evidence: { declared: true, inSnapshot: true, live: true, observed: true },
    deltas: [{ path: "attributes.Engine", oldValue: "postgres", newValue: "mysql" }],
    ownership: "unknown",
    ...overrides,
  };
}

function set(entries: ChangeSetEntry[]): ChangeSet {
  return { env: "prod", entries };
}

describe("annotateDisruption (#1665)", () => {
  test("no classifier degrades every update to unknown, never in-place", async () => {
    const out = await annotateDisruption(set([entry()]), "prod", undefined);
    expect(out.entries[0].disruption).toBe("unknown");
    expect(out.entries[0].disruptionDetail).toContain("aws lexicon does not classify disruption");
  });

  test("a lexicon's verdict rides the entry", async () => {
    const classify: DisruptionClassifier = () => ({
      db: { disruption: "replace", because: ["attributes.Engine"], detail: "Engine is create-only" },
    });
    const out = await annotateDisruption(set([entry()]), "prod", classify);
    expect(out.entries[0]).toMatchObject({
      disruption: "replace",
      disruptionBecause: ["attributes.Engine"],
      disruptionDetail: "Engine is create-only",
    });
  });

  test("a name the classifier said nothing about is unknown", async () => {
    const classify: DisruptionClassifier = () => ({});
    const out = await annotateDisruption(set([entry()]), "prod", classify);
    expect(out.entries[0].disruption).toBe("unknown");
    expect(out.entries[0].disruptionDetail).toContain("returned no verdict");
  });

  // The guard that makes `in-place` trustworthy: a lexicon cannot smuggle a
  // level in that core does not recognise, and a bogus one is never treated as
  // the safe end of the scale.
  test("a level outside the vocabulary is rejected into unknown", async () => {
    const classify = (() => ({
      db: { disruption: "totally-fine", detail: "trust me" },
    })) as unknown as DisruptionClassifier;
    const out = await annotateDisruption(set([entry()]), "prod", classify);
    expect(out.entries[0].disruption).toBe("unknown");
    expect(out.entries[0].disruptionDetail).toContain("totally-fine");
  });

  test("a classifier that throws leaves unknown, and the plan survives", async () => {
    const classify: DisruptionClassifier = () => {
      throw new Error("registry missing");
    };
    const out = await annotateDisruption(set([entry()]), "prod", classify);
    expect(out.entries[0].disruption).toBe("unknown");
    expect(out.entries[0].disruptionDetail).toContain("registry missing");
  });

  test("an async classifier is awaited", async () => {
    const classify: DisruptionClassifier = async () => ({
      db: { disruption: "in-place", detail: "no create-only property changed" },
    });
    const out = await annotateDisruption(set([entry()]), "prod", classify);
    expect(out.entries[0].disruption).toBe("in-place");
  });

  test("only update entries are classified", async () => {
    const classify: DisruptionClassifier = ({ changes }) => {
      expect(changes.map((c) => c.name)).toEqual(["db"]);
      return { db: { disruption: "destroy" } };
    };
    const out = await annotateDisruption(
      set([
        entry(),
        entry({ name: "bucket", action: "create", deltas: undefined }),
        entry({ name: "queue", action: "delete", deltas: undefined }),
      ]),
      "prod",
      classify,
    );
    const byName = Object.fromEntries(out.entries.map((e) => [e.name, e]));
    expect(byName.db.disruption).toBe("destroy");
    expect(byName.bucket.disruption).toBeUndefined();
    expect(byName.queue.disruption).toBeUndefined();
  });

  test("a set with no updates is returned untouched, and no classifier is called", async () => {
    let called = false;
    const cs = set([entry({ action: "noop", deltas: undefined })]);
    const out = await annotateDisruption(cs, "prod", () => {
      called = true;
      return {};
    });
    expect(out).toBe(cs);
    expect(called).toBe(false);
  });

  test("the input change set is not mutated", async () => {
    const cs = set([entry()]);
    await annotateDisruption(cs, "prod", () => ({ db: { disruption: "replace" } }));
    expect(cs.entries[0].disruption).toBeUndefined();
  });
});

describe("summaries and notices", () => {
  const classified = set([
    entry({ name: "db", disruption: "destroy" }),
    entry({ name: "sg", disruption: "replace" }),
    entry({ name: "tags", disruption: "in-place" }),
    entry({ name: "mystery", disruption: "unknown" }),
    entry({ name: "bucket", action: "noop", disruption: undefined, deltas: undefined }),
  ]);

  test("summarizeDisruption counts update entries only", () => {
    expect(summarizeDisruption(classified)).toEqual({
      "in-place": 1,
      rolling: 0,
      replace: 1,
      destroy: 1,
      unknown: 1,
    });
  });

  test("worstDisruption ranks unknown above every confident verdict", () => {
    expect(worstDisruption(classified)).toBe("unknown");
    expect(worstDisruption(set([entry({ disruption: "in-place" })]))).toBe("in-place");
    expect(worstDisruption(set([entry({ action: "noop", disruption: undefined })]))).toBeUndefined();
  });

  test("notices name the replacing and the unclassified rows", () => {
    const notices = disruptionNotices(classified);
    expect(notices[0]).toContain("2 update(s) replace the resource");
    expect(notices[0]).toContain("1 of them by deleting it first");
    expect(notices[1]).toContain("1 update(s) could not be classified");
  });

  test("a clean plan produces no notices", () => {
    expect(disruptionNotices(set([entry({ disruption: "in-place" })]))).toEqual([]);
  });
});

describe("renderChangeSet with disruption", () => {
  test("the header, the row, and the forcing delta all say it", () => {
    const out = renderChangeSet(
      set([
        entry({
          disruption: "replace",
          disruptionBecause: ["attributes.Engine"],
          disruptionDetail: "Engine is create-only",
          deltas: [
            { path: "attributes.Engine", oldValue: "postgres", newValue: "mysql" },
            { path: "attributes.AllocatedStorage", oldValue: 20, newValue: 40 },
          ],
        }),
      ]),
    );
    expect(out).toContain("Disruption: 1 replace");
    expect(out).toContain("UPDATE (disruption from the lexicon that owns the spec");
    expect(out).toContain("db (AWS::RDS::DBInstance) — replace: Engine is create-only");
    expect(out).toContain("! attributes.Engine:");
    expect(out).toContain("  attributes.AllocatedStorage:");
    expect(out).not.toContain("! attributes.AllocatedStorage");
  });

  test("an unclassified plan renders the plain UPDATE header", () => {
    const out = renderChangeSet(set([entry({ disruption: undefined })]));
    expect(out).toContain("\nUPDATE:");
    expect(out).not.toContain("Disruption:");
  });
});
