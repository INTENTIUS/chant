import { describe, test, expect } from "vitest";
import { httpCheck, statusOk, type HttpFetch } from "./http-check";

const res = (status: number, body = "") => ({ status, text: async () => body });

describe("statusOk (#typed-verify)", () => {
  test("any 2xx when no expectation, exact match otherwise", () => {
    expect(statusOk(200)).toBe(true);
    expect(statusOk(204)).toBe(true);
    expect(statusOk(404)).toBe(false);
    expect(statusOk(404, 404)).toBe(true);
    expect(statusOk(200, 201)).toBe(false);
  });
});

describe("httpCheck (#typed-verify)", () => {
  test("passes on 2xx and returns the status", async () => {
    const fetchFn: HttpFetch = async () => res(200);
    expect(await httpCheck({ url: "http://x" }, undefined, fetchFn)).toEqual({ status: 200 });
  });

  test("throws when the status doesn't match", async () => {
    const fetchFn: HttpFetch = async () => res(500, "boom");
    await expect(httpCheck({ url: "http://x" }, undefined, fetchFn)).rejects.toThrow(/status 500 \(want 2xx\)/);
  });

  test("checks a body substring when `contains` is set", async () => {
    const fetchFn: HttpFetch = async () => res(200, '{"name":"trio-bucket"}');
    expect(await httpCheck({ url: "http://x", contains: "trio-bucket" }, undefined, fetchFn)).toEqual({ status: 200 });
    await expect(
      httpCheck({ url: "http://x", contains: "missing" }, undefined, fetchFn),
    ).rejects.toThrow(/body missing "missing"/);
  });

  test("retries then succeeds", async () => {
    let n = 0;
    const fetchFn: HttpFetch = async () => (++n < 3 ? res(503) : res(200));
    expect(await httpCheck({ url: "http://x", retries: 3, intervalMs: 1 }, undefined, fetchFn)).toEqual({ status: 200 });
    expect(n).toBe(3);
  });

  test("surfaces a fetch (connection) error", async () => {
    const fetchFn: HttpFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(httpCheck({ url: "http://x" }, undefined, fetchFn)).rejects.toThrow(/ECONNREFUSED/);
  });
});
