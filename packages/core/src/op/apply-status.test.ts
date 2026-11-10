/**
 * #4987: the apply status after each wave, from the wave jobs' outcome
 * files: pending until the last wave's success, pending (failed on GitLab)
 * while a run waits, failed when one failed, and nothing for a wave that
 * wrote no outcome.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ForgeStatus } from "../pr-forge";
import { parseArgs } from "../cli/parse-args";
import { applyStatusCommand, applyStatusJobName, opWaveApplyStatus, postOpWaveApplyStatus } from "./apply-status";

type Status = "applied" | "unchanged" | "failed" | "waiting" | "blocked";

/** A directory of outcome files, one per wave: wave -> member -> status. */
function outcomes(waves: Record<number, Record<string, Status>>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-apply-status-"));
  for (const [wave, members] of Object.entries(waves)) {
    const sub = join(dir, `tf-apply-wave-${wave}-outcome`);
    mkdirSync(sub, { recursive: true });
    const doc = { version: 1, wave: Number(wave), at: `2026-11-10T00:00:0${wave}Z`, members: Object.fromEntries(Object.entries(members).map(([m, status]) => [m, { status }])) };
    writeFileSync(join(sub, `outcome-wave-${wave}.json`), JSON.stringify(doc));
  }
  return dir;
}

describe("the apply status after a wave (#4987)", () => {
  test("pending after each wave that applied, and the one success after the last", () => {
    const dir = outcomes({ 1: { dev: "applied" }, 2: { prod: "unchanged" } });
    expect(opWaveApplyStatus([dir], 1, 2, "github")).toEqual({ state: "running", description: "wave 1 of 2 applied" });
    expect(opWaveApplyStatus([dir], 2, 2, "github")).toEqual({ state: "success", description: "all 2 waves applied" });
    expect(opWaveApplyStatus([outcomes({ 1: { dev: "applied" } })], 1, 1, "forgejo")).toEqual({ state: "success", description: "the wave applied" });
  });

  test("a wave that waits is pending on GitHub and Forgejo and failed on GitLab", () => {
    const dir = outcomes({ 1: { dev: "applied" }, 2: { prod: "waiting" } });
    expect(opWaveApplyStatus([dir], 2, 3, "github")).toEqual({ state: "running", description: "wave 2 of 3 waits for an approval" });
    expect(opWaveApplyStatus([dir], 2, 3, "gitlab")).toEqual({ state: "failed", description: "wave 2 of 3 waits for an approval" });
  });

  test("a failed run fails the status, and the waves after it carry the failure", () => {
    const dir = outcomes({ 1: { dev: "failed", qa: "applied" }, 2: { prod: "blocked" } });
    expect(opWaveApplyStatus([dir], 1, 2, "github")).toEqual({ state: "failed", description: "wave 1 of 2: 1 applied, 1 failed" });
    expect(opWaveApplyStatus([dir], 2, 2, "github")).toEqual({ state: "failed", description: "wave 2 of 2: 1 applied, 1 blocked, 1 failed" });
  });

  test("a wave that wrote no outcome posts nothing", async () => {
    const dir = outcomes({ 1: { dev: "applied" } });
    expect(opWaveApplyStatus([dir], 2, 2, "github")).toBeUndefined();
    const posted: ForgeStatus[] = [];
    const line = await postOpWaveApplyStatus({ forge: { kind: "github", setStatus: async (_sha, s) => void posted.push(s) }, dirs: [dir], wave: 2, of: 2, context: "terragucci/apply", at: "a".repeat(40) });
    expect(posted).toEqual([]);
    expect(line).toBe("wave 2 of 2 wrote no outcome, so terragucci/apply stays as the wave before it left it");
  });

  test("posts on the commit the waves applied, linked to the run, with GitLab's pipeline", async () => {
    const dir = outcomes({ 1: { dev: "applied" } });
    const posted: Array<[string, ForgeStatus]> = [];
    const forge = { kind: "gitlab" as const, runUrl: "https://gitlab.example/p/-/pipelines/7", setStatus: async (sha: string, s: ForgeStatus) => void posted.push([sha, s]) };
    const line = await postOpWaveApplyStatus({ forge, dirs: [dir], wave: 1, of: 2, context: "terragucci/apply", at: "b".repeat(40), pipelineId: 7 });
    expect(posted).toEqual([["b".repeat(40), { context: "terragucci/apply", state: "running", description: "wave 1 of 2 applied", url: "https://gitlab.example/p/-/pipelines/7", pipelineId: 7 }]]);
    expect(line).toBe("terragucci/apply on bbbbbbbbbbbb: running: wave 1 of 2 applied");
  });

  test("refuses a commit that is not a sha, a wave past the count, and a context that is not a status name", async () => {
    const forge = { kind: "github" as const, setStatus: async () => {} };
    const at = "c".repeat(40);
    await expect(postOpWaveApplyStatus({ forge, dirs: [], wave: 1, of: 1, context: "x/apply", at: "HEAD" })).rejects.toThrow("a full sha");
    await expect(postOpWaveApplyStatus({ forge, dirs: [], wave: 3, of: 2, context: "x/apply", at })).rejects.toThrow("--wave 3 is past the run's 2 waves");
    await expect(postOpWaveApplyStatus({ forge, dirs: [], wave: 1, of: 1, context: "x apply", at })).rejects.toThrow("is not a status name");
  });

  test("the job's name and command, through the product's bin, and the flags parse", () => {
    expect(applyStatusJobName(2)).toBe("apply-status-2");
    const line = applyStatusCommand({ name: "tf-apply", waves: [1, 2] }, 1, "terragucci/apply", "github", '"$GITHUB_SHA"', "npx --no-install terragucci");
    expect(line).toBe('npx --no-install terragucci run wave --op tf-apply --wave 1 --of 2 --apply-status terragucci/apply --at "$GITHUB_SHA" --forge github');
    expect(parseArgs(["run", "wave", "--op", "tf-apply", "--wave", "1", "--of", "2", "--apply-status", "terragucci/apply", "--at", "abc", "--forge", "github"])).toMatchObject({ op: "tf-apply", wave: 1, of: 2, applyStatus: "terragucci/apply", at: "abc", forge: "github" });
    expect(() => parseArgs(["run", "wave", "--of", "0"])).toThrow("--of needs the number of waves");
    expect(() => parseArgs(["run", "wave", "--apply-status"])).toThrow("--apply-status needs the status's name");
  });
});
