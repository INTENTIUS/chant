import { describe, test, expect } from "vitest";
import { FlywayParser } from "./parser";
import { FlywayGenerator } from "./generator";
import type { TemplateIR, ResourceIR } from "@intentius/chant/import/parser";

const parser = new FlywayParser();
const generator = new FlywayGenerator();

function makeIR(resources: ResourceIR[]): TemplateIR {
  return { resources, parameters: [] };
}

describe("FlywayParser", () => {
  test("parses project-level properties", () => {
    const toml = `
id = "my-project"
name = "my-project"
databaseType = "postgresql"
`;
    const ir = parser.parse(toml);
    expect(ir.resources.length).toBe(1);
    const r = ir.resources[0];
    expect(r.type).toBe("Flyway::Project");
    expect(r.logicalId).toBe("project");
    expect(r.properties.id).toBe("my-project");
    expect(r.properties.name).toBe("my-project");
    expect(r.properties.databaseType).toBe("postgresql");
  });

  test("parses [flyway] config", () => {
    const toml = `
[flyway]
locations = ["filesystem:sql"]
defaultSchema = "public"
`;
    const ir = parser.parse(toml);
    expect(ir.resources.length).toBe(1);
    const r = ir.resources[0];
    expect(r.type).toBe("Flyway::Config");
    expect(r.logicalId).toBe("config");
    expect(r.properties.locations).toEqual(["filesystem:sql"]);
    expect(r.properties.defaultSchema).toBe("public");
  });

  test("parses environments", () => {
    const toml = `
[environments.dev]
url = "jdbc:postgresql://localhost:5432/db"
user = "admin"
schemas = ["public"]
`;
    const ir = parser.parse(toml);
    expect(ir.resources.length).toBe(1);
    const r = ir.resources[0];
    expect(r.type).toBe("Flyway::Environment");
    expect(r.logicalId).toBe("dev");
    expect(r.properties.displayName).toBe("dev");
    expect(r.properties.url).toBe("jdbc:postgresql://localhost:5432/db");
    expect(r.properties.user).toBe("admin");
    expect(r.properties.schemas).toEqual(["public"]);
  });

  test("parses resolvers within environments", () => {
    const toml = `
[environments.prod]
url = "jdbc:postgresql://prod:5432/db"

[environments.prod.resolvers.vault]
url = "https://vault.example.com"
token = "\${env.VAULT_TOKEN}"
`;
    const ir = parser.parse(toml);
    expect(ir.resources.length).toBe(2);

    const env = ir.resources.find((r) => r.type === "Flyway::Environment");
    expect(env).toBeDefined();
    expect(env!.logicalId).toBe("prod");
    expect(env!.properties.url).toBe("jdbc:postgresql://prod:5432/db");

    const resolver = ir.resources.find((r) => r.type === "Flyway::Resolver.Vault");
    expect(resolver).toBeDefined();
    expect(resolver!.logicalId).toBe("prod_vault");
    expect(resolver!.properties.url).toBe("https://vault.example.com");
    expect(resolver!.properties.token).toBe("${env.VAULT_TOKEN}");
  });

  test("parses [flywayDesktop]", () => {
    const toml = `
[flywayDesktop]
developmentEnvironment = "dev"
schemaModel = "./schema-model"
`;
    const ir = parser.parse(toml);
    expect(ir.resources.length).toBe(1);
    const r = ir.resources[0];
    expect(r.type).toBe("Flyway::FlywayDesktop");
    expect(r.logicalId).toBe("flywayDesktop");
    expect(r.properties.developmentEnvironment).toBe("dev");
    expect(r.properties.schemaModel).toBe("./schema-model");
  });

  test("parses [redgateCompare]", () => {
    const toml = `
[redgateCompare]
filterFile = "./filter.rgf"
`;
    const ir = parser.parse(toml);
    expect(ir.resources.length).toBe(1);
    const r = ir.resources[0];
    expect(r.type).toBe("Flyway::RedgateCompare");
    expect(r.logicalId).toBe("redgateCompare");
    expect(r.properties.filterFile).toBe("./filter.rgf");
  });

  test("parses complete config with multiple sections", () => {
    const toml = `
id = "my-project"
name = "my-project"
databaseType = "postgresql"

[flyway]
locations = ["filesystem:sql"]
defaultSchema = "public"

[environments.dev]
url = "jdbc:postgresql://localhost:5432/db"
user = "admin"
schemas = ["public"]

[environments.prod]
url = "jdbc:postgresql://prod:5432/db"
user = "deploy"

[environments.prod.resolvers.vault]
url = "https://vault.example.com"

[flywayDesktop]
developmentEnvironment = "dev"

[redgateCompare]
filterFile = "./filter.rgf"
`;
    const ir = parser.parse(toml);
    expect(ir.parameters).toEqual([]);

    const types = ir.resources.map((r) => r.type);
    expect(types).toContain("Flyway::Project");
    expect(types).toContain("Flyway::Config");
    expect(types).toContain("Flyway::Environment");
    expect(types).toContain("Flyway::Resolver.Vault");
    expect(types).toContain("Flyway::FlywayDesktop");
    expect(types).toContain("Flyway::RedgateCompare");

    // 1 project + 1 config + 2 environments + 1 resolver + 1 flywayDesktop + 1 redgateCompare
    expect(ir.resources.length).toBe(7);
  });

  test("empty TOML returns empty resources", () => {
    const ir = parser.parse("");
    expect(ir.resources).toEqual([]);
    expect(ir.parameters).toEqual([]);
  });
});

describe("FlywayGenerator", () => {
  test("generates TypeScript with correct imports", () => {
    const ir = makeIR([
      {
        logicalId: "project",
        type: "Flyway::Project",
        properties: { id: "app", name: "app", databaseType: "postgresql" },
      },
      {
        logicalId: "dev",
        type: "Flyway::Environment",
        properties: { url: "jdbc:postgresql://localhost:5432/db", displayName: "dev" },
      },
    ]);
    const files = generator.generate(ir);
    expect(files.length).toBe(1);
    expect(files[0].path).toBe("src/infra.ts");
    expect(files[0].content).toContain("import { Environment, FlywayProject }");
    expect(files[0].content).toContain('from "@intentius/chant-lexicon-flyway"');
    expect(files[0].content).toContain("new FlywayProject(");
    expect(files[0].content).toContain("new Environment(");
  });

  test("generates correct variable names from kebab-case", () => {
    const ir = makeIR([
      {
        logicalId: "my-service",
        type: "Flyway::Environment",
        properties: { url: "jdbc:postgresql://localhost/db", displayName: "my-service" },
      },
    ]);
    const files = generator.generate(ir);
    expect(files[0].content).toContain("export const myService");
  });

  test("generates correct variable names from snake_case", () => {
    const ir = makeIR([
      {
        logicalId: "prod_vault",
        type: "Flyway::Resolver.Vault",
        properties: { url: "https://vault.example.com" },
      },
    ]);
    const files = generator.generate(ir);
    expect(files[0].content).toContain("export const prodVault");
  });

  test("formats string properties correctly", () => {
    const ir = makeIR([
      {
        logicalId: "project",
        type: "Flyway::Project",
        properties: { id: "my-app", name: "my-app" },
      },
    ]);
    const files = generator.generate(ir);
    expect(files[0].content).toContain('"my-app"');
  });

  test("formats array properties correctly", () => {
    const ir = makeIR([
      {
        logicalId: "config",
        type: "Flyway::Config",
        properties: { locations: ["filesystem:sql", "filesystem:migrations"] },
      },
    ]);
    const files = generator.generate(ir);
    expect(files[0].content).toContain('["filesystem:sql", "filesystem:migrations"]');
  });

  test("formats boolean properties correctly", () => {
    const ir = makeIR([
      {
        logicalId: "config",
        type: "Flyway::Config",
        properties: { cleanDisabled: true },
      },
    ]);
    const files = generator.generate(ir);
    expect(files[0].content).toContain("cleanDisabled: true");
  });

  test("formats number properties correctly", () => {
    const ir = makeIR([
      {
        logicalId: "config",
        type: "Flyway::Config",
        properties: { connectRetries: 3 },
      },
    ]);
    const files = generator.generate(ir);
    expect(files[0].content).toContain("connectRetries: 3");
  });

  test("generates exports for each resource", () => {
    const ir = makeIR([
      {
        logicalId: "project",
        type: "Flyway::Project",
        properties: { id: "app" },
      },
      {
        logicalId: "dev",
        type: "Flyway::Environment",
        properties: { url: "jdbc:postgresql://localhost/db", displayName: "dev" },
      },
      {
        logicalId: "config",
        type: "Flyway::Config",
        properties: { defaultSchema: "public" },
      },
    ]);
    const files = generator.generate(ir);
    expect(files[0].content).toContain("export const project");
    expect(files[0].content).toContain("export const dev");
    expect(files[0].content).toContain("export const config");
  });

  test("skips unknown resource types", () => {
    const ir = makeIR([
      {
        logicalId: "unknown",
        type: "Flyway::Unknown",
        properties: { foo: "bar" },
      },
    ]);
    const files = generator.generate(ir);
    expect(files[0].content).not.toContain("export const unknown");
  });

  test("handles empty IR", () => {
    const ir = makeIR([]);
    const files = generator.generate(ir);
    expect(files.length).toBe(1);
  });
});

describe("roundtrip: parse TOML -> generate TypeScript", () => {
  test("complete config roundtrip", () => {
    const toml = `
id = "my-project"
name = "my-project"
databaseType = "postgresql"

[flyway]
locations = ["filesystem:sql"]
defaultSchema = "public"

[environments.dev]
url = "jdbc:postgresql://localhost:5432/db"
user = "admin"
schemas = ["public"]

[environments.prod]
url = "jdbc:postgresql://prod:5432/db"
user = "deploy"

[environments.prod.resolvers.vault]
url = "https://vault.example.com"
token = "\${env.VAULT_TOKEN}"

[flywayDesktop]
developmentEnvironment = "dev"

[redgateCompare]
filterFile = "./filter.rgf"
`;
    const ir = parser.parse(toml);
    const files = generator.generate(ir);

    expect(files.length).toBe(1);
    expect(files[0].path).toBe("src/infra.ts");

    const content = files[0].content;
    expect(content).toContain("new FlywayProject(");
    expect(content).toContain("new FlywayConfig(");
    expect(content).toContain("new Environment(");
    expect(content).toContain("new VaultResolver(");
    expect(content).toContain("new FlywayDesktopConfig(");
    expect(content).toContain("new RedgateCompareConfig(");
    expect(content).toContain('from "@intentius/chant-lexicon-flyway"');
    expect(content).toContain("export const");
  });

  test("minimal project roundtrip", () => {
    const toml = `
id = "simple"
name = "simple"
`;
    const ir = parser.parse(toml);
    const files = generator.generate(ir);

    expect(files[0].content).toContain("new FlywayProject(");
    expect(files[0].content).toContain('"simple"');
  });

  test("environment-only roundtrip", () => {
    const toml = `
[environments.staging]
url = "jdbc:postgresql://staging:5432/db"
user = "app"
schemas = ["public", "app"]
`;
    const ir = parser.parse(toml);
    const files = generator.generate(ir);

    expect(files[0].content).toContain("new Environment(");
    expect(files[0].content).toContain("export const staging");
    expect(files[0].content).toContain('"staging"');
  });
});
