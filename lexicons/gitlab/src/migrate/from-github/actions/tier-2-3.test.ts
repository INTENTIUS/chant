import { describe, test, expect, beforeAll } from "vitest";
import { createRegistry, lookupAction } from "./registry";
import { registerTier2 } from "./tier-2";
import { registerTier3 } from "./tier-3";
import type { ActionMapCtx } from "./registry";

const ctx: ActionMapCtx = { logicalId: "job", jobName: "job", stepIndex: 0 };
const reg = createRegistry();
beforeAll(() => {
  registerTier2(reg);
  registerTier3(reg);
});

function call(uses: string, w: Record<string, unknown> = {}) {
  const m = lookupAction(uses, reg);
  if (!m) throw new Error(`No mapping: ${uses}`);
  return m.translate({ uses, with: w }, ctx);
}

describe("Tier 2 mappings", () => {
  test("actions/setup-dotnet → mcr.microsoft.com/dotnet/sdk", () => {
    const r = call("actions/setup-dotnet@v4", { "dotnet-version": "8.0" });
    expect(r.image).toBe("mcr.microsoft.com/dotnet/sdk:8.0");
  });

  test("shivammathur/setup-php → php image + before_script", () => {
    const r = call("shivammathur/setup-php@v2", { "php-version": "8.2", extensions: "mbstring,intl" });
    expect(r.image).toBe("php:8.2");
    expect(r.beforeScript?.join("\n")).toContain("docker-php-ext-install");
  });

  test("aws-actions/configure-aws-credentials → needs-review + variables", () => {
    const r = call("aws-actions/configure-aws-credentials@v4", { "aws-region": "us-west-2" });
    expect(r.variables?.AWS_DEFAULT_REGION).toBe("us-west-2");
    expect(r.provenance[0].category).toBe("needs-review");
  });

  test("google-github-actions/auth emits base64 decode", () => {
    const r = call("google-github-actions/auth@v2");
    expect(r.scriptLines.some((l) => l.includes("base64 -d"))).toBe(true);
    expect(r.variables?.GOOGLE_APPLICATION_CREDENTIALS).toBeDefined();
  });

  test("azure/login → az login service-principal", () => {
    const r = call("azure/login@v2");
    expect(r.scriptLines.some((l) => l.includes("az login"))).toBe(true);
  });

  test("hashicorp/setup-terraform → hashicorp/terraform image", () => {
    const r = call("hashicorp/setup-terraform@v3", { terraform_version: "1.6" });
    expect(r.image).toBe("hashicorp/terraform:1.6");
  });

  test("codecov/codecov-action → codecov-cli script", () => {
    const r = call("codecov/codecov-action@v4", { files: "coverage.xml" });
    expect(r.scriptLines.some((l) => l.includes("codecov-cli"))).toBe(true);
    expect(r.scriptLines.some((l) => l.includes("coverage.xml"))).toBe(true);
  });

  test("softprops/action-gh-release → glab release create", () => {
    const r = call("softprops/action-gh-release@v2");
    expect(r.scriptLines.some((l) => l.includes("glab release"))).toBe(true);
  });

  test("peter-evans/create-pull-request → git commit + glab mr", () => {
    const r = call("peter-evans/create-pull-request@v6", { title: "Update deps" });
    expect(r.scriptLines.some((l) => l.includes("glab mr create"))).toBe(true);
    expect(r.scriptLines.some((l) => l.includes("Update deps"))).toBe(true);
  });

  test("JamesIves/github-pages-deploy-action → public/ artifact", () => {
    const r = call("JamesIves/github-pages-deploy-action@v4", { folder: "dist" });
    expect(r.artifacts?.paths).toEqual(["public"]);
    expect(r.scriptLines.some((l) => l.includes("cp -r dist"))).toBe(true);
  });

  test("pnpm/action-setup → npm install -g pnpm", () => {
    const r = call("pnpm/action-setup@v4", { version: "9" });
    expect(r.scriptLines[0]).toContain("pnpm@9");
  });

  test("oven-sh/setup-bun → oven/bun image", () => {
    const r = call("oven-sh/setup-bun@v2", { "bun-version": "1.1.0" });
    expect(r.image).toBe("oven/bun:1.1.0");
  });

  test("gradle/gradle-build-action → gradle image", () => {
    const r = call("gradle/gradle-build-action@v3", { "gradle-version": "8" });
    expect(r.image).toBe("gradle:8");
  });

  test("cypress-io/github-action → cypress/browsers image + npx cypress run", () => {
    const r = call("cypress-io/github-action@v6", { browser: "firefox", start: "npm start" });
    expect(r.image).toBe("cypress/browsers:latest");
    expect(r.scriptLines.some((l) => l.includes("npx cypress run --browser firefox"))).toBe(true);
  });
});

describe("Tier 3 mappings", () => {
  test("tj-actions/changed-files → git diff", () => {
    const r = call("tj-actions/changed-files@v44", { files: "src/**" });
    expect(r.scriptLines[0]).toContain("git diff --name-only");
  });

  test("dorny/paths-filter → needs-review (native rules:changes)", () => {
    const r = call("dorny/paths-filter@v3");
    expect(r.provenance[0].category).toBe("needs-review");
    expect(r.scriptLines.some((l) => l.includes("rules:changes"))).toBe(true);
  });

  test("nick-fields/retry → needs-review (native retry:)", () => {
    const r = call("nick-fields/retry@v3", { command: "npm test" });
    expect(r.provenance[0].category).toBe("needs-review");
    expect(r.scriptLines).toContain("npm test");
  });

  test("pre-commit/action → pip install + pre-commit run", () => {
    const r = call("pre-commit/action@v3");
    expect(r.scriptLines.some((l) => l.includes("pip install pre-commit"))).toBe(true);
    expect(r.scriptLines.some((l) => l.includes("pre-commit run"))).toBe(true);
  });

  test("slackapi/slack-github-action → curl webhook", () => {
    const r = call("slackapi/slack-github-action@v1", { payload: '{"text":"hi"}' });
    expect(r.scriptLines.some((l) => l.includes("$SLACK_WEBHOOK_URL"))).toBe(true);
  });

  test("registry covers 5 Tier 3 + 14 Tier 2 = 19 actions", () => {
    const names = [
      "actions/setup-dotnet", "shivammathur/setup-php",
      "aws-actions/configure-aws-credentials", "google-github-actions/auth",
      "azure/login", "hashicorp/setup-terraform", "codecov/codecov-action",
      "softprops/action-gh-release", "peter-evans/create-pull-request",
      "JamesIves/github-pages-deploy-action", "pnpm/action-setup",
      "oven-sh/setup-bun", "gradle/gradle-build-action", "cypress-io/github-action",
      "tj-actions/changed-files", "dorny/paths-filter", "nick-fields/retry",
      "pre-commit/action", "slackapi/slack-github-action",
    ];
    expect(names).toHaveLength(19);
    for (const n of names) {
      expect(lookupAction(`${n}@v1`, reg)).toBeDefined();
    }
  });
});
