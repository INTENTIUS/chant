import { describe, expect, test } from "vitest";
import { parse } from "pg-connection-string";
import { withLibpqSslMode } from "./client";

const ssl = (url: string) => parse(withLibpqSslMode(new URL(url)).toString()).ssl;

describe("withLibpqSslMode", () => {
  test("sslmode=require encrypts without verifying the certificate, as in psql", () => {
    expect(ssl("postgres://shop.abc123.eu-west-1.rds.amazonaws.com:5432/shop?sslmode=require")).toEqual({ rejectUnauthorized: false });
  });

  test("sslmode=verify-full still verifies", () => {
    expect(ssl("postgres://localhost:5432/shop?sslmode=verify-full")).toEqual({});
  });

  test("a url that sets uselibpqcompat itself is left alone", () => {
    const url = "postgres://localhost:5432/shop?sslmode=require&uselibpqcompat=false";
    expect(withLibpqSslMode(new URL(url)).toString()).toBe(url);
  });

  test("a url without sslmode is left alone", () => {
    const url = "postgres://localhost:5432/shop";
    expect(withLibpqSslMode(new URL(url)).toString()).toBe(url);
  });
});
