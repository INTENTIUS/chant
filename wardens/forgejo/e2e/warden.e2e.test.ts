/**
 * Hermetic end-to-end harness — exercises every registered cycle against a REAL
 * Forgejo instance (a throwaway Docker Compose stack, see e2e/docker-compose.yml
 * + e2e/bootstrap.sh). Gated and excluded from the default test run
 * (`vitest.config.ts` only globs `src/**`); run with `npm run test:e2e:run`.
 *
 * ## Why this is fully hermetic
 * Forgejo is self-hostable, so — unlike github-warden's App-based e2e — this
 * needs NO external account or credentials. CI stands up Forgejo, mints an admin
 * token, and the suite provisions its own throwaway org + repo, exercises the
 * cycles, and tears them down.
 *
 * ## Gating
 * Skips entirely unless FORGEJO_E2E_URL and FORGEJO_E2E_TOKEN are set.
 *
 * ## Phases
 *   1 (always): per cycle, fetchLive + buildDesired + diff against the live org,
 *     asserting every HTTP call was read-only (GET) and the change set composes —
 *     catches live API-contract drift.
 *   2 (FORGEJO_E2E_APPLY=1): one real apply (org-settings description), verified
 *     by re-fetch.
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { createClient, type ForgejoClient } from "../src/auth/client.js";
import { CYCLE_REGISTRY } from "../src/cli/registry.js";
import { orgSettingsCycle } from "../src/cycles/org-settings.js";
import { diff } from "../src/reconcile/diff.js";
import type { RateBudget } from "../src/reconcile/runner.js";
import type { OrgConfig } from "../src/config/types.js";

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

const ENV = process.env;
const URL = ENV.FORGEJO_E2E_URL;
const TOKEN = ENV.FORGEJO_E2E_TOKEN;
const APPLY = ENV.FORGEJO_E2E_APPLY === "1";

const configured = Boolean(URL && TOKEN);
const suite = configured ? describe : describe.skip;

if (!configured) {
  // eslint-disable-next-line no-console
  console.warn("[e2e] skipped — run e2e/bootstrap.sh and set FORGEJO_E2E_URL / FORGEJO_E2E_TOKEN.");
}

const ORG = `warden-e2e-${ENV.GITHUB_RUN_ID ?? Date.now()}`.toLowerCase();
const REPO = "probe";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBudget(initial = 500): RateBudget {
  let remaining = initial;
  return {
    get remaining() {
      return remaining;
    },
    get exhausted() {
      return remaining <= 0;
    },
    use(n = 1) {
      remaining = Math.max(0, remaining - n);
    },
  };
}

interface Call {
  method: string;
  path: string;
}

/** Wrap a client to record every (method, path) it performs. */
function recording(inner: ForgejoClient): { client: ForgejoClient; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
        calls.push({ method, path });
        return inner.request<T>(method, path, body);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite("forgejo-warden e2e (Docker Compose Forgejo)", () => {
  let client: ForgejoClient;
  let orgConfig: OrgConfig;
  let orgCreated = false;

  beforeAll(async () => {
    client = createClient({ baseUrl: URL!, token: TOKEN! });

    // Provision a throwaway org and a repo inside it (auto_init gives `main`).
    await client.request("POST", `/orgs`, { username: ORG, visibility: "private" });
    orgCreated = true;
    await client.request("POST", `/orgs/${ORG}/repos`, {
      name: REPO,
      private: true,
      auto_init: true,
      description: "warden e2e — auto-created, safe to delete",
    });
    await client.request("POST", `/orgs/${ORG}/actions/variables/WARDEN_E2E_VAR`, { value: "ok" });

    // Kitchen-sink config so every repo-scoped cycle's fetchLive hits its
    // endpoints (reads tolerate 404 for absent resources).
    orgConfig = {
      settings: { description: "warden e2e" },
      members: [],
      teams: {},
      repos: {
        [REPO]: {
          description: "warden e2e",
          topics: ["warden-e2e"],
          branchProtection: [{ ruleName: "main", requiredApprovals: 1 }],
          webhooks: [],
          secrets: [],
          variables: [{ name: "WARDEN_E2E_VAR", value: "ok" }],
        },
      },
      repoBaselines: [{ name: REPO }],
      secrets: [],
      variables: [{ name: "WARDEN_E2E_VAR", value: "ok" }],
      webhooks: [],
    };
  }, 90_000);

  afterAll(async () => {
    // Best-effort teardown — delete the repo, then the (now-empty) org.
    if (orgCreated) {
      await client.request("DELETE", `/repos/${ORG}/${REPO}`).catch(() => {});
      await client.request("DELETE", `/orgs/${ORG}`).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(`[e2e] teardown: failed to delete org ${ORG}:`, err);
      });
    }
  }, 60_000);

  // ── Phase 1: every cycle's read path is contract-valid and read-only ──────

  for (const cycle of Object.values(CYCLE_REGISTRY)) {
    it(`${cycle.name}: fetchLive is read-only and diffs cleanly`, async () => {
      const rec = recording(client);
      const live = await cycle.fetchLive(rec.client, ORG, {}, makeBudget());

      const desired = cycle.buildDesired(orgConfig, ORG, {});
      const changeSet = diff(ORG, desired, live, {});

      const nonGet = rec.calls.filter((c) => c.method !== "GET");
      expect(nonGet, `non-GET calls from ${cycle.name}.fetchLive`).toEqual([]);
      expect(Array.isArray(changeSet.entries)).toBe(true);
    }, 60_000);
  }

  // ── Phase 2: one real apply (opt-in) ──────────────────────────────────────

  (APPLY ? it : it.skip)(
    "apply: org-settings sets the description, verified by re-fetch",
    async () => {
      await orgSettingsCycle.apply(
        client,
        { kind: "update", resourceType: "org-settings", key: "org-settings", after: { description: "warden e2e applied" } },
        ORG,
        {},
        makeBudget(),
      );
      const got = await client.request<{ description?: string }>("GET", `/orgs/${ORG}`);
      expect(got.description).toBe("warden e2e applied");
    },
    60_000,
  );
});
