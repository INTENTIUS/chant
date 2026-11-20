import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  CI_PRODUCTS,
  PRODUCT_AUDIT_KINDS,
  PRODUCT_CONFIG_WORDS,
  PRODUCT_CONFIG_WORDS_FLOOR,
  PRODUCT_RELEASE_ALIASES,
  PRODUCT_RELEASE_WORDS,
  productConfigProblems,
  productConfigWord,
} from "./ci-product";
import { NEXT_RELEASE } from "./release-floors";

const PAGE = readFileSync(fileURLToPath(new URL("../../../docs/src/content/docs/reference/ci-product-config.mdx", import.meta.url)), "utf8");

const paths = (problems: { path: string }[]) => problems.map((p) => p.path).sort();

describe("the vocabulary (#5343)", () => {
  test("each key is spelled once, and every alias names a product it was settled across", () => {
    const keys = PRODUCT_CONFIG_WORDS.map((w) => w.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const w of PRODUCT_CONFIG_WORDS) for (const a of w.aliases ?? []) expect(CI_PRODUCTS).toContain(a.product);
  });

  test("the reference page lists every key, place, alias and release word", () => {
    for (const w of PRODUCT_CONFIG_WORDS) {
      expect(PAGE, w.key).toContain(`\`${w.key}\``);
      for (const also of w.also ?? []) expect(PAGE, also).toContain(`\`${also}\``);
      for (const v of w.values ?? []) expect(PAGE, `${w.key}: ${v}`).toContain(`\`${v}\``);
      for (const a of w.aliases ?? []) {
        if (a.key) expect(PAGE, `${a.product} ${a.key}`).toMatch(new RegExp(`\\| ${a.product} \\| \`${a.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        if (a.value) expect(PAGE, `${a.product} ${a.value[0]}`).toContain(`: ${a.value[0]}\``);
      }
    }
    for (const word of Object.values(PRODUCT_RELEASE_WORDS)) expect(PAGE).toContain(word);
    for (const a of PRODUCT_RELEASE_ALIASES) expect(PAGE).toContain(`| ${a.product} | \`${a.command} ${a.alias}\``);
    for (const kind of Object.keys(PRODUCT_AUDIT_KINDS)) expect(PAGE).toContain(`\`${kind}\``);
  });

  test("the promotion order has its own key, apart from plywood's environments", () => {
    expect(productConfigWord("promotion")?.section).toBe("stage");
    expect(productConfigWord("promotion")?.chant).toContain("chant.config.ts");
    expect(PRODUCT_RELEASE_WORDS).toMatchObject({ promote: "promote", rollback: "rollback", to: "--to", release: "--release", allowSkip: "--allow-skip" });
  });

  test("an environment's config and secret set: a forge secret's name is checked, a store map is read as the product's (#5348)", () => {
    const config = {
      config_sets: { common: { secrets: { SENTRY_DSN: "SENTRY_DSN", BAD: { forge_secret: "not a name" } } } },
      environments: { staging: { imports: ["common"], config: { REGION: "us-east-2" }, secrets: { DB: "STAGING DB", API: { aws_secrets_manager: "arn:x" } } } },
    };
    expect(paths(productConfigProblems(config, { product: "terragucci" }))).toEqual(["config_sets.common.secrets.BAD.forge_secret", "environments.staging.secrets.DB"]);
    expect(productConfigWord("config_sets.<set>")?.section).toBe("stage");
  });

  test("the canary stage has its own key, which pipelineFromConfig reads (#5327)", () => {
    const word = productConfigWord("environments.<name>.canary");
    expect(word?.section).toBe("stage");
    expect(word?.chant).toContain("`canary`");
    expect(PAGE).toContain("| `environments.<name>.canary` |");
  });

  test("the floor names the next release", () => {
    expect(PRODUCT_CONFIG_WORDS_FLOOR).toBe(NEXT_RELEASE);
  });
});

describe("productConfigProblems", () => {
  test("terragucci's own spellings are warnings naming the key, and its config has no errors", () => {
    const problems = productConfigProblems(
      {
        gate: "on-destroy",
        locks: "apply",
        drift: "0 6 * * *",
        oidc: { plan_role: "arn:aws:iam::123456789012:role/plan" },
        url: "http://forge.internal:8080/acme/infra",
        apply: { when: "merge", branches: { release: ["envs/prod/**"] } },
        notify: { slack: "SLACK_URL", relay: "chat", relay_key: "RELAY_KEY" },
        reports: { bucket: "s3://reports/infra", url: "https://reports.example.com" },
        respond: { "wave-refused": "diff", drift: "off" },
        environments: { dev: { roots: ["envs/dev/*"], gate: "never" }, prod: { roots: ["envs/prod/*"], gate: "on-destroy" } },
        promotion: ["dev", "prod"],
      },
      { product: "terragucci" },
    );
    expect(problems.filter((p) => p.level === "error")).toEqual([]);
    expect(paths(problems)).toEqual(["apply.branches", "drift", "environments.prod.gate", "gate", "locks", "notify.relay", "oidc", "url"]);
    expect(problems.find((p) => p.path === "oidc")?.message).toBe("is accepted as identity, the vocabulary's key");
    expect(problems.find((p) => p.path === "gate")?.message).toBe("on-destroy is accepted as on-destructive, the vocabulary's word");
  });

  test("plywood's spellings, its forge environments map and its storage reports.url read as aliases", () => {
    const problems = productConfigProblems(
      {
        environments: { "*-prod": "production", "*-dev": { name: "dev", url: "https://dev.example.com" } },
        reports: { url: "s3://reports/plywood" },
        respond: { wave_refused: "off", apply_failed: "triage", drift: "none" },
        review: { key_env: "ANTHROPIC_API_KEY" },
        agent: { comment: true, key_env: "ANTHROPIC_API_KEY" },
        telemetry: { endpoint: "https://otel.example.com", headers_env: "OTEL_HEADERS" },
        notify: { slack: { webhook: "SLACK_URL" }, webhook: { url: "HOOK_URL", key: "HOOK_KEY" }, on: ["drift"], relay: "RELAY_KEY" },
        policy: { rego: "policy", engine: "conftest" },
        review_stacks: { template: "app/dev", ttl: "48h" },
        forge: { kind: "forgejo", url: "https://code.example.com" },
        approval_rules: { prod: { role: "sre", quorum: 2 } },
        pass: ["CLOUDFLARE_TOKEN"],
        runners: "self-hosted",
        locks: { when: "preview", grain: "stack" },
        promotion: ["dev", "staging", "prod"],
      },
      { product: "plywood" },
    );
    expect(problems.filter((p) => p.level === "error")).toEqual([]);
    expect(paths(problems)).toEqual(
      [
        "agent.key_env",
        "approval_rules.prod.quorum",
        "approval_rules.prod.role",
        "environments",
        "forge.kind",
        "forge.url",
        "notify.on",
        "notify.relay",
        "notify.slack.webhook",
        "notify.webhook.key",
        "notify.webhook.url",
        "pass",
        "policy.rego",
        "reports.url",
        "respond.apply_failed",
        "respond.drift",
        "respond.wave_refused",
        "review.key_env",
        "review_stacks",
        "review_stacks.ttl",
        "runners",
        "telemetry.headers_env",
      ].sort(),
    );
  });

  test("an alias set beside its key is an error", () => {
    const problems = productConfigProblems({ reports: { url: "s3://a/b", bucket: "s3://a/b" }, respond: { wave_refused: "off", "wave-refused": "off" } }, { product: "plywood" });
    expect(problems.filter((p) => p.level === "error").map((p) => p.path)).toEqual(["respond.wave_refused", "reports.url"]);
  });

  test("an https reports.url is the browser address in plywood too", () => {
    expect(productConfigProblems({ reports: { url: "https://reports.example.com" } }, { product: "plywood" })).toEqual([]);
  });

  test("a value outside the words, or one product's alias in another, is an error", () => {
    const problems = productConfigProblems({ gate: "sometimes", respond: { drift: "none" }, telemetry: { headers_secret: "not a name" } }, { product: "terragucci" });
    expect(problems).toEqual([
      { level: "error", path: "gate", key: "gate", message: "is sometimes; gate takes always, on-destructive, never" },
      { level: "error", path: "respond.drift", key: "respond.drift", message: "is none; respond.drift takes issue, pull-request, attribute, up, off" },
      { level: "error", path: "telemetry.headers_secret", key: "telemetry.headers_secret", message: "is not a name; telemetry.headers_secret is a secret or variable name" },
    ]);
  });

  test("a camelCase config under a ci scope: sql-yodeler", () => {
    const problems = productConfigProblems(
      {
        waves: [
          { env: "dev", gate: "never", approval: "ledger" },
          { env: "prod", gate: "on-destroy", approval: "sealed" },
        ],
        notify: { webhook: "YODEL_WEBHOOK_URL", key: "YODEL_WEBHOOK_KEY", relayName: "yodel" },
        ci: { login: { aws: { roleArn: "arn:aws:iam::123456789012:role/yodel" } }, evidence: { runnerKeySecret: "bad name" }, forges: ["github", "bitbucket"] },
      },
      { product: "sql-yodeler", case: "camel", scopes: ["ci"] },
    );
    expect(problems.map((p) => [p.level, p.path])).toEqual([
      ["warning", "ci.login"],
      ["warning", "notify.key"],
      ["error", "waves[1].gate"],
      ["error", "ci.evidence.runnerKeySecret"],
      ["error", "ci.forges"],
    ]);
  });

  test("promotion is a list of distinct environment names the environments map declares", () => {
    const check = (promotion: unknown, environments?: unknown) =>
      productConfigProblems({ promotion, ...(environments ? { environments } : {}) }, { product: "terragucci" }).map((p) => p.message);
    expect(check(["dev", "staging", "prod"], { dev: {}, staging: {}, prod: {} })).toEqual([]);
    expect(check("dev")).toEqual(["is a list of environment names, first to last"]);
    expect(check([])).toEqual(["is a list of environment names, first to last"]);
    expect(check(["dev", "dev"])).toEqual(["names dev twice; an environment is one step"]);
    expect(check(["pr-*", "prod"])).toEqual(["names pr-*, a pattern; each step is one environment"]);
    expect(check(["dev", "prod"], { dev: {} })).toEqual(["names prod, which environments does not declare"]);
    // plywood's environments maps globs to forge environments, so it names no steps.
    expect(productConfigProblems({ promotion: ["dev", "prod"], environments: { "*-dev": "dev" } }, { product: "plywood" }).filter((p) => p.level === "error")).toEqual([]);
  });

  test("keys the vocabulary does not hold, and configs that are not maps, give nothing", () => {
    expect(productConfigProblems({ roots: ["a"], stacks: { a: { dir: "a" } } }, { product: "terragucci" })).toEqual([]);
    expect(productConfigProblems(null, { product: "plywood" })).toEqual([]);
    expect(productConfigProblems(["x"], { product: "plywood" })).toEqual([]);
  });
});
