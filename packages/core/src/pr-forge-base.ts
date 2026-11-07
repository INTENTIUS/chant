/**
 * The branch a pull request merges into (#4723), read from the forge for the
 * commit job's base merge. It sits outside ./pr-forge.ts so the pull-request
 * loop's bundle, which carries pr-forge.ts under a ruled size ceiling, does
 * not grow for a job it never runs. It reads the job's environment the way
 * `forgeFromEnv` does.
 */
import type { ForgeKind } from "./pr-forge";

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** `(pr) => base branch`, or undefined when the job's environment names no forge to ask. A failed read is undefined, which the commit job refuses by name. */
export function pullRequestBaseFromEnv(kind: ForgeKind, env: Record<string, string | undefined> = process.env, fetchImpl: Fetch = (url, init) => fetch(url, init)): ((pr: number) => Promise<string | undefined>) | undefined {
  const read = async (url: string, headers: Record<string, string>, pick: (body: Record<string, unknown>) => unknown): Promise<string | undefined> => {
    try {
      const res = await fetchImpl(url, { headers });
      if (!res.ok) return undefined;
      const body = await res.json();
      const v = body && typeof body === "object" ? pick(body as Record<string, unknown>) : undefined;
      return typeof v === "string" && v !== "" ? v : undefined;
    } catch {
      return undefined;
    }
  };
  if (kind === "gitlab") {
    const token = env.CHANT_FORGE_TOKEN ?? env.GITLAB_TOKEN;
    if (!env.CI_API_V4_URL || !env.CI_PROJECT_ID || !token) return undefined;
    const root = `${env.CI_API_V4_URL.replace(/\/+$/, "")}/projects/${encodeURIComponent(env.CI_PROJECT_ID)}`;
    return (pr) => read(`${root}/merge_requests/${pr}`, { "private-token": token }, (b) => b.target_branch);
  }
  const token = env.CHANT_FORGE_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN;
  const api = env.GITHUB_API_URL ?? (kind === "github" ? "https://api.github.com" : undefined);
  if (!env.GITHUB_REPOSITORY || !token || !api) return undefined;
  const headers: Record<string, string> = kind === "github" ? { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "chant" } : { authorization: `token ${token}`, accept: "application/json" };
  return (pr) => read(`${api.replace(/\/+$/, "")}/repos/${env.GITHUB_REPOSITORY}/pulls/${pr}`, headers, (b) => (b.base && typeof b.base === "object" ? (b.base as { ref?: unknown }).ref : undefined));
}
