import { describe, expect, it } from "vitest";
import { Op, phase, decide } from "../../../op";
import type { PostSynthContext } from "../../post-synth";
import { plainRemoteHost, sys010, sys010Check } from "./sys010-key-over-plain-http";
import { coreOpChecks } from "./index";

const ctx = (op?: unknown): PostSynthContext => ({ outputs: new Map(), entities: new Map(op ? [["op", op as never]] : []), buildResult: {} as never }) as unknown as PostSynthContext;

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

  it("fires on a backend configured in decide.backends, and is quiet for https", () => {
    const check = sys010Check({ remote: { url: "http://jev.internal:8080", key: { env: "K" } }, ok: { url: "https://api.typesafe.ai", key: { env: "K" } } });
    const d = check.check(ctx());
    expect(d.map((x) => x.entity)).toEqual(["decide.backends.remote"]);
  });

  it("runs with core's Op checks, with the configured backends when given", () => {
    expect(coreOpChecks().map((c) => c.id)).toContain("SYS010");
    const configured = coreOpChecks({ decideBackends: { remote: { url: "http://10.0.0.2", key: { env: "K" } } } }).find((c) => c.id === "SYS010")!;
    expect(configured.check(ctx())).toHaveLength(1);
  });

  it("reads hosts", () => {
    expect(plainRemoteHost("http://localhost:1")).toBeUndefined();
    expect(plainRemoteHost("http://[::1]:1")).toBeUndefined();
    expect(plainRemoteHost("http://10.0.0.2")).toBe("10.0.0.2");
    expect(plainRemoteHost("not a url")).toBeUndefined();
  });
});
