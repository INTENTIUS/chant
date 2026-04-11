import { describe, test, expect } from "vitest";
import { wgl016, checkSecretsInVariables } from "./wgl016";

describe("WGL016: Secrets in Variables", () => {
  test("check metadata", () => {
    expect(wgl016.id).toBe("WGL016");
    expect(wgl016.description).toContain("Secrets");
  });

  test("flags hardcoded password variable", () => {
    const yaml = `variables:
  DB_PASSWORD: my-secret-pass123
  DB_HOST: postgres
`;
    const diags = checkSecretsInVariables(yaml);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL016");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("DB_PASSWORD");
  });

  test("flags hardcoded token variable", () => {
    const yaml = `variables:
  API_TOKEN: abc123xyz
`;
    const diags = checkSecretsInVariables(yaml);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("API_TOKEN");
  });

  test("flags hardcoded secret variable", () => {
    const yaml = `variables:
  APP_SECRET: supersecretvalue
`;
    const diags = checkSecretsInVariables(yaml);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("APP_SECRET");
  });

  test("does not flag variable references", () => {
    const yaml = `variables:
  DB_PASSWORD: $CI_DB_PASSWORD
  API_TOKEN: \${SECRET_TOKEN}
`;
    const diags = checkSecretsInVariables(yaml);
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-secret variables", () => {
    const yaml = `variables:
  NODE_ENV: production
  DB_HOST: postgres
  STAGE: deploy
`;
    const diags = checkSecretsInVariables(yaml);
    expect(diags).toHaveLength(0);
  });

  test("flags multiple secret variables", () => {
    const yaml = `variables:
  DB_PASSWORD: pass123
  API_SECRET: secret456
`;
    const diags = checkSecretsInVariables(yaml);
    expect(diags).toHaveLength(2);
  });

  test("no diagnostics on empty yaml", () => {
    const diags = checkSecretsInVariables("");
    expect(diags).toHaveLength(0);
  });
});
