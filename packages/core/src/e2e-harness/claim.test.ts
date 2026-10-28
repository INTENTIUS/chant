/**
 * The claim row protocol and the no-real-cloud wrapper (chant#4587): a row
 * from a run's verdicts, the run as an e2e-claim ledger record (#4551), the
 * per-product render, the engine-version rule, and recording refused
 * without a CLEAN scan. The wrapper's own runs are `node -e` one-liners.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { OpRunRecord, OpRunRecordInput } from "../op/runtime";
import { CLAIM_OP, claimRow, claimRowsOf, claimRunRecordInput, renderClaims, rowCountsFor } from "./claim";
import type { ArmRun, ClaimRun } from "./driver";
import { FLOCI_DIGEST } from "./pins";
import { SafeRun, backendIsLocal, realCloudHits, recordClaimRow, safeRunEnv } from "./safe-run";
import type { ClaimRow } from "./schemas/index";

const tmp = mkdtempSync(join(tmpdir(), "chant-e2e-claim-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const COMMIT = "e962b2c0000000000000000000000000000000aa";
const scenario = { id: "tg-estate-overlap", product: "terragucci", claim: "choudoufu/rows-overlap" };

const arm = (a: "plain" | "break", outcome: ArmRun["outcome"]): ArmRun => ({
  scenario: scenario.id,
  arm: a,
  outcome,
  started: a === "plain" ? "2026-10-28T10:00:00.000Z" : "2026-10-28T10:05:00.000Z",
  ended: a === "plain" ? "2026-10-28T10:04:00.000Z" : "2026-10-28T10:09:00.000Z",
  steps: [
    { id: "one", do: "open", pull: 1 },
    ...(outcome === "held" ? [] : [{ id: "one-apply", do: "apply" as const, stopped: { outcome: outcome as "broke", reason: "a is failed, not applied" } }]),
  ],
});

const run: ClaimRun = { plain: arm("plain", "held"), break: arm("break", "broke"), verdicts: { plain: "pass", break: "caught" } };

const rowAt = (date: string, over: Partial<Parameters<typeof claimRow>[0]> = {}): ClaimRow =>
  claimRow({ scenario, productCommit: COMMIT, engine: { binary: "choudoufu", version: "0.31.0" }, verdicts: run.verdicts, at: new Date(`${date}T10:09:00Z`), ...over });

const record = (input: OpRunRecordInput, id: string): OpRunRecord => ({ version: 1, id, ...input });

describe("the claim row", () => {
  test("names the scenario's product and claim, the run's date and the harness's floci pin", () => {
    const r = rowAt("2026-10-28");
    expect(r).toMatchObject({ product: "terragucci", scenario: "tg-estate-overlap", claim: "choudoufu/rows-overlap", date: "2026-10-28", floci: FLOCI_DIGEST, plain: "pass", break: "caught", safeRun: "CLEAN" });
    expect(() => rowAt("2026-10-28", { productCommit: "e962b2c" })).toThrow(/not e2e-claim-row\/v1/);
  });

  test("is the claim outcome of an e2e-claim run record, one phase per arm", () => {
    const input = claimRunRecordInput({ row: rowAt("2026-10-28"), run, env: "local", gitSha: COMMIT });
    expect(input.op).toBe(CLAIM_OP);
    expect(input.status).toBe("ok");
    expect(input.labels).toEqual({ Product: "terragucci", Scenario: "tg-estate-overlap", Claim: "choudoufu/rows-overlap" });
    expect(input.started).toBe(run.plain.started);
    expect(input.ended).toBe(run.break.ended);
    expect(input.phases.map((p) => [p.name, p.status])).toEqual([
      ["plain", "ok"],
      ["break", "fail"],
    ]);
    expect(input.phases[1]!.steps.at(-1)).toMatchObject({ fn: "apply:one-apply", status: "fail", error: "broke: a is failed, not applied" });
    expect(input.outcomes.claim).toEqual(rowAt("2026-10-28"));

    const missed = claimRunRecordInput({ row: { ...rowAt("2026-10-28"), break: "missed" }, run });
    expect(missed.status).toBe("fail");
  });

  test("renders a product's newest row per scenario and claim, from the ledger's records", () => {
    const old = rowAt("2026-10-20", { verdicts: { plain: "fail", break: "caught" } });
    const now = rowAt("2026-10-28");
    const other = claimRow({ scenario: { ...scenario, id: "tg-migrate", claim: "choudoufu/7" }, productCommit: COMMIT, engine: { binary: "choudoufu", version: "0.31.0" }, verdicts: run.verdicts, at: new Date("2026-10-27T00:00:00Z") });
    const foreign = claimRow({ scenario: { ...scenario, product: "plywood", id: "pw-disjoint" }, productCommit: COMMIT, engine: { binary: "plunge", version: "0.9.0" }, verdicts: run.verdicts, at: new Date("2026-10-27T00:00:00Z") });
    const records = [
      record({ ...claimRunRecordInput({ row: now, run }), ended: "2026-10-28T10:09:00.000Z" }, "c"),
      record({ ...claimRunRecordInput({ row: old, run }), ended: "2026-10-20T10:09:00.000Z" }, "a"),
      record({ ...claimRunRecordInput({ row: other, run }), ended: "2026-10-27T00:00:00.000Z" }, "b"),
      record({ ...claimRunRecordInput({ row: foreign, run }), ended: "2026-10-27T00:00:00.000Z" }, "d"),
      record({ op: "pr-apply", env: "local", started: "", ended: "2026-10-29T00:00:00.000Z", status: "ok", labels: {}, outcomes: { claim: now }, phases: [] }, "e"),
      record({ op: CLAIM_OP, env: "local", started: "", ended: "2026-10-29T00:00:00.000Z", status: "ok", labels: {}, outcomes: { claim: { not: "a row" } }, phases: [] }, "f"),
    ];
    const rows = claimRowsOf(records);
    expect(rows).toHaveLength(4);
    const doc = renderClaims("terragucci", rows);
    expect(doc.product).toBe("terragucci");
    expect(doc.rows.map((r) => [r.scenario, r.date, r.plain])).toEqual([
      ["tg-estate-overlap", "2026-10-28", "pass"],
      ["tg-migrate", "2026-10-27", "pass"],
    ]);
  });

  test("counts for an engine claim only at the version the row ran, and only when it holds", () => {
    const r = rowAt("2026-10-28");
    expect(rowCountsFor(r, { binary: "choudoufu", version: "v0.31.0" })).toBe(true);
    expect(rowCountsFor(r, { binary: "choudoufu", version: "0.28.0" })).toBe(false);
    expect(rowCountsFor(r, { binary: "plunge", version: "0.31.0" })).toBe(false);
    expect(rowCountsFor({ ...r, break: "missed" }, { binary: "choudoufu", version: "0.31.0" })).toBe(false);
  });
});

describe("the no-real-cloud wrapper", () => {
  test("scrubs every cloud variable and sets floci's test keys, empty config and a file backend", () => {
    const env = safeRunEnv(
      { scratch: join(tmp, "env"), extra: { BREAK: "1" } },
      { PATH: "/usr/bin", AWS_PROFILE: "prod", AWS_SESSION_TOKEN: "x", GOOGLE_APPLICATION_CREDENTIALS: "/k.json", ARM_CLIENT_SECRET: "s", CLOUDSDK_CORE_PROJECT: "p", PULUMI_ACCESS_TOKEN: "pul-x" },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.BREAK).toBe("1");
    for (const k of ["AWS_PROFILE", "AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "ARM_CLIENT_SECRET", "CLOUDSDK_CORE_PROJECT", "PULUMI_ACCESS_TOKEN"]) expect(env[k], k).toBeUndefined();
    expect(env).toMatchObject({ AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", AWS_REGION: "us-east-1", GCE_METADATA_HOST: "127.0.0.1:9", PULUMI_SKIP_UPDATE_CHECK: "true" });
    expect(env.PULUMI_BACKEND_URL).toMatch(/^file:\/\//);
    expect(readFileSync(env.AWS_SHARED_CREDENTIALS_FILE!, "utf8")).toBe("");
    expect(env.CLOUDSDK_CONFIG!.startsWith(join(tmp, "env"))).toBe(true);
  });

  test("refuses a credentials file and a backend that is not local", () => {
    expect(() => safeRunEnv({ scratch: join(tmp, "x"), extra: { GOOGLE_APPLICATION_CREDENTIALS: "/k.json" } }, {})).toThrow(/refused/);
    expect(() => safeRunEnv({ scratch: join(tmp, "x") }, { PULUMI_BACKEND_URL: "https://api.pulumi.com" })).toThrow(/not a local backend/);
    expect(safeRunEnv({ scratch: join(tmp, "x") }, { PULUMI_BACKEND_URL: "file:///tmp/s" }).PULUMI_BACKEND_URL).toBe("file:///tmp/s");
    expect(backendIsLocal("plunge+s3://b?endpoint=http://127.0.0.1:4566")).toBe(true);
    expect(backendIsLocal("plunge+s3://b?region=us-east-1")).toBe(false);
  });

  test("finds what a real cloud says to a fake credential, and nothing an emulator says", () => {
    expect(realCloudHits("ok\nAn error occurred (InvalidClientTokenId) when calling GetCallerIdentity\n")).toEqual(["log:2:An error occurred (InvalidClientTokenId) when calling GetCallerIdentity"]);
    expect(realCloudHits("401 Unauthorized from https://sts.amazonaws.com/")).toHaveLength(1);
    expect(realCloudHits("401 from http://floci:4566/\nstack applied in 4012ms")).toEqual([]);
  });

  test("a run whose log shows a real cloud is not recorded; a CLEAN one is, as an e2e-claim record", async () => {
    const dirty = new SafeRun({ scratch: join(tmp, "dirty") });
    expect(await dirty.run([process.execPath, "-e", "console.log('UnrecognizedClientException: The security token included in the request is invalid')"])).toBe(0);
    const v = dirty.scan();
    expect(v.verdict).toBe("REAL-CLOUD");
    const appended: OpRunRecordInput[] = [];
    await expect(recordClaimRow({ row: rowAt("2026-10-28"), run, verdict: v, append: async (i) => void appended.push(i) })).rejects.toThrow(/refusing to record tg-estate-overlap/);
    expect(appended).toEqual([]);

    const clean = new SafeRun({ scratch: join(tmp, "clean"), scan: [join(tmp, "clean")] });
    expect(await clean.run([process.execPath, "-e", "process.exit(3)"])).toBe(3);
    expect(await clean.outOfBand().run([process.execPath, "-e", "console.log(process.env.AWS_ACCESS_KEY_ID)"])).toBe(0);
    expect(readFileSync(clean.logFile, "utf8")).toContain("\ntest\n");
    const ok = clean.scan();
    expect(ok).toEqual({ verdict: "CLEAN" });
    await recordClaimRow({ row: rowAt("2026-10-28"), run, verdict: ok, append: async (i) => void appended.push(i) });
    expect(appended.map((a) => a.op)).toEqual([CLAIM_OP]);

    const missing = new SafeRun({ scratch: join(tmp, "missing"), scan: [join(tmp, "no-such-dir")] });
    expect(missing.scan().verdict).toBe("REAL-CLOUD");
  });
});
