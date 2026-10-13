/**
 * The bounded replica wait (#3270), against a stand-in for the server's HTTP
 * interface: `SYSTEM SYNC REPLICA` times out the way the server does, and the
 * queue holds a part from a replica that is down. The two-replica e2e
 * (`rebuild-replicated.e2e.test.ts`) runs it against the pinned server.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { DDL_SETTINGS, ReplicaFetchError, syncReplicaWithin } from "./replicas";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

/** A server whose sync times out until `fetchedAfter` syncs, with one part from r2 in the queue until then. */
async function standIn(fetchedAfter = Infinity): Promise<{ url: string; syncs: Array<string | null> }> {
  const syncs: Array<string | null> = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URL(req.url ?? "/", "http://x").searchParams;
      const fetched = syncs.length >= fetchedAfter;
      if (body.startsWith("SYSTEM SYNC REPLICA")) {
        syncs.push(params.get("receive_timeout"));
        if (syncs.length > fetchedAfter) return void res.end("");
        res.statusCode = 408;
        return void res.end("Code: 159. DB::Exception: SYNC REPLICA shop.events: command timed out. See the 'receive_timeout' setting. (TIMEOUT_EXCEEDED)");
      }
      if (body.includes("system.replicas")) return void res.end(JSON.stringify({ replica_name: "r1", replica_is_active: { r1: 1, r2: 0 } }) + "\n");
      if (body.includes("system.replication_queue")) {
        return void res.end(fetched ? "" : JSON.stringify({ new_part_name: "202602_3_3_0", source_replica: "r2", last_exception: "Code: 210. Connection refused\nmore" }) + "\n");
      }
      res.statusCode = 400;
      res.end(`unexpected: ${body}`);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, syncs };
}

describe("a replica that is down", () => {
  test("DDL goes on without the inactive replicas of a Replicated database", () => {
    expect(DDL_SETTINGS).toEqual({ distributed_ddl_output_mode: "throw_only_active" });
  });

  test("a part on the down replica alone: the wait is bounded, and the error names the replica and the part", async () => {
    const { url, syncs } = await standIn();
    const err = await syncReplicaWithin({ url }, "shop", "events", { timeoutMs: 1500 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReplicaFetchError);
    expect((err as ReplicaFetchError).missing).toEqual([{ part: "202602_3_3_0", source: "r2", sourceActive: false, lastError: "Code: 210. Connection refused" }]);
    expect((err as Error).message).toMatch(
      /^shop\.events: waited \ds for replica r1 to fetch what the other replicas wrote, and 1 part\(s\) are still to fetch: 202602_3_3_0 from r2 \(inactive\) \(last fetch error: Code: 210\. Connection refused\)\. Those rows are on r2 alone/,
    );
    // Each sync waits no longer than what is left, in whole seconds.
    expect(syncs.every((s) => s === "1" || s === "2")).toBe(true);
  });

  test("fetched within the bound: the step goes on", async () => {
    const { url, syncs } = await standIn(1);
    const lines: string[] = [];
    await syncReplicaWithin({ url }, "shop", "events", { timeoutMs: 30_000, log: (l) => lines.push(l) });
    expect(syncs).toHaveLength(1);
    expect(lines).toEqual(["SYSTEM SYNC REPLICA `shop`.`events` LIGHTWEIGHT"]);
  });
});
