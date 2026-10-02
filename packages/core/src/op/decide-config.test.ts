/**
 * The `decide` block in chant.config, the activity's contract, and the step
 * builder (#2828: the systemone lexicon's plugin tests, re-homed in core).
 */

import { describe, expect, it } from "vitest";
import { ChantConfigSchema } from "../config";
import { decideContract } from "./activities/activity-contracts";
import * as activities from "./activities";
import { decide } from "./builders";

describe("decide.backends in chant.config", () => {
  const valid = (config: Record<string, unknown>) => ChantConfigSchema.safeParse(config).success;

  it("accepts env and brokered keys, and a keyless local backend", () => {
    expect(
      valid({
        decide: {
          backends: {
            systemone: { url: "https://api.typesafe.ai", key: { env: "TYPESAFE_API_KEY" } },
            studio: { url: "http://127.0.0.1:7071", key: { capability: "inference", member: "box" }, timeoutMs: 5000 },
            local: { url: "http://127.0.0.1:8080" },
          },
        },
      }),
    ).toBe(true);
  });

  it("refuses a literal key, an unknown field, and an unknown key in the block", () => {
    expect(valid({ decide: { backends: { s: { url: "https://x", key: "sk-literal" } } } })).toBe(false);
    expect(valid({ decide: { backends: { s: { url: "https://x", token: { env: "K" } } } } })).toBe(false);
    expect(valid({ decide: { backend: {} } })).toBe(false);
  });
});

describe("the decide activity and its contract", () => {
  it("is one of core's activities, with a contract of the same name", () => {
    expect(typeof (activities as Record<string, unknown>).decide).toBe("function");
    expect(decideContract.name).toBe("decide");
  });

  it("the contract refuses a literal key and an unknown arg", () => {
    expect(decideContract.args.safeParse({ point: "p", backends: { s: { url: "https://x", key: { env: "K" } } } }).success).toBe(true);
    expect(decideContract.args.safeParse({ point: "p", backends: { s: { url: "https://x", key: "sk-literal" } } }).success).toBe(false);
    expect(decideContract.args.safeParse({ point: "p", pont: "typo" }).success).toBe(false);
  });

  it("the builder makes a fastIdempotent decide step with the point first", () => {
    const step = decide("slice-tier", { read: { "work-item": "W-002" }, subject: "W-002", id: "tier" });
    expect(step).toMatchObject({ kind: "activity", fn: "decide", args: { point: "slice-tier", read: { "work-item": "W-002" }, subject: "W-002" }, profile: "fastIdempotent", id: "tier" });
  });
});
