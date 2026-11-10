/** #4964 on Forgejo: the check jobs for a product's own workflow, through the dialect. */
import { describe, expect, test } from "vitest";
import { forgejoProductCheckJobs } from "./product-check-jobs";

const yodel = { product: "yodel", noun: ["environment", "environments"] as [string, string], commands: {}, approve: "yodel approve {target} --plan {digest} {sign}", op: "yodel-apply", gateName: "yodel-apply-wave-{k}", approval: "per-wave" as const, bin: "yodel chant" };
const checkJob = { services: [{ name: "replay-postgres", image: "postgres:18.6", health: "pg_isready -h 127.0.0.1 -U postgres" }] };

describe("the check jobs in a product's own Forgejo workflow (#4964)", () => {
  test("the check job keeps its service; the signing job, keyless, sets enable-openid-connect; the check job asks for no token", () => {
    const { jobsDoc } = forgejoProductCheckJobs("default", { words: yodel, checkJob, evidence: { identity: "oidc" } });
    const check = jobsDoc.check as Record<string, unknown>;
    expect(Object.keys(check.services as object)).toEqual(["replay-postgres"]);
    expect(check["enable-openid-connect"]).toBeUndefined();
    expect((jobsDoc["check-evidence"] as Record<string, unknown>)["enable-openid-connect"]).toBe(true);
  });
});
