import { describe, test, expect } from "bun:test";
import { resolve, placeholder, env, ResolverRefIntrinsic, PlaceholderRefIntrinsic, EnvRefIntrinsic } from "./intrinsics";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";

describe("intrinsics", () => {
  test("resolve() creates ResolverRefIntrinsic", () => {
    const ref = resolve("vault", "password");
    expect(ref).toBeInstanceOf(ResolverRefIntrinsic);
    expect(ref[INTRINSIC_MARKER]).toBe(true);
  });

  test("resolve() serializes to ${resolver.key}", () => {
    expect(resolve("vault", "password").toJSON()).toBe("${vault.password}");
    expect(resolve("googlesecrets", "db-url").toJSON()).toBe("${googlesecrets.db-url}");
    expect(resolve("dapr", "secret").toJSON()).toBe("${dapr.secret}");
  });

  test("placeholder() creates PlaceholderRefIntrinsic", () => {
    const ref = placeholder("defaultSchema");
    expect(ref).toBeInstanceOf(PlaceholderRefIntrinsic);
    expect(ref[INTRINSIC_MARKER]).toBe(true);
  });

  test("placeholder() serializes to ${flyway:name}", () => {
    expect(placeholder("defaultSchema").toJSON()).toBe("${flyway:defaultSchema}");
    expect(placeholder("user").toJSON()).toBe("${flyway:user}");
    expect(placeholder("database").toJSON()).toBe("${flyway:database}");
  });

  test("env() creates EnvRefIntrinsic", () => {
    const ref = env("DB_PASSWORD");
    expect(ref).toBeInstanceOf(EnvRefIntrinsic);
    expect(ref[INTRINSIC_MARKER]).toBe(true);
  });

  test("env() serializes to ${env.VAR_NAME}", () => {
    expect(env("DB_PASSWORD").toJSON()).toBe("${env.DB_PASSWORD}");
    expect(env("VAULT_TOKEN").toJSON()).toBe("${env.VAULT_TOKEN}");
  });
});
