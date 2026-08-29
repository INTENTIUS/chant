import { describe, test, expect } from "vitest";
import { createMockPlugin, staticObservation } from "@intentius/chant-test-utils";
import { observation } from "../observation";
import { assertLiveEntity, LiveAssertionError, UnobservedAssertionError } from "./assert-live";
import type { ResourceMetadata } from "../lexicon";

const MARKER = { stack: "shop", env: "test-suite-abc123" };

const meta = (overrides: Partial<ResourceMetadata> = {}): ResourceMetadata => ({
  type: "Mock::Queue",
  status: "READY",
  marker: MARKER,
  ownership: "owned",
  ...overrides,
});

const call = (opts: Partial<Parameters<typeof assertLiveEntity>[0]> = {}) =>
  assertLiveEntity({
    plugin: createMockPlugin(),
    name: "taskQueue",
    entityType: "Mock::Queue",
    props: {},
    buildOutput: "",
    environment: MARKER.env,
    marker: MARKER,
    ...opts,
  });

describe("assertLiveEntity", () => {
  test("resolves the metadata for an observed, marker-matched entity", async () => {
    const plugin = createMockPlugin({ describeResources: staticObservation({ taskQueue: meta() }) });
    await expect(call({ plugin })).resolves.toEqual(meta());
  });

  test("checks status when given, passes when it matches", async () => {
    const plugin = createMockPlugin({ describeResources: staticObservation({ taskQueue: meta({ status: "READY" }) }) });
    await expect(call({ plugin, status: "READY" })).resolves.toEqual(meta());
  });

  test("throws naming the entity when observed absent", async () => {
    const plugin = createMockPlugin({ describeResources: staticObservation({}) });
    await expect(call({ plugin })).rejects.toThrow(LiveAssertionError);
    await expect(call({ plugin })).rejects.toThrow(/taskQueue.*observed absent/s);
  });

  test("throws UnobservedAssertionError, not a plain failure, when NOT-OBSERVED", async () => {
    const plugin = createMockPlugin({
      describeResources: staticObservation({}, { taskQueue: { reason: "no-credentials", type: "Mock::Queue" } }),
    });
    const err = await call({ plugin }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnobservedAssertionError);
    expect(err).not.toBeInstanceOf(LiveAssertionError);
    expect((err as UnobservedAssertionError).reason).toBe("no-credentials");
  });

  test("a thrown describeResources degrades to NOT-OBSERVED read-failed, never a silent absence", async () => {
    const plugin = createMockPlugin({
      describeResources: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const err = await call({ plugin }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnobservedAssertionError);
    expect((err as UnobservedAssertionError).reason).toBe("read-failed");
    expect((err as UnobservedAssertionError).detail).toContain("ECONNREFUSED");
  });

  test("a lexicon with no describeResources is NOT-OBSERVED, unsupported-kind", async () => {
    const plugin = createMockPlugin();
    const err = await call({ plugin }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnobservedAssertionError);
    expect((err as UnobservedAssertionError).reason).toBe("unsupported-kind");
  });

  test("throws when the observed marker names a foreign stack", async () => {
    const plugin = createMockPlugin({
      describeResources: staticObservation({ taskQueue: meta({ marker: { stack: "other-stack", env: MARKER.env } }) }),
    });
    await expect(call({ plugin })).rejects.toThrow(/not this deploy's/);
  });

  test("throws when the observed marker names a foreign env — a same-named leftover from another run", async () => {
    const plugin = createMockPlugin({
      describeResources: staticObservation({ taskQueue: meta({ marker: { stack: MARKER.stack, env: "test-other-999999" } }) }),
    });
    await expect(call({ plugin })).rejects.toThrow(LiveAssertionError);
  });

  test("throws when the entity is confirmed foreign (no marker, ownership foreign)", async () => {
    const plugin = createMockPlugin({
      describeResources: staticObservation({
        taskQueue: meta({ marker: undefined, ownership: "foreign" }),
      }),
    });
    await expect(call({ plugin })).rejects.toThrow(/not this deploy's/);
  });

  test("passes through an entity whose lexicon has no marker channel (ownership unknown, no marker) rather than always failing", async () => {
    const plugin = createMockPlugin({
      describeResources: staticObservation({
        taskQueue: meta({ marker: undefined, ownership: "unknown" }),
      }),
    });
    await expect(call({ plugin })).resolves.toEqual(meta({ marker: undefined, ownership: "unknown" }));
  });

  test("throws a status mismatch after identity is confirmed", async () => {
    const plugin = createMockPlugin({ describeResources: staticObservation({ taskQueue: meta({ status: "PENDING" }) }) });
    await expect(call({ plugin, status: "READY" })).rejects.toThrow(/status "PENDING"/);
  });

  test("uses the observation() envelope form identically to the bare-map form", async () => {
    const plugin = createMockPlugin({ describeResources: async () => observation({ taskQueue: meta() }) });
    await expect(call({ plugin })).resolves.toEqual(meta());
  });
});
