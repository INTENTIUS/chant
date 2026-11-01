/**
 * A component a release leaves alone (#4695): its declared inputs compared with
 * the release the environment runs it from.
 */
import { describe, test, expect } from "vitest";
import { compareInputs, unchangedRecord, type ChangedPaths } from "./unchanged-inputs";
import { makeRelease, type Release } from "../lifecycle/release-store";
import type { ReleaseRecord } from "../lifecycle/release-ledger";

const release = (commit: string, opts: { region?: string; template?: string } = {}): Release =>
  makeRelease({
    member: null,
    commit: commit.repeat(40),
    artifactDigests: [],
    targets: [
      {
        env: "prod",
        templates: [{ component: "control", path: "dist/fly.json", digest: opts.template ?? "sha256:fly" }],
        params: [{ name: "region", value: opts.region ?? "ewr", source: "default" }],
      },
    ],
  });

const before = release("a");
const record = (over: Partial<ReleaseRecord> = {}): ReleaseRecord => ({
  version: 1,
  component: "control",
  env: "prod",
  digest: "sha256:image",
  gitSha: "a".repeat(40),
  runId: "run-1",
  timestamp: "2026-11-01T10:00:00.000Z",
  actor: "ci",
  releaseDigest: before.releaseDigest,
  ...over,
});

const noChange: ChangedPaths = () => [];
const compare = (now: Release, opts: { current?: ReleaseRecord | undefined; changedPaths?: ChangedPaths; params?: string[]; stored?: Release[] } = {}) =>
  compareInputs({
    component: "control",
    inputs: { paths: ["../crates/control"], params: opts.params ?? ["region"] },
    env: "prod",
    release: now,
    current: "current" in opts ? opts.current : record(),
    readRelease: async (d) => (opts.stored ?? [before]).find((r) => r.releaseDigest === d) ?? null,
    changedPaths: opts.changedPaths ?? noChange,
  });

describe("compareInputs", () => {
  test("unchanged when the paths, the params and the deploy files are the same", async () => {
    const seen: unknown[] = [];
    const verdict = await compare(release("b"), { changedPaths: (from, to, paths) => (seen.push([from, to, paths]), []) });
    expect(verdict).toEqual({ unchanged: true, since: record(), recorded: false });
    expect(seen).toEqual([["a".repeat(40), "b".repeat(40), ["../crates/control"]]]);
  });

  test("a changed path, param or deploy file deploys it, and says which", async () => {
    expect(await compare(release("b"), { changedPaths: () => ["crates/control/src/main.rs"] })).toEqual({
      unchanged: false,
      reason: expect.stringMatching(/1 input file\(s\) changed since a{12}, such as crates\/control\/src\/main\.rs/),
    });
    expect(await compare(release("b", { region: "iad" }))).toEqual({ unchanged: false, reason: 'param region is "iad", was "ewr"' });
    expect(await compare(release("b", { template: "sha256:other" }))).toEqual({ unchanged: false, reason: expect.stringMatching(/the files its deploy reads in the "prod" target changed/) });
  });

  test("anything it can't compare deploys it", async () => {
    expect(await compare(release("b"), { current: undefined })).toMatchObject({ unchanged: false, reason: '"prod" has no deploy of it' });
    expect(await compare(release("b"), { current: record({ releaseDigest: undefined }) })).toMatchObject({ unchanged: false, reason: expect.stringMatching(/was not made from a release/) });
    expect(await compare(release("b"), { stored: [] })).toMatchObject({ unchanged: false, reason: expect.stringMatching(/is not stored here/) });
    expect(await compare(release("b"), { changedPaths: () => null })).toMatchObject({ unchanged: false, reason: expect.stringMatching(/git can't compare/) });
    const none = await compareInputs({ component: "control", inputs: {}, env: "prod", release: release("b"), current: record(), readRelease: async () => before, changedPaths: noChange });
    expect(none).toMatchObject({ unchanged: false });
  });

  test("a record that already names this release is unchanged, with nothing new to record", async () => {
    expect(await compare(before)).toEqual({ unchanged: true, since: record(), recorded: true });
  });
});

describe("unchangedRecord", () => {
  test("repeats the deploy that stays, under this release, naming it in unchangedSince", () => {
    const since = record({ manifestDigest: "sha256:m", approver: "bob", admission: { op: "control", gate: "prod-release", resolvedAt: "2026-11-01T09:00:00.000Z" } });
    const now = release("b");
    expect(unchangedRecord(since, { releaseDigest: now.releaseDigest, runId: "run-2", timestamp: "2026-11-02T10:00:00.000Z", actor: "ci" })).toEqual({
      component: "control",
      env: "prod",
      digest: "sha256:image",
      gitSha: "a".repeat(40),
      manifestDigest: "sha256:m",
      runId: "run-2",
      timestamp: "2026-11-02T10:00:00.000Z",
      actor: "ci",
      releaseDigest: now.releaseDigest,
      unchangedSince: { env: "prod", runId: "run-1", timestamp: "2026-11-01T10:00:00.000Z" },
    });
  });
});
