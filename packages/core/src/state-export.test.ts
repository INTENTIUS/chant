/**
 * #4762: the engine-neutral state export, on an in-memory version source and
 * an in-memory gated-request ledger. Nothing reaches a store or git.
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fakeLedger } from "./__fixtures__/gated-ledger";
import { exportStateVersion, exportRefusal, STATE_EXPORT_FLOOR, StateExportError, type StateVersionSource } from "./state-export";

const NO_CI = {};

function source(versions: Record<string, string>, current?: string): StateVersionSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    location: "s3://states/net.tfstate",
    reads,
    current: async () => (current ? { exists: true, versionId: current } : Object.keys(versions).length ? { exists: true, off: "bucket versioning is off" } : { exists: false }),
    hasVersion: async (id) => id in versions,
    readVersion: async (id) => {
      reads.push(id);
      return versions[id];
    },
  };
}

const outside = (): string => mkdtempSync(join(tmpdir(), "chant-export-test-"));

const base = (ledger: ReturnType<typeof fakeLedger>, src: StateVersionSource, extra: Record<string, unknown> = {}) => ({
  subject: "net",
  by: "ana",
  source: src,
  words: { op: "tf-state-export", approveCommand: (s: string, d: string) => `product approve export ${s} --plan ${d}` },
  rules: { mode: "ledger" as const },
  ledger,
  env: NO_CI,
  now: "2026-11-08T09:00:00Z",
  ...extra,
});

describe("exportStateVersion", () => {
  test("asks without reading the state, then writes the approved version once, mode 0600, and records its digest", async () => {
    const ledger = fakeLedger();
    const src = source({ v1: '{"serial":1}', v2: '{"serial":2}' }, "v2");
    const out = join(outside(), "net.tfstate");
    const first = await exportStateVersion(base(ledger, src, { out }));
    expect(first).toMatchObject({ status: "waiting", exit: 3, version: "v2", location: "s3://states/net.tfstate" });
    expect(first.status === "waiting" && first.command).toBe(`product approve export net --plan ${first.digest}`);
    expect(src.reads).toEqual([]);

    ledger.approve("bo");
    const second = await exportStateVersion(base(ledger, src, { out, now: "2026-11-08T12:00:00Z" }));
    expect(second).toMatchObject({ status: "written", exit: 0, file: out, version: "v2", approvedBy: "bo", digest: first.digest });
    expect(readFileSync(out, "utf-8")).toBe('{"serial":2}');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(ledger.writes).toEqual(["pending", "applied", "finished:applied"]);
    expect(ledger.details[0]).toMatchObject({ by: "ana", version_id: "v2", approved_by: "bo", location: "s3://states/net.tfstate" });
    expect(String(ledger.details[0]!.content_digest)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(ledger.details)).not.toContain("serial");

    const third = await exportStateVersion(base(ledger, src, { out: join(outside(), "again.tfstate") }));
    expect(third).toMatchObject({ status: "spent", exit: 1 });
    expect(src.reads).toEqual(["v2"]);
  });

  test("an approval by the requester does not count", async () => {
    const ledger = fakeLedger();
    ledger.approve("ana");
    const r = await exportStateVersion(base(ledger, source({ v1: "{}" }, "v1"), { out: join(outside(), "s") }));
    expect(r).toMatchObject({ status: "refused", exit: 3 });
  });

  test("with no destination the file goes to a new private directory, named by the product", async () => {
    const ledger = fakeLedger();
    ledger.approve("bo");
    const r = await exportStateVersion(base(ledger, source({ "v/1": "{}" }), { version: "v/1", words: { op: "tf-state-export", fileName: (s: string, v: string) => `${s}.${v.replace("/", "_")}.tfstate`, tmpPrefix: "product-export-" } }));
    expect(r.status).toBe("written");
    if (r.status !== "written") return;
    expect(r.file).toMatch(/product-export-[^/]+\/net\.v_1\.tfstate$/);
  });

  test("refuses a version the store does not keep, a store with no versions, and no state, before asking", async () => {
    const ledger = fakeLedger();
    await expect(exportStateVersion(base(ledger, source({ v1: "{}" }), { version: "v9" }))).rejects.toThrow(/has no version v9/);
    await expect(exportStateVersion(base(ledger, source({ v1: "{}" })))).rejects.toThrow(/keeps no versions.*bucket versioning is off/);
    await expect(exportStateVersion(base(ledger, source({})))).rejects.toThrow(/holds no state/);
    expect(ledger.writes).toEqual([]);
  });

  test("refuses a CI job, a destination inside a git working tree, and a file that is there", async () => {
    const ledger = fakeLedger();
    const src = source({ v1: "{}" }, "v1");
    await expect(exportStateVersion(base(ledger, src, { env: { GITLAB_CI: "true" } }))).rejects.toThrow(/GITLAB_CI is set/);
    const repo = outside();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "sub"));
    await expect(exportStateVersion(base(ledger, src, { out: join(repo, "sub", "net.tfstate") }))).rejects.toBeInstanceOf(StateExportError);
    expect(exportRefusal(join(repo, "sub", "net.tfstate"))).toMatch(/inside the git working tree/);
    const there = join(outside(), "there");
    writeFileSync(there, "x");
    await expect(exportStateVersion(base(ledger, src, { out: there }))).rejects.toThrow(/never writes over a file/);
    const ok = await exportStateVersion(base(ledger, src, { env: { GITLAB_CI: "true" }, allowCi: true, out: join(outside(), "ci") }));
    expect(ok.status).toBe("waiting");
  });

  test("a version deleted while the request waited fails the request, and writes nothing", async () => {
    const ledger = fakeLedger();
    const versions: Record<string, string> = { v1: "{}" };
    const src = source(versions, "v1");
    const out = join(outside(), "gone");
    await exportStateVersion(base(ledger, src, { out }));
    ledger.approve("bo");
    delete versions.v1;
    src.hasVersion = async () => true;
    const r = await exportStateVersion(base(ledger, src, { out, version: "v1" }));
    expect(r).toMatchObject({ status: "failed", exit: 1 });
    expect(ledger.writes.at(-1)).toBe("finished:failed");
  });

  test("its floor is the next release", () => {
    expect(STATE_EXPORT_FLOOR).toBe("0.124.77");
  });
});
