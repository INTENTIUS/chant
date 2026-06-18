import { describe, test, expect } from "vitest";
import { fetchRepoFiles, parseRepoUrl, resolveActionSha, resolveImageDigest, parseImageRef, FetchError } from "./fetch";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
const CI_YAML = "name: CI\non:\n  push:\npermissions: write-all\njobs:\n  build:\n    runs-on: ubuntu-latest\n";

interface Route {
  match: string;
  make: () => Response;
}

/** Route-based fetch mock (used by the resolver tests). */
function fakeFetch(routes: Route[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    for (const r of routes) {
      if (String(url).includes(r.match)) return r.make();
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/**
 * A GitHub/Forgejo-shaped mock: repo-info default_branch, recursive git/trees,
 * base64 contents. `sizes` overrides the reported blob size for cap tests.
 */
function gitTreeMock(files: Record<string, string>, sizes: Record<string, number> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("/git/trees/")) {
      const tree = Object.keys(files).map((path) => ({ path, type: "blob", size: sizes[path] ?? files[path].length }));
      return new Response(JSON.stringify({ tree }), { status: 200 });
    }
    // GitHub content comes from the raw CDN first (plain text, no base64).
    const rawm = u.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
    if (rawm) {
      const path = decodeURIComponent(rawm[1]);
      if (files[path] === undefined) return new Response("not found", { status: 404 });
      return new Response(files[path], { status: 200 });
    }
    const cm = u.match(/\/contents\/(.+?)\?/);
    if (cm) {
      const path = decodeURIComponent(cm[1]);
      if (files[path] === undefined) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ path, type: "file", content: b64(files[path]), encoding: "base64" }), { status: 200 });
    }
    if (/\/repos\/[^/]+\/[^/]+(\?|$)/.test(u)) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A GitLab-shaped mock: project default_branch, paginated repository/tree, raw files. */
function gitlabMock(files: Record<string, string>) {
  const impl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/repository/tree")) {
      const page = Number(new URL(u).searchParams.get("page") ?? "1");
      const all = Object.keys(files).map((path) => ({ path, type: "blob" }));
      return new Response(JSON.stringify(page === 1 ? all : []), { status: 200 });
    }
    const rm = u.match(/\/repository\/files\/(.+?)\/raw\?/);
    if (rm) {
      const path = decodeURIComponent(rm[1]);
      if (files[path] === undefined) return new Response("not found", { status: 404 });
      return new Response(files[path], { status: 200 });
    }
    if (/\/projects\/[^/]+(\?|$)/.test(u)) return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl };
}

describe("parseRepoUrl", () => {
  test("rejects non-https", () => {
    expect(() => parseRepoUrl("http://github.com/o/r")).toThrow(FetchError);
  });
  test("rejects non-allowlisted host", () => {
    expect(() => parseRepoUrl("https://evil.example.com/o/r")).toThrow(/Host not allowed/);
  });
  test("parses owner/repo and strips .git", () => {
    const p = parseRepoUrl("https://github.com/acme/widgets.git");
    expect(p.owner).toBe("acme");
    expect(p.repo).toBe("widgets");
    expect(p.host.kind).toBe("github");
  });
});

describe("fetchRepoFiles", () => {
  test("github: tree-walks and decodes candidate files", async () => {
    const { impl } = gitTreeMock({ ".github/workflows/ci.yml": CI_YAML, "README.md": "# hi" });
    const files = await fetchRepoFiles("https://github.com/acme/widgets", { fetchImpl: impl });
    // README.md is not a candidate path; only the workflow is fetched.
    expect(files.map((f) => f.path)).toEqual([".github/workflows/ci.yml"]);
    expect(files[0].content).toContain("permissions: write-all");
  });

  test("sends an auth token when provided", async () => {
    const { impl, calls } = gitTreeMock({ ".github/workflows/ci.yml": CI_YAML });
    await fetchRepoFiles("https://github.com/acme/widgets", { fetchImpl: impl, token: "secret" });
    const auth = calls.map((c) => (c.init?.headers as Record<string, string>)?.Authorization);
    expect(auth).toContain("Bearer secret");
  });

  test("always sends a User-Agent, even without a token (GitHub 403s otherwise)", async () => {
    const { impl, calls } = gitTreeMock({ ".github/workflows/ci.yml": CI_YAML });
    await fetchRepoFiles("https://github.com/acme/widgets", { fetchImpl: impl });
    const uas = calls.map((c) => (c.init?.headers as Record<string, string>)?.["User-Agent"]);
    expect(uas.every((ua) => typeof ua === "string" && ua.length > 0)).toBe(true);
  });

  test("github: reads content from the raw CDN (no contents-API burst)", async () => {
    const { impl, calls } = gitTreeMock({ ".github/workflows/ci.yml": CI_YAML });
    const files = await fetchRepoFiles("https://github.com/acme/widgets", { fetchImpl: impl });
    expect(files[0].content).toContain("permissions: write-all");
    // Content came from raw.githubusercontent.com — the contents API was not hit.
    expect(calls.some((c) => c.url.includes("raw.githubusercontent.com"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/contents/"))).toBe(false);
  });

  test("does not send the auth token cross-host to the raw CDN", async () => {
    const { impl, calls } = gitTreeMock({ ".github/workflows/ci.yml": CI_YAML });
    await fetchRepoFiles("https://github.com/acme/widgets", { fetchImpl: impl, token: "secret" });
    const rawCall = calls.find((c) => c.url.includes("raw.githubusercontent.com"));
    expect((rawCall?.init?.headers as Record<string, string>)?.Authorization).toBeUndefined();
  });

  test("encodes path segments with spaces (would 403 unencoded)", async () => {
    const spaced = ".changes/v1.16/NEW FEATURES.yaml";
    const { impl, calls } = gitTreeMock({ [spaced]: "kind: Changelog\n" });
    const files = await fetchRepoFiles("https://github.com/acme/widgets", { fetchImpl: impl });
    expect(files.map((f) => f.path)).toContain(spaced);
    expect(calls.some((c) => c.url.includes("NEW%20FEATURES.yaml"))).toBe(true);
  });

  test("a single file's failure does not abort the whole walk", async () => {
    // raw 404s for the bad path → contents API also 404s → that file is skipped,
    // not fatal; the good file still comes back.
    const { impl } = gitTreeMock({ ".github/workflows/ci.yml": CI_YAML, "k8s/deploy.yaml": "kind: Deployment\n" });
    const broken = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("deploy.yaml")) return new Response("forbidden", { status: 403 });
      return impl(url, init);
    }) as unknown as typeof fetch;
    const files = await fetchRepoFiles("https://github.com/acme/widgets", { fetchImpl: broken });
    expect(files.map((f) => f.path)).toEqual([".github/workflows/ci.yml"]);
  });

  test("skips a file over the per-file size cap (reported by the tree)", async () => {
    const { impl } = gitTreeMock({ ".github/workflows/ci.yml": CI_YAML }, { ".github/workflows/ci.yml": 10_000_000 });
    const files = await fetchRepoFiles("https://github.com/acme/widgets", { fetchImpl: impl, maxBytesPerFile: 1024 });
    expect(files).toHaveLength(0);
  });

  test("throws when the total byte cap is exceeded", async () => {
    const big = "x".repeat(2000);
    const { impl } = gitTreeMock({ "a.yaml": big, "b.yaml": big });
    await expect(fetchRepoFiles("https://github.com/acme/widgets", { fetchImpl: impl, maxTotalBytes: 3000 })).rejects.toThrow(/total size cap/i);
  });

  test("refuses to follow a redirect on the tree request", async () => {
    const impl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/git/trees/")) return new Response(null, { status: 302 });
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(fetchRepoFiles("https://github.com/acme/widgets", { fetchImpl: impl })).rejects.toThrow(/redirect/i);
  });

  test("throws on a non-allowlisted host before any fetch", async () => {
    await expect(fetchRepoFiles("https://evil.example.com/o/r")).rejects.toThrow(/Host not allowed/);
  });

  test("gitlab: paginated tree + raw file content", async () => {
    const { impl } = gitlabMock({ ".gitlab-ci.yml": "stages:\n  - build\n" });
    const files = await fetchRepoFiles("https://gitlab.com/acme/widgets", { fetchImpl: impl });
    expect(files.map((f) => f.path)).toEqual([".gitlab-ci.yml"]);
    expect(files[0].content).toContain("stages:");
  });

  test("forgejo (codeberg): gitea tree + contents", async () => {
    const { impl } = gitTreeMock({ ".forgejo/workflows/ci.yml": CI_YAML });
    const files = await fetchRepoFiles("https://codeberg.org/acme/widgets", { fetchImpl: impl });
    expect(files.map((f) => f.path)).toEqual([".forgejo/workflows/ci.yml"]);
  });

  test("an empty repo returns []", async () => {
    const { impl } = gitTreeMock({});
    const files = await fetchRepoFiles("https://github.com/acme/empty", { fetchImpl: impl });
    expect(files).toEqual([]);
  });
});

describe("resolveActionSha", () => {
  const SHA = "11bd71901bbe5b1630ceea73d27597364c9af683";

  test("resolves an action ref to a commit SHA via the GitHub API", async () => {
    const { impl, calls } = fakeFetch([
      { match: "/repos/actions/checkout/commits/v4", make: () => new Response(JSON.stringify({ sha: SHA }), { status: 200 }) },
    ]);
    const sha = await resolveActionSha("actions/checkout", "v4", { fetchImpl: impl });
    expect(sha).toBe(SHA);
    expect(calls[0].url).toContain("api.github.com/repos/actions/checkout/commits/v4");
  });

  test("returns undefined on a failed lookup", async () => {
    const { impl } = fakeFetch([]); // 404
    expect(await resolveActionSha("acme/missing", "v1", { fetchImpl: impl })).toBeUndefined();
  });

  test("rejects a non-SHA response", async () => {
    const { impl } = fakeFetch([{ match: "/commits/", make: () => new Response(JSON.stringify({ sha: "not-a-sha" }), { status: 200 }) }]);
    expect(await resolveActionSha("acme/action", "v1", { fetchImpl: impl })).toBeUndefined();
  });
});

describe("parseImageRef", () => {
  test("bare Docker Hub official image", () => {
    expect(parseImageRef("node:20")).toEqual({ registry: "registry-1.docker.io", repository: "library/node", tag: "20" });
  });
  test("Docker Hub org image, default tag", () => {
    expect(parseImageRef("acme/app")).toEqual({ registry: "registry-1.docker.io", repository: "acme/app", tag: "latest" });
  });
  test("ghcr image with registry host", () => {
    expect(parseImageRef("ghcr.io/owner/img:1.2")).toEqual({ registry: "ghcr.io", repository: "owner/img", tag: "1.2" });
  });
  test("already-digested ref returns undefined", () => {
    expect(parseImageRef("node@sha256:" + "a".repeat(64))).toBeUndefined();
  });
});

describe("resolveImageDigest", () => {
  const DIGEST = "sha256:" + "c".repeat(64);

  test("resolves via the registry v2 bearer-token challenge", async () => {
    const challenge = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/node:pull"';
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("auth.docker.io/token")) return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      if (u.includes("/v2/library/node/manifests/20")) {
        const hasAuth = Boolean((init?.headers as Record<string, string>)?.Authorization);
        return hasAuth
          ? new Response(null, { status: 200, headers: { "docker-content-digest": DIGEST } })
          : new Response(null, { status: 401, headers: { "www-authenticate": challenge } });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    expect(await resolveImageDigest("node:20", { fetchImpl: impl })).toBe(DIGEST);
  });

  test("skips a non-allowlisted registry (SSRF guard)", async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    expect(await resolveImageDigest("evil.internal/x:1", { fetchImpl: impl })).toBeUndefined();
    expect(called).toBe(false);
  });
});
