/**
 * #4572: `ci.identity.cloud.azure.database` asks the trade for a second
 * Entra token per identity, for Azure Database for PostgreSQL's scope, set
 * as AZURE_DATABASE_ACCESS_TOKEN. Pure checks of the spec and the script;
 * nothing reaches Entra.
 */

import { describe, expect, test } from "vitest";
import {
  AZURE_DATABASE_SCOPE,
  AZURE_DATABASE_TOKEN_ENV,
  AZURE_DATABASE_TOKEN_FLOOR,
  resolveCloudIdentity,
  TRADE_JS,
  TRADED_VARS,
  type CloudIdentityDeclaration,
} from "./ci-identity";
import { NEXT_RELEASE } from "./release-floors";

const azure = (database?: boolean): CloudIdentityDeclaration => ({
  azure: {
    tenantId: "00000000-0000-0000-0000-000000000001",
    ...(database === undefined ? {} : { database }),
    rules: [{ plan: "11111111-1111-1111-1111-111111111111", apply: "22222222-2222-2222-2222-222222222222" }],
  },
});

describe("azure database tokens", () => {
  test("database: true reaches both trades", () => {
    const id = resolveCloudIdentity(azure(true), "prod")!;
    expect(id.plan.azure?.database).toBe(true);
    expect(id.apply.azure?.database).toBe(true);
  });

  test("without database the trade asks for no database token", () => {
    expect(resolveCloudIdentity(azure(), "prod")!.plan.azure).not.toHaveProperty("database");
    expect(resolveCloudIdentity(azure(false), "prod")!.plan.azure).not.toHaveProperty("database");
  });

  test("the script asks for the database scope only under z.database and sets the variable", () => {
    expect(TRADE_JS).toContain(`if(z.database)`);
    expect(TRADE_JS).toContain(JSON.stringify(AZURE_DATABASE_SCOPE));
    expect(TRADE_JS).toContain(`${AZURE_DATABASE_TOKEN_ENV}:db`);
    // The script sits in single quotes on a shell line.
    expect(TRADE_JS).not.toContain("'");
  });

  test("the database token is a traded variable, so steps that drop cloud credentials drop it", () => {
    expect(TRADED_VARS.azure).toContain(AZURE_DATABASE_TOKEN_ENV);
  });

  test("the floor is the next release", () => {
    expect(AZURE_DATABASE_TOKEN_FLOOR).toBe(NEXT_RELEASE);
  });
});
