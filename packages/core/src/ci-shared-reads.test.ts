/**
 * #4554: the forge reads, handover parameters and report URLs products
 * share. Forge reads run against a recorded-answer fake fetch; report URLs
 * against an injected store. Nothing leaves the process.
 */

import { describe, expect, test } from "vitest";
import { checkoutScript, handoverTrap, HANDOVER_NOTE_FILES, packJs, takeOverScript } from "./ci-handover";
import { forgejoForge, githubForge, gitlabForge, type ForgeFetch } from "./pr-forge";
import { parseReportUrl, reportGet, reportPut } from "./pr-report-url";
import type { ObjectStore } from "./object-store/common";

/** A fetch that answers each URL (without its page parameters) from `answers`, and records the URLs asked. */
function recorded(answers: Record<string, unknown>): { fetch: ForgeFetch; asked: string[] } {
  const asked: string[] = [];
  const fetch: ForgeFetch = async (url) => {
    asked.push(url);
    const u = new URL(url);
    for (const p of ["page", "per_page", "limit"]) u.searchParams.delete(p);
    const key = `${u.pathname}${u.search}`;
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    if (!(key in answers)) return { ok: false, status: 404, text: async () => "{}" };
    const body = answers[key];
    return { ok: true, status: 200, text: async () => JSON.stringify(Array.isArray(body) && page > 1 ? [] : body) };
  };
  return { fetch, asked };
}

describe("default-branch and status reads (#4554)", () => {
  test("GitHub reads the repository's default branch and each context's newest status", async () => {
    const { fetch } = recorded({
      "/repos/o/r": { default_branch: "trunk" },
      "/repos/o/r/commits/abc/statuses": [
        { id: 3, context: "chant/apply", state: "success", target_url: "https://ci/run/3" },
        { id: 2, context: "chant/plan", state: "failure" },
        { id: 1, context: "chant/apply", state: "pending" },
      ],
    });
    const forge = githubForge({ apiBase: "https://api.test", repo: "o/r", token: "t", fetch });
    expect(await forge.defaultBranch!()).toBe("trunk");
    expect(await forge.commitStatuses!("abc")).toEqual([
      { context: "chant/apply", state: "success", targetUrl: "https://ci/run/3" },
      { context: "chant/plan", state: "failure" },
    ]);
  });

  test("Forgejo reads the same endpoints, and a repository with no default branch reads as main", async () => {
    const { fetch } = recorded({ "/api/v1/repos/o/r": {} });
    const forge = forgejoForge({ apiBase: "https://forge.test/api/v1", repo: "o/r", host: "forge.test", fetch });
    expect(await forge.defaultBranch!()).toBe("main");
  });

  test("GitLab keeps each name's status with the highest id", async () => {
    const { fetch } = recorded({
      "/api/v4/projects/g%2Fp": { default_branch: "main" },
      "/api/v4/projects/g%2Fp/repository/commits/abc/statuses?all=true": [
        { id: 7, name: "terragucci/plan", status: "failed", allow_failure: true },
        { id: 9, name: "terragucci/plan", status: "success" },
      ],
    });
    const forge = gitlabForge({ apiBase: "https://gitlab.test/api/v4", project: "g/p", fetch });
    expect(await forge.defaultBranch!()).toBe("main");
    expect(await forge.commitStatuses!("abc")).toEqual([{ context: "terragucci/plan", state: "success" }]);
  });

  test("GitLab filters the statuses by ref when given one, and asks for none when not (#4584)", async () => {
    const { fetch, asked } = recorded({
      "/api/v4/projects/g%2Fp/repository/commits/abc/statuses?all=true&ref=release%2F1": [{ id: 4, name: "terragucci/apply", status: "success" }],
      "/api/v4/projects/g%2Fp/repository/commits/abc/statuses?all=true": [{ id: 5, name: "terragucci/other", status: "failed" }],
    });
    const forge = gitlabForge({ apiBase: "https://gitlab.test/api/v4", project: "g/p", fetch });
    expect(await forge.commitStatuses!("abc", "release/1")).toEqual([{ context: "terragucci/apply", state: "success" }]);
    expect(asked[0]).toContain("&ref=release%2F1");
    expect(await forge.commitStatuses!("abc")).toEqual([{ context: "terragucci/other", state: "failed" }]);
    expect(asked[1]).not.toContain("ref=");
  });

  test("GitHub and Forgejo take the ref and read the commit's statuses as before (#4584)", async () => {
    const statuses = [{ id: 1, context: "chant/plan", state: "success" }];
    const gh = recorded({ "/repos/o/r/commits/abc/statuses": statuses });
    const github = githubForge({ apiBase: "https://api.test", repo: "o/r", token: "t", fetch: gh.fetch });
    expect(await github.commitStatuses!("abc", "main")).toEqual([{ context: "chant/plan", state: "success" }]);
    expect(gh.asked[0]).not.toContain("ref=");
    const fj = recorded({ "/api/v1/repos/o/r/commits/abc/statuses": statuses });
    const forgejo = forgejoForge({ apiBase: "https://forge.test/api/v1", repo: "o/r", host: "forge.test", fetch: fj.fetch });
    expect(await forgejo.commitStatuses!("abc", "main")).toEqual([{ context: "chant/plan", state: "success" }]);
  });
});

describe("the handover with a product's parameters (#4554)", () => {
  test("left out, the scripts are chant's own", () => {
    expect(packJs("github")).toContain(`NOTE=${JSON.stringify(HANDOVER_NOTE_FILES)}`);
    expect(packJs("github")).toContain('"chant: the plan report is too large to hand to the note job whole; it hands on pr-plan.json and pr-note.md"');
    expect(handoverTrap("report", "github").at(-1)).toBe("trap chant_handover EXIT");
    const checkout = checkoutScript(false);
    expect(checkout).toContain('"${CHANT_CHECKOUT_TOKEN:-}"');
    expect(checkout).toContain('ref="$GITHUB_REF"');
    expect(checkout).toContain("refs/remotes/origin/chant-head");
  });

  test("a product's note files, label, sweep, token, ref and head name", () => {
    const files = ["plan-note.md", "plan-status.json", "report.json"];
    const pack = packJs("forgejo", { noteFiles: files, label: "terragucci" });
    expect(pack).toContain(`NOTE=${JSON.stringify(files)}`);
    expect(pack).toContain("terragucci: the report is too large to hand to the next job whole; it hands on plan-note.md, plan-status.json, report.json");
    expect(handoverTrap("report", "forgejo", { label: "terragucci", before: "tg_sweep" }).at(-1)).toBe("trap 'tg_sweep; chant_handover' EXIT");
    const checkout = checkoutScript(true, false, { tokenEnv: "TG_TOKEN", refEnv: "TG_REF", headName: "terragucci-head" });
    expect(checkout).toContain('"${TG_TOKEN:-}"');
    expect(checkout).toContain('ref="${TG_REF:-$GITHUB_REF}"');
    expect(checkout).toContain('want="${TG_REF:-$GITHUB_SHA}"');
    expect(checkout).toContain("refs/remotes/origin/terragucci-head");
    expect(takeOverScript("replan", "report", "github")).toContain("the replan job handed on no report");
  });

  test("a parameter that would break out of the script is refused", () => {
    expect(() => packJs("github", { noteFiles: ['a"b'] })).toThrow();
    expect(() => handoverTrap("r", "github", { before: "x; rm" })).toThrow();
    expect(() => checkoutScript(false, false, { tokenEnv: "A-B" })).toThrow();
  });
});

describe("gs:// and az:// report URLs (#4554)", () => {
  test("they parse with their prefix", () => {
    expect(parseReportUrl("gs://my-bucket/pr/")).toEqual({ scheme: "gs", url: "gs://my-bucket/pr", bucket: "my-bucket", prefix: "pr" });
    expect(parseReportUrl("az://account1/reports")).toEqual({ scheme: "az", url: "az://account1/reports", account: "account1", container: "reports", prefix: "" });
    expect(parseReportUrl("https://example.test/x")).toHaveProperty("error");
  });

  test("a put and a get go through the store under the prefix, and an absent object reads as null", async () => {
    const objects = new Map<string, string>();
    const store = async (): Promise<ObjectStore> => ({
      location: "gs://my-bucket",
      put: async (key, body) => (objects.set(key, String(body)), {}),
      read: async (key) => (objects.has(key) ? { body: objects.get(key)! } : {}),
      get: async (key) => objects.get(key),
      presign: async () => ({ url: "", expires: new Date(0) }),
    });
    const target = parseReportUrl("gs://my-bucket/pr");
    if ("error" in target) throw new Error(target.error);
    await reportPut(target, undefined, store)("7/abc/pr-plan.json", "{}", "application/json");
    expect([...objects.keys()]).toEqual(["pr/7/abc/pr-plan.json"]);
    expect(await reportGet(target, undefined, store)("7/abc/pr-plan.json")).toBe("{}");
    expect(await reportGet(target, undefined, store)("7/abc/none.json")).toBeNull();
  });
});
