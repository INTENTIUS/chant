import { describe, test, expect } from "vitest";
import { fetchCiFiles, parseRepoUrl, resolveActionSha, resolveImageDigest, parseImageRef, FetchError } from "./fetch";

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
const CI_YAML = "name: CI\non:\n  push:\npermissions: write-all\njobs:\n  build:\n    runs-on: ubuntu-latest\n";

interface Route {
  match: string;
  make: () => Response;
}

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

const githubRoutes = (size = 100): Route[] => [
  {
    match: "/contents/.github/workflows/ci.yml",
    make: () => new Response(JSON.stringify({ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file", content: b64(CI_YAML), encoding: "base64" }), { status: 200 }),
  },
  {
    match: "/contents/.github/workflows",
    make: () => new Response(JSON.stringify([{ name: "ci.yml", path: ".github/workflows/ci.yml", type: "file", size }]), { status: 200 }),
  },
];

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

describe("fetchCiFiles", () => {
  test("fetches and decodes github workflow files", async () => {
    const { impl } = fakeFetch(githubRoutes());
    const files = await fetchCiFiles("https://github.com/acme/widgets", { fetchImpl: impl });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(".github/workflows/ci.yml");
    expect(files[0].lexicon).toBe("github");
    expect(files[0].content).toContain("permissions: write-all");
  });

  test("sends an auth token when provided", async () => {
    const { impl, calls } = fakeFetch(githubRoutes());
    await fetchCiFiles("https://github.com/acme/widgets", { fetchImpl: impl, token: "secret" });
    const auth = calls.map((c) => (c.init?.headers as Record<string, string>)?.Authorization);
    expect(auth).toContain("Bearer secret");
  });

  test("skips a file over the per-file size cap", async () => {
    const { impl } = fakeFetch(githubRoutes(10_000_000));
    const files = await fetchCiFiles("https://github.com/acme/widgets", { fetchImpl: impl, maxBytesPerFile: 1024 });
    expect(files).toHaveLength(0);
  });

  test("refuses to follow a redirect", async () => {
    const { impl } = fakeFetch([{ match: "/contents/", make: () => new Response(null, { status: 302 }) }]);
    await expect(fetchCiFiles("https://github.com/acme/widgets", { fetchImpl: impl })).rejects.toThrow(/redirect/i);
  });

  test("refuses to follow a redirect on the gitlab path", async () => {
    const { impl } = fakeFetch([{ match: "/repository/files/", make: () => new Response(null, { status: 301 }) }]);
    await expect(fetchCiFiles("https://gitlab.com/acme/widgets", { fetchImpl: impl })).rejects.toThrow(/redirect/i);
  });

  test("throws on a non-allowlisted host before any fetch", async () => {
    await expect(fetchCiFiles("https://evil.example.com/o/r")).rejects.toThrow(/Host not allowed/);
  });

  test("returns the gitlab pipeline file", async () => {
    const { impl } = fakeFetch([
      { match: "/repository/files/", make: () => new Response("stages:\n  - build\n", { status: 200 }) },
    ]);
    const files = await fetchCiFiles("https://gitlab.com/acme/widgets", { fetchImpl: impl });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(".gitlab-ci.yml");
    expect(files[0].lexicon).toBe("gitlab");
  });

  test("forgejo (codeberg) reads .forgejo/workflows", async () => {
    const { impl } = fakeFetch([
      {
        match: "/contents/.forgejo/workflows/ci.yml",
        make: () => new Response(JSON.stringify({ name: "ci.yml", path: ".forgejo/workflows/ci.yml", type: "file", content: b64(CI_YAML), encoding: "base64" }), { status: 200 }),
      },
      {
        match: "/contents/.forgejo/workflows",
        make: () => new Response(JSON.stringify([{ name: "ci.yml", path: ".forgejo/workflows/ci.yml", type: "file", size: 100 }]), { status: 200 }),
      },
    ]);
    const files = await fetchCiFiles("https://codeberg.org/acme/widgets", { fetchImpl: impl });
    expect(files).toHaveLength(1);
    expect(files[0].lexicon).toBe("forgejo");
    expect(files[0].path).toBe(".forgejo/workflows/ci.yml");
  });

  test("a repo with no CI files returns []", async () => {
    const { impl } = fakeFetch([]); // everything 404s
    const files = await fetchCiFiles("https://github.com/acme/empty", { fetchImpl: impl });
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
