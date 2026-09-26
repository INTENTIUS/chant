import { describe, expect, it } from "vitest";
import { Op, phase } from "@intentius/chant/op";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { decide } from "../../op/builders";
import { plainRemoteHost, sys010 } from "./sys010-key-over-plain-http";
import { backendEntities } from "../../backend-entities";

const ctx = (op: unknown): PostSynthContext => ({ outputs: new Map(), entities: new Map([["op", op as never]]), buildResult: {} as never }) as unknown as PostSynthContext;

describe("SYS010", () => {
  it("fires when a decide step sends a key over plain http to a remote host", () => {
    const op = Op({ name: "ask", overview: "ask", phases: [phase("Ask", [decide("triage", { backends: { s: { url: "http://jev.example.com", key: { env: "K" } } } })])] });
    const d = sys010.check(ctx(op));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ checkId: "SYS010", severity: "error" });
    expect(d[0].message).toContain("jev.example.com");
  });

  it("is quiet for https, for loopback, and for a backend with no key", () => {
    const op = Op({
      name: "ask",
      overview: "ask",
      phases: [
        phase("Ask", [
          decide("a", { backends: { s: { url: "https://api.typesafe.ai", key: { env: "K" } } } }),
          decide("b", { backends: { s: { url: "http://127.0.0.1:8080", key: { env: "K" } } } }),
          decide("c", { backends: { s: { url: "http://jev.example.com" } } }),
          decide("d"),
        ]),
      ],
    });
    expect(sys010.check(ctx(op))).toEqual([]);
  });

  it("fires on a configured backend entity, and is quiet for https", () => {
    const entities = backendEntities({ systemone: { backends: { remote: { url: "http://jev.internal:8080", key: { env: "K" } }, ok: { url: "https://api.typesafe.ai", key: { env: "K" } } } } });
    const d = sys010.check({ outputs: new Map(), entities } as unknown as PostSynthContext);
    expect(d.map((x) => x.entity)).toEqual(["backend/remote"]);
  });

  it("reads hosts", () => {
    expect(plainRemoteHost("http://localhost:1")).toBeUndefined();
    expect(plainRemoteHost("http://[::1]:1")).toBeUndefined();
    expect(plainRemoteHost("http://10.0.0.2")).toBe("10.0.0.2");
    expect(plainRemoteHost("not a url")).toBeUndefined();
  });
});
