import { describe, test, expect } from "vitest";
import { fetchCiFiles, parseRepoUrl, FetchError } from "./fetch";

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
