/**
 * `heldElsewhere()` (#2162) — the runtime marker itself, its JSON-safe
 * normalized form, and the type-checking contract the compile-time-only
 * section proves against a real generated-style property interface.
 */

import { describe, test, expect } from "vitest";
import {
  HELD_ELSEWHERE_MARKER,
  HELD_ELSEWHERE_TAG,
  heldElsewhere,
  isHeldElsewhere,
  isNormalizedHeldElsewhere,
  normalizeHeldElsewhere,
} from "./held-elsewhere";

describe("heldElsewhere()", () => {
  test("returns a marker carrying by/reason, symbol-tagged", () => {
    const marker = heldElsewhere<number>({ by: "hpa", reason: "the autoscaler owns replicas after the first apply" });
    expect(isHeldElsewhere(marker)).toBe(true);
    expect((marker as unknown as { by: string }).by).toBe("hpa");
    expect((marker as unknown as { reason: string }).reason).toBe("the autoscaler owns replicas after the first apply");
  });

  test("isHeldElsewhere is false for an ordinary value and for a lookalike object missing the symbol", () => {
    expect(isHeldElsewhere(3)).toBe(false);
    expect(isHeldElsewhere(undefined)).toBe(false);
    expect(isHeldElsewhere(null)).toBe(false);
    // Same shape, no marker: a plain object an author happened to write with
    // `by`/`reason` keys must never be mistaken for the real thing.
    expect(isHeldElsewhere({ by: "hpa", reason: "not actually held" })).toBe(false);
  });

  test("the marker's own symbol key never enumerates through Object.entries/JSON.stringify", () => {
    const marker = heldElsewhere<number>({ by: "hpa", reason: "x" });
    expect(Object.entries(marker as unknown as object)).toEqual([
      ["by", "hpa"],
      ["reason", "x"],
    ]);
    // The marker key is invisible to a JSON round-trip — this is exactly why
    // `deep-observation.ts` normalizes it to a JSON-safe tagged form instead
    // of relying on the symbol surviving a `--json` snapshot.
    expect(JSON.parse(JSON.stringify(marker))).toEqual({ by: "hpa", reason: "x" });
  });

  test("HELD_ELSEWHERE_MARKER is the well-known chant symbol, stable across module instances", () => {
    expect(HELD_ELSEWHERE_MARKER).toBe(Symbol.for("chant.heldElsewhere"));
  });
});

describe("normalizeHeldElsewhere() / isNormalizedHeldElsewhere()", () => {
  test("normalizes to a JSON-safe tagged object", () => {
    const marker = heldElsewhere<number>({ by: "hpa", reason: "x" });
    const normalized = normalizeHeldElsewhere(marker as never);
    expect(normalized).toEqual({ heldElsewhere: HELD_ELSEWHERE_TAG, by: "hpa", reason: "x" });
    expect(isNormalizedHeldElsewhere(normalized)).toBe(true);
    // Round-trips through JSON — this is the shape that actually rides in
    // `--json` output, unlike the symbol-tagged runtime marker above.
    expect(isNormalizedHeldElsewhere(JSON.parse(JSON.stringify(normalized)))).toBe(true);
  });

  test("isNormalizedHeldElsewhere rejects an ordinary object and the un-normalized runtime marker", () => {
    expect(isNormalizedHeldElsewhere({ by: "hpa", reason: "x" })).toBe(false);
    expect(isNormalizedHeldElsewhere(heldElsewhere<number>({ by: "hpa", reason: "x" }))).toBe(false);
  });
});

// ── Compile-time-only: authoring-time type errors (never executed) ──────────
//
// A generated resource's props interface, shaped like a real lexicon's
// generated constructor argument (chant #2162's whole point: `heldElsewhere`
// must typecheck in exactly the position the property's own value would go,
// and nowhere else).
interface DeploymentSpecProps {
  replicas?: number;
  image: string;
}

function _typeChecksOnly(): void {
  // The success case: assignable where the property's own value goes,
  // exactly like a literal `replicas: 3` would be.
  const ok: DeploymentSpecProps = {
    image: "my-app:latest",
    replicas: heldElsewhere({ by: "hpa", reason: "the autoscaler owns replicas after the first apply" }),
  };
  void ok;

  const badType: DeploymentSpecProps = {
    image: "my-app:latest",
    // @ts-expect-error — replicas is a number; heldElsewhere<string>() does not typecheck against it.
    replicas: heldElsewhere<string>({ by: "hpa", reason: "x" }),
  };
  void badType;

  const badProperty: DeploymentSpecProps = {
    image: "my-app:latest",
    // @ts-expect-error — "nope" is not a key of DeploymentSpecProps at all.
    nope: heldElsewhere({ by: "hpa", reason: "x" }),
  };
  void badProperty;
}
void _typeChecksOnly;
