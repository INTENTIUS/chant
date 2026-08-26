import { describe, test, expect } from "vitest";
import { auditWranglerConfigs, isWranglerConfigPath, type ScannableFile } from "./wrangler";

function ids(files: ScannableFile[]): string[] {
  return auditWranglerConfigs(files).map((f) => f.checkId);
}

describe("isWranglerConfigPath (detector)", () => {
  test("matches wrangler.toml at any depth", () => {
    expect(isWranglerConfigPath("wrangler.toml")).toBe(true);
    expect(isWranglerConfigPath("apps/api/wrangler.toml")).toBe(true);
  });
  test("does not match other files", () => {
    expect(isWranglerConfigPath("wrangler.json")).toBe(false);
    expect(isWranglerConfigPath("wrangler.jsonc")).toBe(false);
    expect(isWranglerConfigPath("Wrangler.toml")).toBe(false);
    expect(isWranglerConfigPath("not-wrangler.toml")).toBe(false);
  });
});

describe("auditWranglerConfigs — parser tolerance", () => {
  test("a file that fails to parse contributes no findings, never throws", () => {
    expect(() => auditWranglerConfigs([{ path: "wrangler.toml", content: "not = valid = toml = [" }])).not.toThrow();
    expect(ids([{ path: "wrangler.toml", content: "not = valid = toml = [" }])).toEqual([]);
  });
  test("non-wrangler files are ignored entirely", () => {
    expect(ids([{ path: "other.toml", content: 'workers_dev = true\n[env.production]\nworkers_dev = true\n' }])).toEqual([]);
  });
});

describe("WRG001: workers_dev = true in a production-named environment", () => {
  test("positive: production env exposed on the public subdomain", () => {
    const content = `
      name = "my-worker"

      [env.production]
      workers_dev = true
    `;
    expect(ids([{ path: "wrangler.toml", content }])).toContain("WRG001");
  });

  test("negative: workers_dev true at top-level (dev default) does not fire", () => {
    const content = `
      name = "my-worker"
      workers_dev = true
    `;
    expect(ids([{ path: "wrangler.toml", content }])).not.toContain("WRG001");
  });

  test("negative: production env with workers_dev = false", () => {
    const content = `
      [env.production]
      workers_dev = false
    `;
    expect(ids([{ path: "wrangler.toml", content }])).not.toContain("WRG001");
  });
});

describe("WRG002: secret-shaped key in [vars]", () => {
  test("positive: API key stored as a plain var", () => {
    const content = `
      [vars]
      STRIPE_API_KEY = "sk_live_not_a_real_key_but_shaped_like_one"
      ENVIRONMENT = "production"
    `;
    const findings = auditWranglerConfigs([{ path: "wrangler.toml", content }]);
    const wrg002 = findings.filter((f) => f.checkId === "WRG002");
    expect(wrg002.length).toBe(1);
    expect(wrg002[0].entity).toBe("STRIPE_API_KEY");
    // The value itself must never appear in the message (redaction discipline).
    expect(wrg002[0].message).not.toContain("sk_live_not_a_real_key_but_shaped_like_one");
  });

  test("positive: fires per-environment too", () => {
    const content = `
      [env.staging.vars]
      DB_PASSWORD = "hunter2"
    `;
    expect(ids([{ path: "wrangler.toml", content }])).toContain("WRG002");
  });

  test("negative: an ordinary var name does not fire", () => {
    const content = `
      [vars]
      ENVIRONMENT = "production"
      LOG_LEVEL = "info"
    `;
    expect(ids([{ path: "wrangler.toml", content }])).not.toContain("WRG002");
  });
});

describe("WRG003: observability explicitly disabled", () => {
  test("positive: enabled = false", () => {
    const content = `
      [observability]
      enabled = false
    `;
    expect(ids([{ path: "wrangler.toml", content }])).toContain("WRG003");
  });

  test("negative: enabled = true", () => {
    const content = `
      [observability]
      enabled = true
    `;
    expect(ids([{ path: "wrangler.toml", content }])).not.toContain("WRG003");
  });

  test("negative: no [observability] table at all", () => {
    const content = `name = "my-worker"`;
    expect(ids([{ path: "wrangler.toml", content }])).not.toContain("WRG003");
  });
});

describe("WRG004: account-wide wildcard route", () => {
  test("positive: bare wildcard route", () => {
    const content = `routes = ["*/*"]`;
    expect(ids([{ path: "wrangler.toml", content }])).toContain("WRG004");
  });

  test("positive: object-form wildcard route pattern", () => {
    const content = `
      [[routes]]
      pattern = "*"
      zone_name = "example.com"
    `;
    expect(ids([{ path: "wrangler.toml", content }])).toContain("WRG004");
  });

  test("negative: a zone-scoped route is fine", () => {
    const content = `
      [[routes]]
      pattern = "example.com/*"
      zone_name = "example.com"
    `;
    expect(ids([{ path: "wrangler.toml", content }])).not.toContain("WRG004");
  });
});

describe("WRG005: non-prod environment shares a data store with production", () => {
  test("positive: staging KV namespace reuses production's id", () => {
    const content = `
      [[kv_namespaces]]
      binding = "MY_KV"
      id = "shared-id-123"

      [env.staging]
      kv_namespaces = [{ binding = "MY_KV", id = "shared-id-123" }]
    `;
    const findings = auditWranglerConfigs([{ path: "wrangler.toml", content }]);
    const wrg005 = findings.filter((f) => f.checkId === "WRG005");
    expect(wrg005.length).toBe(1);
    expect(wrg005[0].entity).toBe("kv_namespaces:shared-id-123");
  });

  test("negative: staging has its own distinct id", () => {
    const content = `
      [[kv_namespaces]]
      binding = "MY_KV"
      id = "prod-id"

      [env.staging]
      kv_namespaces = [{ binding = "MY_KV", id = "staging-id" }]
    `;
    expect(ids([{ path: "wrangler.toml", content }])).not.toContain("WRG005");
  });

  test("negative: a single-environment file (no dev/staging env) never trips on its own top-level id", () => {
    const content = `
      [[kv_namespaces]]
      binding = "MY_KV"
      id = "only-one-env"
    `;
    expect(ids([{ path: "wrangler.toml", content }])).not.toContain("WRG005");
  });
});

describe("WRG006: static assets/site served from the project root", () => {
  test("positive: [site].bucket = \".\"", () => {
    const content = `
      [site]
      bucket = "."
    `;
    expect(ids([{ path: "wrangler.toml", content }])).toContain("WRG006");
  });

  test("positive: [assets].directory = \"/\"", () => {
    const content = `
      [assets]
      directory = "/"
    `;
    expect(ids([{ path: "wrangler.toml", content }])).toContain("WRG006");
  });

  test("negative: a scoped assets directory", () => {
    const content = `
      [assets]
      directory = "./public"
    `;
    expect(ids([{ path: "wrangler.toml", content }])).not.toContain("WRG006");
  });
});

describe("a representative multi-check wrangler.toml", () => {
  test("fires the expected set and nothing else", () => {
    const content = `
      name = "my-worker"
      main = "src/index.ts"
      compatibility_date = "2024-01-01"

      [observability]
      enabled = false

      [vars]
      LOG_LEVEL = "info"

      [[routes]]
      pattern = "example.com/*"
      zone_name = "example.com"

      [env.production]
      workers_dev = true

      [env.production.vars]
      API_TOKEN = "not-a-real-value"
    `;
    const found = new Set(ids([{ path: "wrangler.toml", content }]));
    expect(found).toEqual(new Set(["WRG001", "WRG002", "WRG003"]));
  });
});
