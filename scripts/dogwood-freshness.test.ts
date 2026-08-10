/**
 * The dogwood freshness comparison, against fixture tree data (#1688).
 *
 * No network: the transport is injectable, so the fetch layer is exercised with
 * a canned GitHub tree — including the truncation fallback, which is the one
 * path a live run against a small repo would never take.
 */

import { describe, expect, it } from "vitest";
import {
  buildReport,
  fetchUpstreamState,
  formatReport,
  githubTransport,
  markdownReport,
  type JsonTransport,
  type UpstreamPin,
} from "./dogwood-freshness";

const PIN: UpstreamPin = {
  owner: "dogwood-policy",
  repo: "dogwood",
  revision: "5063bcc2d6d6cf5024d1b0498e6cc8ef52cbcf0c",
  contents: {
    "dogwood-language/src/parser/grammar.pest": "adb0801303ee1b735585fe22a5d85175ecf6772c",
    "dogwood-cli/src/ops.rs": "2924c7eb0e569a745ff19c2d84cbba782fc56502",
  },
};

/** A transport backed by a url → response map; an unlisted url is a 404. */
function fixtureTransport(routes: Record<string, { status?: number; body?: unknown }>): JsonTransport {
  return async (url: string) => {
    const hit = routes[url];
    if (!hit) return { status: 404, body: { message: "Not Found" } };
    return { status: hit.status ?? 200, body: hit.body };
  };
}

const base = "https://api.github.com/repos/dogwood-policy/dogwood";
const refUrl = `${base}/git/ref/heads/main`;
const treeUrl = (sha: string) => `${base}/git/trees/${sha}?recursive=1`;

function treeRoutes(head: string, blobs: Record<string, string>, truncated = false) {
  return {
    [refUrl]: { body: { object: { sha: head } } },
    [treeUrl(head)]: {
      body: {
        truncated,
        tree: [
          ...Object.entries(blobs).map(([path, sha]) => ({ path, type: "blob", sha })),
          { path: "dogwood-cli", type: "tree", sha: "e814cbfbf7504939a2d4aae914d4495e0286b481" },
        ],
      },
    },
  };
}

describe("buildReport", () => {
  it("calls every surface unchanged when the tree still matches the pin", () => {
    const report = buildReport(PIN, "main", { revision: PIN.revision, blobs: { ...PIN.contents } });
    expect(report.revisionMoved).toBe(false);
    expect(report.surfacesMoved).toBe(false);
    expect(report.surfaces.map((s) => s.state)).toEqual(["unchanged", "unchanged"]);
  });

  it("reports a revision move on its own when no pinned blob changed", () => {
    // A docs-only sync: the head advances, the seven pinned files do not. This
    // is the case the narrow pin exists to keep quiet about.
    const report = buildReport(PIN, "main", { revision: "a".repeat(40), blobs: { ...PIN.contents } });
    expect(report.revisionMoved).toBe(true);
    expect(report.surfacesMoved).toBe(false);
  });

  it("marks a rewritten blob moved and keeps both hashes", () => {
    const report = buildReport(PIN, "main", {
      revision: "b".repeat(40),
      blobs: { ...PIN.contents, "dogwood-cli/src/ops.rs": "c".repeat(40) },
    });
    expect(report.surfacesMoved).toBe(true);
    const moved = report.surfaces.find((s) => s.path === "dogwood-cli/src/ops.rs");
    expect(moved?.state).toBe("moved");
    expect(moved?.pinned).toBe(PIN.contents["dogwood-cli/src/ops.rs"]);
    expect(moved?.upstream).toBe("c".repeat(40));
  });

  it("marks a vanished path missing rather than unchanged", () => {
    const report = buildReport(PIN, "main", {
      revision: PIN.revision,
      blobs: { ...PIN.contents, "dogwood-cli/src/ops.rs": null },
    });
    expect(report.surfaces.find((s) => s.path === "dogwood-cli/src/ops.rs")?.state).toBe("missing");
    expect(report.surfacesMoved).toBe(true);
  });
});

describe("fetchUpstreamState", () => {
  it("reads the branch head and each pinned blob from one recursive tree", async () => {
    const state = await fetchUpstreamState(
      PIN,
      "main",
      fixtureTransport(treeRoutes(PIN.revision, { ...PIN.contents, "README.md": "f".repeat(40) })),
    );
    expect(state.revision).toBe(PIN.revision);
    expect(state.blobs).toEqual({ ...PIN.contents });
  });

  it("reports a path absent from a complete tree as gone", async () => {
    const state = await fetchUpstreamState(
      PIN,
      "main",
      fixtureTransport(
        treeRoutes(PIN.revision, {
          "dogwood-language/src/parser/grammar.pest": PIN.contents["dogwood-language/src/parser/grammar.pest"],
        }),
      ),
    );
    expect(state.blobs["dogwood-cli/src/ops.rs"]).toBeNull();
  });

  it("falls back to the contents endpoint when the tree is truncated", async () => {
    // A truncated tree is silent about what it omitted, so a missing path there
    // proves nothing — re-read it directly before calling the file deleted.
    const head = "d".repeat(40);
    const routes = {
      ...treeRoutes(
        head,
        { "dogwood-language/src/parser/grammar.pest": PIN.contents["dogwood-language/src/parser/grammar.pest"] },
        true,
      ),
      [`${base}/contents/dogwood-cli/src/ops.rs?ref=${head}`]: { body: { sha: "e".repeat(40) } },
    };
    const state = await fetchUpstreamState(PIN, "main", fixtureTransport(routes));
    expect(state.blobs["dogwood-cli/src/ops.rs"]).toBe("e".repeat(40));
  });

  it("still reports gone when the truncated fallback 404s", async () => {
    const head = "d".repeat(40);
    const state = await fetchUpstreamState(PIN, "main", fixtureTransport(treeRoutes(head, {}, true)));
    expect(state.blobs["dogwood-cli/src/ops.rs"]).toBeNull();
  });

  it("throws with the API's own message when the ref cannot be read", async () => {
    const transport = fixtureTransport({ [refUrl]: { status: 403, body: { message: "API rate limit exceeded" } } });
    await expect(fetchUpstreamState(PIN, "main", transport)).rejects.toThrow(/HTTP 403 — API rate limit exceeded/);
  });

  it("throws when the ref response carries no sha", async () => {
    const transport = fixtureTransport({ [refUrl]: { body: { object: {} } } });
    await expect(fetchUpstreamState(PIN, "main", transport)).rejects.toThrow(/no commit sha/);
  });
});

describe("githubTransport", () => {
  it("passes the status through and authenticates when GITHUB_TOKEN is set", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "t0ken";
    try {
      const transport = githubTransport((async (url: string, init?: RequestInit) => {
        seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
        return { status: 404, json: async () => ({ message: "Not Found" }) } as unknown as Response;
      }) as unknown as typeof fetch);
      const res = await transport("https://api.github.com/x");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ message: "Not Found" });
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
    expect(seen[0]?.headers.Authorization).toBe("Bearer t0ken");
  });

  it("tolerates a body that is not JSON", async () => {
    const transport = githubTransport((async () =>
      ({
        status: 502,
        json: async () => {
          throw new Error("not json");
        },
      }) as unknown as Response) as unknown as typeof fetch);
    await expect(transport("https://api.github.com/x")).resolves.toEqual({ status: 502, body: undefined });
  });
});

describe("reporting", () => {
  it("names the file and both short hashes for a moved surface", () => {
    const report = buildReport(PIN, "main", {
      revision: "b".repeat(40),
      blobs: { ...PIN.contents, "dogwood-cli/src/ops.rs": "c".repeat(40) },
    });
    const text = formatReport(report).join("\n");
    expect(text).toContain("dogwood-cli/src/ops.rs — moved 2924c7eb → cccccccc");
    expect(text).toContain("1 of 2 pinned surfaces moved");
    expect(markdownReport(report)).toContain("| `dogwood-cli/src/ops.rs` | moved `2924c7eb` → `cccccccc` |");
  });

  it("says so plainly when nothing moved", () => {
    const report = buildReport(PIN, "main", { revision: PIN.revision, blobs: { ...PIN.contents } });
    const text = formatReport(report).join("\n");
    expect(text).toContain("is the current head");
    expect(text).toContain("All 2 pinned surfaces are unchanged");
    expect(markdownReport(report)).toContain("byte-identical");
  });
});
