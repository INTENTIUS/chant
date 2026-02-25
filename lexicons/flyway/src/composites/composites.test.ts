import { describe, test, expect } from "bun:test";
import { StandardProject } from "./standard-project";
import { MultiEnvironmentProject } from "./multi-environment-project";
import { VaultSecuredProject } from "./vault-secured-project";
import { DockerDevEnvironment } from "./docker-dev-environment";
import { CiPipelineProject } from "./ci-pipeline-project";
import { GcpSecuredProject } from "./gcp-secured-project";
import { BlueprintMigrationSet } from "./blueprint-migration-set";
import { DesktopProject } from "./desktop-project";
import { environmentGroup } from "./environment-group";

describe("StandardProject", () => {
  const result = StandardProject({
    name: "my-app",
    databaseType: "postgresql",
    devUrl: "jdbc:postgresql://localhost:5432/dev",
    prodUrl: "jdbc:postgresql://prod:5432/app",
  });

  test("returns project, dev, prod, config keys", () => {
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("dev");
    expect(result).toHaveProperty("prod");
    expect(result).toHaveProperty("config");
  });

  test("project.name matches input", () => {
    expect(result.project.name).toBe("my-app");
  });

  test("dev has url=devUrl, provisioner=clean, schemas defaults to [public]", () => {
    expect(result.dev.url).toBe("jdbc:postgresql://localhost:5432/dev");
    expect(result.dev.provisioner).toBe("clean");
    expect(result.dev.schemas).toEqual(["public"]);
  });

  test("prod has url=prodUrl, schemas defaults to [public]", () => {
    expect(result.prod.url).toBe("jdbc:postgresql://prod:5432/app");
    expect(result.prod.schemas).toEqual(["public"]);
  });

  test("config has databaseType, validateMigrationNaming=true, locations default", () => {
    expect(result.config.databaseType).toBe("postgresql");
    expect(result.config.validateMigrationNaming).toBe(true);
    expect(result.config.locations).toEqual(["filesystem:sql"]);
  });

  test("defaultSchema defaults to first schema", () => {
    expect(result.config.defaultSchema).toBe("public");

    const custom = StandardProject({
      name: "x",
      databaseType: "postgresql",
      devUrl: "a",
      prodUrl: "b",
      schemas: ["app", "public"],
    });
    expect(custom.config.defaultSchema).toBe("app");
  });
});

describe("MultiEnvironmentProject", () => {
  const envs = [
    { name: "dev", url: "jdbc:postgresql://localhost:5432/dev" },
    { name: "staging", url: "jdbc:postgresql://staging:5432/app" },
    { name: "prod", url: "jdbc:postgresql://prod:5432/app" },
  ];

  test("returns project, environments, config", () => {
    const result = MultiEnvironmentProject({
      name: "svc",
      databaseType: "postgresql",
      environments: envs,
      includeShadow: false,
    });
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("environments");
    expect(result).toHaveProperty("config");
  });

  test("creates N environments from input", () => {
    const result = MultiEnvironmentProject({
      name: "svc",
      databaseType: "postgresql",
      environments: envs,
      includeShadow: false,
    });
    expect(Object.keys(result.environments)).toHaveLength(3);
    expect(result.environments.dev.url).toBe("jdbc:postgresql://localhost:5432/dev");
    expect(result.environments.staging.url).toBe("jdbc:postgresql://staging:5432/app");
    expect(result.environments.prod.url).toBe("jdbc:postgresql://prod:5432/app");
  });

  test("each env gets schemas from default if not specified", () => {
    const result = MultiEnvironmentProject({
      name: "svc",
      databaseType: "postgresql",
      environments: envs,
      includeShadow: false,
    });
    for (const env of Object.values(result.environments)) {
      expect(env.schemas).toEqual(["public"]);
    }
  });

  test("shadow env created when includeShadow=true and shadowUrl provided", () => {
    const result = MultiEnvironmentProject({
      name: "svc",
      databaseType: "postgresql",
      environments: envs,
      includeShadow: true,
      shadowUrl: "jdbc:postgresql://localhost:5432/shadow",
    });
    expect(result.shadow).toBeDefined();
    expect(result.shadow!.url).toBe("jdbc:postgresql://localhost:5432/shadow");
  });

  test("shadow has provisioner=clean", () => {
    const result = MultiEnvironmentProject({
      name: "svc",
      databaseType: "postgresql",
      environments: envs,
      shadowUrl: "jdbc:postgresql://localhost:5432/shadow",
    });
    expect(result.shadow!.provisioner).toBe("clean");
  });

  test("no shadow when includeShadow=false", () => {
    const result = MultiEnvironmentProject({
      name: "svc",
      databaseType: "postgresql",
      environments: envs,
      includeShadow: false,
    });
    expect(result.shadow).toBeUndefined();
  });
});

describe("VaultSecuredProject", () => {
  const base = {
    name: "payments",
    databaseType: "postgresql",
    vaultUrl: "https://vault.example.com",
    environments: [
      { name: "staging", url: "jdbc:postgresql://staging:5432/pay" },
      { name: "prod", url: "jdbc:postgresql://prod:5432/pay" },
    ],
  };

  test("returns project, vaultResolver, environments, config", () => {
    const result = VaultSecuredProject(base);
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("vaultResolver");
    expect(result).toHaveProperty("environments");
    expect(result).toHaveProperty("config");
  });

  test("vaultResolver has url and token", () => {
    const result = VaultSecuredProject(base);
    expect(result.vaultResolver.url).toBe("https://vault.example.com");
    expect(result.vaultResolver.token).toBeDefined();
  });

  test("default vault token is ${env.VAULT_TOKEN}", () => {
    const result = VaultSecuredProject(base);
    expect(result.vaultResolver.token).toBe("${env.VAULT_TOKEN}");
  });

  test("environments have ${vault.<name>_user} and ${vault.<name>_password} patterns", () => {
    const result = VaultSecuredProject(base);
    expect(result.environments.staging.user).toBe("${vault.staging_user}");
    expect(result.environments.staging.password).toBe("${vault.staging_password}");
    expect(result.environments.prod.user).toBe("${vault.prod_user}");
    expect(result.environments.prod.password).toBe("${vault.prod_password}");
  });

  test("custom userKey/passwordKey overrides", () => {
    const result = VaultSecuredProject({
      ...base,
      environments: [
        {
          name: "prod",
          url: "jdbc:postgresql://prod:5432/pay",
          userKey: "custom_usr",
          passwordKey: "custom_pwd",
        },
      ],
    });
    expect(result.environments.prod.user).toBe("${vault.custom_usr}");
    expect(result.environments.prod.password).toBe("${vault.custom_pwd}");
  });
});

describe("DockerDevEnvironment", () => {
  test("returns environment with provisioner=docker", () => {
    const { environment } = DockerDevEnvironment({ databaseType: "postgresql" });
    expect(environment.provisioner).toBe("docker");
  });

  test("postgresql gets jdbc:postgresql URL with default port 5432", () => {
    const { environment } = DockerDevEnvironment({ databaseType: "postgresql" });
    expect(environment.url).toBe("jdbc:postgresql://localhost:5432/flyway_dev");
  });

  test("mysql gets jdbc:mysql with port 3306", () => {
    const { environment } = DockerDevEnvironment({ databaseType: "mysql" });
    expect(environment.url).toBe("jdbc:mysql://localhost:3306/flyway_dev");
  });

  test("custom port overrides default", () => {
    const { environment } = DockerDevEnvironment({
      databaseType: "postgresql",
      port: 5433,
    });
    expect(environment.url).toBe("jdbc:postgresql://localhost:5433/flyway_dev");
  });

  test("custom dbName applied", () => {
    const { environment } = DockerDevEnvironment({
      databaseType: "postgresql",
      dbName: "mydb",
    });
    expect(environment.url).toBe("jdbc:postgresql://localhost:5432/mydb");
  });
});

describe("CiPipelineProject", () => {
  const base = { name: "svc", databaseType: "postgresql" };

  test("returns project, environment, config", () => {
    const result = CiPipelineProject(base);
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("environment");
    expect(result).toHaveProperty("config");
  });

  test("environment has ${env.<PREFIX>_URL/USER/PASSWORD}", () => {
    const result = CiPipelineProject({ ...base, envVarPrefix: "DB" });
    expect(result.environment.url).toBe("${env.DB_URL}");
    expect(result.environment.user).toBe("${env.DB_USER}");
    expect(result.environment.password).toBe("${env.DB_PASSWORD}");
  });

  test("default prefix is FLYWAY", () => {
    const result = CiPipelineProject(base);
    expect(result.environment.url).toBe("${env.FLYWAY_URL}");
    expect(result.environment.user).toBe("${env.FLYWAY_USER}");
    expect(result.environment.password).toBe("${env.FLYWAY_PASSWORD}");
  });

  test("config has strict settings: validateOnMigrate=true, cleanDisabled=true", () => {
    const result = CiPipelineProject(base);
    expect(result.config.validateOnMigrate).toBe(true);
    expect(result.config.cleanDisabled).toBe(true);
  });
});

describe("GcpSecuredProject", () => {
  const base = {
    name: "orders",
    databaseType: "postgresql",
    gcpProject: "my-gcp-123",
    environments: [
      { name: "staging", url: "jdbc:postgresql://staging:5432/orders" },
      { name: "prod", url: "jdbc:postgresql://prod:5432/orders" },
    ],
  };

  test("returns project, gcpResolver, environments, config", () => {
    const result = GcpSecuredProject(base);
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("gcpResolver");
    expect(result).toHaveProperty("environments");
    expect(result).toHaveProperty("config");
  });

  test("gcpResolver has projectId", () => {
    const result = GcpSecuredProject(base);
    expect(result.gcpResolver.projectId).toBe("my-gcp-123");
  });

  test("environments have ${googlesecrets.<name>-<env>-db-user} patterns", () => {
    const result = GcpSecuredProject(base);
    expect(result.environments.staging.user).toBe("${googlesecrets.orders-staging-db-user}");
    expect(result.environments.staging.password).toBe(
      "${googlesecrets.orders-staging-db-password}",
    );
    expect(result.environments.prod.user).toBe("${googlesecrets.orders-prod-db-user}");
    expect(result.environments.prod.password).toBe("${googlesecrets.orders-prod-db-password}");
  });

  test("custom secret names override", () => {
    const result = GcpSecuredProject({
      ...base,
      environments: [
        {
          name: "prod",
          url: "jdbc:postgresql://prod:5432/orders",
          userSecret: "my-custom-user",
          passwordSecret: "my-custom-pwd",
        },
      ],
    });
    expect(result.environments.prod.user).toBe("${googlesecrets.my-custom-user}");
    expect(result.environments.prod.password).toBe("${googlesecrets.my-custom-pwd}");
  });
});

describe("BlueprintMigrationSet", () => {
  test("versioned migration: V1__Create_users_table.sql", () => {
    const { migrations } = BlueprintMigrationSet({
      versions: [{ version: "1", description: "Create users table" }],
    });
    expect(migrations[0].fileName).toBe("V1__Create_users_table.sql");
    expect(migrations[0].version).toBe("1");
    expect(migrations[0].type).toBe("V");
  });

  test("repeatable migration: R__Refresh_views.sql (no version)", () => {
    const { migrations } = BlueprintMigrationSet({
      versions: [{ version: "", description: "Refresh views", type: "R" }],
    });
    expect(migrations[0].fileName).toBe("R__Refresh_views.sql");
    expect(migrations[0].version).toBeUndefined();
    expect(migrations[0].type).toBe("R");
  });

  test("undo migration: U1__Create_users_table.sql", () => {
    const { migrations } = BlueprintMigrationSet({
      versions: [{ version: "1", description: "Create users table", type: "U" }],
    });
    expect(migrations[0].fileName).toBe("U1__Create_users_table.sql");
    expect(migrations[0].type).toBe("U");
  });

  test("callbacks: afterMigrate.sql", () => {
    const { callbacks } = BlueprintMigrationSet({
      versions: [],
      callbacks: ["afterMigrate", "beforeClean"],
    });
    expect(callbacks[0].fileName).toBe("afterMigrate.sql");
    expect(callbacks[0].event).toBe("afterMigrate");
    expect(callbacks[1].fileName).toBe("beforeClean.sql");
    expect(callbacks[1].event).toBe("beforeClean");
  });

  test("custom separator and extension", () => {
    const { migrations, callbacks } = BlueprintMigrationSet({
      versions: [{ version: "1", description: "Init schema" }],
      callbacks: ["afterMigrate"],
      separator: "___",
      extension: "pgsql",
    });
    expect(migrations[0].fileName).toBe("V1___Init_schema.pgsql");
    expect(callbacks[0].fileName).toBe("afterMigrate.pgsql");
  });
});

describe("DesktopProject", () => {
  const base = {
    name: "my-project",
    databaseType: "postgresql",
    devUrl: "jdbc:postgresql://localhost:5432/devdb",
    shadowUrl: "jdbc:postgresql://localhost:5432/shadowdb",
  };

  test("returns project, config, desktop, development, shadow, environments", () => {
    const result = DesktopProject(base);
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("config");
    expect(result).toHaveProperty("desktop");
    expect(result).toHaveProperty("development");
    expect(result).toHaveProperty("shadow");
    expect(result).toHaveProperty("environments");
  });

  test("project.name matches input", () => {
    const result = DesktopProject(base);
    expect(result.project.name).toBe("my-project");
  });

  test("development env has correct url and schemas", () => {
    const result = DesktopProject(base);
    expect(result.development.url).toBe("jdbc:postgresql://localhost:5432/devdb");
    expect(result.development.schemas).toEqual(["public"]);
    expect(result.development.name).toBe("development");
  });

  test("shadow env has provisioner=clean", () => {
    const result = DesktopProject(base);
    expect(result.shadow.url).toBe("jdbc:postgresql://localhost:5432/shadowdb");
    expect(result.shadow.provisioner).toBe("clean");
    expect(result.shadow.schemas).toEqual(["public"]);
  });

  test("desktop has developmentEnvironment and shadowEnvironment pointing to env names", () => {
    const result = DesktopProject(base);
    expect(result.desktop.developmentEnvironment).toBe("development");
    expect(result.desktop.shadowEnvironment).toBe("shadow");
  });

  test("desktop has generate.undoScripts=true by default", () => {
    const result = DesktopProject(base);
    expect(result.desktop.generate).toEqual({ undoScripts: true });
  });

  test("config uses schemaModelLocation (not deprecated schemaModel)", () => {
    const result = DesktopProject(base);
    expect(result.config.schemaModelLocation).toBe("./schema-model");
    expect(result.config).not.toHaveProperty("schemaModel");
  });

  test("config has databaseType and validateMigrationNaming=true", () => {
    const result = DesktopProject(base);
    expect(result.config.databaseType).toBe("postgresql");
    expect(result.config.validateMigrationNaming).toBe(true);
    expect(result.config.locations).toEqual(["filesystem:migrations"]);
  });

  test("downstream environments are created", () => {
    const result = DesktopProject({
      ...base,
      environments: [
        { name: "test", url: "jdbc:postgresql://test:5432/db" },
        { name: "prod", url: "jdbc:postgresql://prod:5432/db" },
      ],
    });
    expect(Object.keys(result.environments)).toHaveLength(2);
    expect(result.environments.test.url).toBe("jdbc:postgresql://test:5432/db");
    expect(result.environments.prod.url).toBe("jdbc:postgresql://prod:5432/db");
  });

  test("downstream environments inherit schemas", () => {
    const result = DesktopProject({
      ...base,
      schemas: ["app", "public"],
      environments: [{ name: "prod", url: "jdbc:postgresql://prod:5432/db" }],
    });
    expect(result.environments.prod.schemas).toEqual(["app", "public"]);
    expect(result.development.schemas).toEqual(["app", "public"]);
    expect(result.shadow.schemas).toEqual(["app", "public"]);
  });

  test("compare section only present when filterFile provided", () => {
    const without = DesktopProject(base);
    expect(without.compare).toBeUndefined();

    const with_ = DesktopProject({ ...base, filterFile: "./Filter.scpf" });
    expect(with_.compare).toEqual({ filterFile: "./Filter.scpf" });
  });

  test("custom schemaModelLocation and undoScripts=false", () => {
    const result = DesktopProject({
      ...base,
      schemaModelLocation: "./models",
      undoScripts: false,
    });
    expect(result.config.schemaModelLocation).toBe("./models");
    expect(result.desktop.generate).toEqual({ undoScripts: false });
  });
});

describe("environmentGroup", () => {
  test("returns environment props for each entry", () => {
    const result = environmentGroup({
      environments: {
        dev: { url: "jdbc:postgresql://localhost:5432/dev" },
        prod: { url: "jdbc:postgresql://prod:5432/app" },
      },
    });
    expect(Object.keys(result)).toHaveLength(2);
    expect(result.dev.url).toBe("jdbc:postgresql://localhost:5432/dev");
    expect(result.prod.url).toBe("jdbc:postgresql://prod:5432/app");
  });

  test("adds name from the key", () => {
    const result = environmentGroup({
      environments: {
        dev: { url: "jdbc:postgresql://localhost:5432/dev" },
      },
    });
    expect(result.dev.name).toBe("dev");
  });

  test("inherits shared schemas", () => {
    const result = environmentGroup({
      schemas: ["app", "public"],
      environments: {
        dev: { url: "jdbc:postgresql://localhost:5432/dev" },
        staging: { url: "jdbc:postgresql://staging:5432/app" },
      },
    });
    expect(result.dev.schemas).toEqual(["app", "public"]);
    expect(result.staging.schemas).toEqual(["app", "public"]);
  });

  test("per-environment schemas override shared schemas", () => {
    const result = environmentGroup({
      schemas: ["public"],
      environments: {
        dev: { url: "jdbc:postgresql://localhost:5432/dev", schemas: ["dev_schema"] },
      },
    });
    expect(result.dev.schemas).toEqual(["dev_schema"]);
  });

  test("deep-merges shared flyway config into environments", () => {
    const result = environmentGroup({
      flyway: {
        locations: ["filesystem:migrations"],
        cleanDisabled: true,
        placeholders: { appName: "myapp", logLevel: "info" },
      },
      environments: {
        dev: {
          url: "jdbc:postgresql://localhost:5432/dev",
          flyway: {
            cleanDisabled: false,
            placeholders: { logLevel: "debug" },
          },
        },
        staging: {
          url: "jdbc:postgresql://staging:5432/app",
        },
        prod: {
          url: "jdbc:postgresql://prod:5432/app",
          flyway: {
            validateOnMigrate: true,
            placeholders: { logLevel: "warn" },
          },
        },
      },
    });

    // dev: cleanDisabled overridden, logLevel overridden, appName inherited
    const devFlyway = result.dev.flyway as Record<string, unknown>;
    expect(devFlyway.cleanDisabled).toBe(false);
    expect(devFlyway.locations).toEqual(["filesystem:migrations"]);
    expect(devFlyway.placeholders).toEqual({ appName: "myapp", logLevel: "debug" });

    // staging: inherits all shared flyway config
    const stagingFlyway = result.staging.flyway as Record<string, unknown>;
    expect(stagingFlyway.cleanDisabled).toBe(true);
    expect(stagingFlyway.placeholders).toEqual({ appName: "myapp", logLevel: "info" });

    // prod: validateOnMigrate added, logLevel overridden, appName inherited
    const prodFlyway = result.prod.flyway as Record<string, unknown>;
    expect(prodFlyway.validateOnMigrate).toBe(true);
    expect(prodFlyway.cleanDisabled).toBe(true);
    expect(prodFlyway.placeholders).toEqual({ appName: "myapp", logLevel: "warn" });
  });

  test("arrays are replaced, not concatenated", () => {
    const result = environmentGroup({
      flyway: {
        locations: ["filesystem:shared"],
      },
      environments: {
        dev: {
          url: "jdbc:postgresql://localhost:5432/dev",
          flyway: {
            locations: ["filesystem:dev-only"],
          },
        },
      },
    });

    const devFlyway = result.dev.flyway as Record<string, unknown>;
    expect(devFlyway.locations).toEqual(["filesystem:dev-only"]);
  });

  test("no flyway section when neither shared nor per-env flyway provided", () => {
    const result = environmentGroup({
      environments: {
        dev: { url: "jdbc:postgresql://localhost:5432/dev" },
      },
    });
    expect(result.dev.flyway).toBeUndefined();
  });

  test("only per-env flyway used when no shared flyway", () => {
    const result = environmentGroup({
      environments: {
        dev: {
          url: "jdbc:postgresql://localhost:5432/dev",
          flyway: { cleanDisabled: false },
        },
      },
    });
    const devFlyway = result.dev.flyway as Record<string, unknown>;
    expect(devFlyway.cleanDisabled).toBe(false);
  });

  test("preserves additional environment properties", () => {
    const result = environmentGroup({
      environments: {
        prod: {
          url: "jdbc:postgresql://prod:5432/app",
          user: "${env.DB_USER}",
          password: "${env.DB_PASSWORD}",
          provisioner: "clean",
        },
      },
    });
    expect(result.prod.user).toBe("${env.DB_USER}");
    expect(result.prod.password).toBe("${env.DB_PASSWORD}");
    expect(result.prod.provisioner).toBe("clean");
  });
});
