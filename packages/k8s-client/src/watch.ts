/**
 * The Kubernetes watch, as much of it as can be written without a client
 * (chant #1981).
 *
 * A watch is `GET <list path>?watch=1&resourceVersion=<rv>` answered with an
 * open connection that emits one JSON document per line — NDJSON, forever,
 * until somebody hangs up. Everything here is the frame side of that: parsing
 * lines out of a byte stream, reading a frame's `resourceVersion`, and
 * recognising the one failure a watch is expected to hit.
 *
 * ## `410 Gone`
 *
 * The API server keeps a bounded history of changes. A watch resuming from a
 * `resourceVersion` older than that window cannot be told what it missed, and
 * says so: an `ERROR` frame carrying a `Status` with `code: 410` / `reason:
 * Expired`. There is exactly one correct response, and it is not to retry with
 * the same `resourceVersion` — it is to LIST again, take the list's own
 * `resourceVersion`, and watch from there. Anything else silently drops
 * whatever happened during the gap.
 *
 * For chant's purposes the gap costs nothing anyway: the events are a trigger,
 * never a fact, and the tick they wake re-observes the estate from scratch. A
 * re-list is a re-list, not a reconciliation.
 */

import type { K8sObject } from "./types";

/** The event types the watch API emits. `BOOKMARK` requires `allowWatchBookmarks`. */
export type WatchEventType = "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | "ERROR";

/**
 * One decoded NDJSON frame. `object` is whatever the server put in the frame:
 * the changed resource for the four ordinary types, a `Status` for `ERROR`.
 */
export interface WatchFrame {
  type: WatchEventType;
  object: K8sObject;
}

const EVENT_TYPES = new Set<string>(["ADDED", "MODIFIED", "DELETED", "BOOKMARK", "ERROR"]);

/**
 * Split a chunk of a watch stream into whole frames, carrying the trailing
 * partial line over to the next call.
 *
 * Frames arrive split across TCP reads at arbitrary byte offsets, so a decoder
 * that treats each chunk as a set of complete lines drops or corrupts every
 * frame that straddles a boundary. `carry` is the fix and the reason this is a
 * function rather than three lines inline.
 *
 * A line that is not JSON, or is JSON without a known `type`, is dropped
 * rather than thrown: a watch is a trigger channel, and the correct response
 * to a frame nobody can read is to keep watching.
 */
export function parseWatchFrames(
  chunk: string,
  carry = "",
): { frames: WatchFrame[]; carry: string } {
  const combined = carry + chunk;
  const lines = combined.split("\n");
  // The last element is either "" (the chunk ended on a newline) or a partial
  // line still waiting for its remainder.
  const rest = lines.pop() ?? "";
  const frames: WatchFrame[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const { type, object } = parsed as { type?: unknown; object?: unknown };
    if (typeof type !== "string" || !EVENT_TYPES.has(type)) continue;
    frames.push({
      type: type as WatchEventType,
      object: (object && typeof object === "object" ? object : {}) as K8sObject,
    });
  }

  return { frames, carry: rest };
}

/**
 * Whether this frame is the API server saying the watch's `resourceVersion` has
 * aged out of its history — the `410 Gone` that means re-list, not retry.
 *
 * Matched on `code` first and `reason` second, because both are set on the
 * `Status` the server sends and a cluster that sets only one of them is still
 * telling us the same thing.
 */
export function isExpiredFrame(frame: WatchFrame): boolean {
  if (frame.type !== "ERROR") return false;
  const status = frame.object as { code?: unknown; reason?: unknown };
  if (status.code === 410) return true;
  return status.reason === "Expired" || status.reason === "Gone";
}

/** The `resourceVersion` to resume from after this frame, when it carries one. */
export function resourceVersionOf(frame: WatchFrame): string | undefined {
  const rv = frame.object?.metadata?.resourceVersion;
  return typeof rv === "string" && rv.length > 0 ? rv : undefined;
}

/**
 * Decode whatever a response body's `stream()` returned into lines of text.
 *
 * Three shapes reach here and all three are real: a web `ReadableStream` (what
 * `undici`'s `fetch` gives client-node's HTTP library, and so what a live
 * cluster produces), a Node `Readable` or any other async iterable (what a
 * hand-rolled transport gives), and `undefined` for a transport with no
 * streaming seam at all — a fake that answered the whole body at once, which
 * is handled by the caller reading `text()` instead.
 */
export async function* streamLines(source: unknown): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let carry = "";

  const emit = function* (chunk: string): Generator<string> {
    const lines = (carry + chunk).split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) yield line;
  };

  const decode = (value: unknown): string =>
    typeof value === "string" ? value : decoder.decode(value as Uint8Array, { stream: true });

  if (source && typeof (source as { getReader?: unknown }).getReader === "function") {
    const reader = (source as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield* emit(decode(value));
      }
    } finally {
      // Releasing matters: an un-released reader keeps the connection's
      // backpressure machinery alive after the watch is done with it.
      try {
        reader.releaseLock();
      } catch {
        // Already released, or the stream is gone. Either is fine.
      }
    }
  } else if (source && typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    for await (const value of source as AsyncIterable<unknown>) {
      yield* emit(decode(value));
    }
  } else {
    return;
  }

  if (carry.trim()) yield carry;
}
