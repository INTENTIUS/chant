import { describe, test, expect } from "vitest";
import { fetchNormalizedHistory, type WorkflowHandleRaw } from "./run-client";

/**
 * `@temporalio/client`'s `WorkflowHandle.fetchHistory()` returns the raw
 * Temporal wire proto: `eventType` a numeric enum, `eventId`/
 * `scheduledEventId` protobuf `Long` instances, `eventTime` a
 * `{seconds, nanos}` Timestamp. What turns those into the friendly
 * `"EVENT_TYPE_ACTIVITY_TASK_SCHEDULED"` string / decimal strings is the
 * proto message's own `toJSON()` — confirmed against a real
 * `TestWorkflowEnvironment` run (Temporal SDK 1.17.2) during development.
 * These fixtures simulate exactly that: plain values by default, but with a
 * `toJSON()` on the fields that have one on the wire, so a JSON round-trip
 * behaves the same way it does against a real server.
 */
function fakeLong(n: number) {
  return { low: n, high: 0, unsigned: false, toJSON: () => String(n) };
}

function fakeTimestamp(seconds: number, nanos = 0) {
  return { seconds: fakeLong(seconds), nanos };
}

function makeHandle(events: unknown[]): WorkflowHandleRaw {
  return {
    workflowId: "wf",
    async fetchHistory() {
      return { events } as never;
    },
  } as unknown as WorkflowHandleRaw;
}

describe("fetchNormalizedHistory", () => {
  test("converts the raw wire shape to short eventType, decimal eventId, and a real Date", async () => {
    const raw = {
      eventId: fakeLong(7),
      eventTime: fakeTimestamp(1_788_000_000, 500_000_000),
      eventType: "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED",
      activityTaskScheduledEventAttributes: {
        activityId: "1",
        activityType: { name: "dup" },
      },
    };
    const history = await fetchNormalizedHistory(makeHandle([raw]));
    const event = history.events?.[0];
    expect(event?.eventType).toBe("ActivityTaskScheduled");
    expect(event?.eventId).toBe("7");
    expect(event?.eventTime).toBeInstanceOf(Date);
    expect(event?.eventTime?.getTime()).toBe(1_788_000_000_500);
    expect(event?.activityTaskScheduledEventAttributes).toEqual({ activityId: "1", activityType: { name: "dup" } });
  });

  test("ActivityTaskCompleted's scheduledEventId round-trips to a decimal string, joinable against eventId", async () => {
    const scheduled = {
      eventId: fakeLong(7),
      eventType: "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED",
      activityTaskScheduledEventAttributes: { activityId: "1", activityType: { name: "dup" } },
    };
    const completedEvent = {
      eventId: fakeLong(9),
      eventType: "EVENT_TYPE_ACTIVITY_TASK_COMPLETED",
      activityTaskCompletedEventAttributes: { scheduledEventId: fakeLong(7) },
    };
    const history = await fetchNormalizedHistory(makeHandle([scheduled, completedEvent]));
    expect(history.events?.[0].eventId).toBe(history.events?.[1].activityTaskCompletedEventAttributes?.scheduledEventId);
  });

  test("a short PascalCase eventType (already-normalized test fixture data) passes through unchanged", async () => {
    const history = await fetchNormalizedHistory(makeHandle([{ eventType: "ActivityTaskScheduled" }]));
    expect(history.events?.[0].eventType).toBe("ActivityTaskScheduled");
  });

  test("an ISO eventTime string (already-normalized data) round-trips to the same instant", async () => {
    const history = await fetchNormalizedHistory(makeHandle([{ eventTime: "2026-05-01T00:00:00.000Z" }]));
    expect(history.events?.[0].eventTime?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  test("no events → empty array, not an error", async () => {
    const history = await fetchNormalizedHistory(makeHandle([]));
    expect(history.events).toEqual([]);
  });
});
