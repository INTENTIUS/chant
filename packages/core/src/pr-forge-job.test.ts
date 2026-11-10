/**
 * #4964: a GitHub pull_request run plans, checks and signs its merge
 * preview (`GITHUB_SHA`), and the forge shows no status of that commit on
 * the pull request, so the plan note's, the check evidence's and the ref
 * gate's statuses for it go on the pull request's head.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ForgeFetch } from "./pr-forge";
import { forgeFromJobEnv } from "./pr-forge-job";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const OTHER = "c".repeat(40);

function recorder(): { fetch: ForgeFetch; posted: string[] } {
  const posted: string[] = [];
  const fetch: ForgeFetch = async (url) => {
    posted.push(url.replace(/^.*\/statuses\//, ""));
    return { ok: true, status: 201, text: async () => "{}" };
  };
  return { fetch, posted };
}

function eventFile(body: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "chant-4964-")), "event.json");
  writeFileSync(path, JSON.stringify(body));
  return path;
}

const status = { context: "chant/plan", state: "success" as const, description: "d" };

describe("statuses of a pull_request run on the pull request's head (#4964)", () => {
  const env = { GITHUB_REPOSITORY: "acme/infra", GITHUB_TOKEN: "t", GITHUB_EVENT_NAME: "pull_request", GITHUB_SHA: MERGE, GITHUB_EVENT_PATH: eventFile({ number: 7, pull_request: { number: 7, head: { sha: HEAD } } }) };

  test("a status for the merge preview goes on the head; one for another commit where it was asked", async () => {
    const { fetch, posted } = recorder();
    const forge = forgeFromJobEnv("github", env, fetch);
    await forge.setStatus(MERGE, status);
    await forge.setStatus(OTHER, status);
    expect(posted).toEqual([HEAD, OTHER]);
  });

  test("a run of another event, or one whose payload names no head, posts where it was asked", async () => {
    const { fetch, posted } = recorder();
    await forgeFromJobEnv("github", { ...env, GITHUB_EVENT_NAME: "push" }, fetch).setStatus(MERGE, status);
    await forgeFromJobEnv("github", { ...env, GITHUB_EVENT_PATH: eventFile({ ref: "refs/heads/main" }) }, fetch).setStatus(MERGE, status);
    await forgeFromJobEnv("github", { ...env, GITHUB_EVENT_PATH: join(tmpdir(), "chant-4964-missing.json") }, fetch).setStatus(MERGE, status);
    expect(posted).toEqual([MERGE, MERGE, MERGE]);
  });
});
