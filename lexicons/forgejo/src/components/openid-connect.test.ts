/** #4753: a Forgejo job that asks for an OIDC token sets enable-openid-connect. */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { generateForgejoOpPipeline } from "./generate-op-pipeline";
import { withOpenIdConnect } from "./ci-jobs";

type Job = Record<string, unknown>;
const jobs = (yaml: string) => (parseYAML(yaml) as { jobs: Record<string, Job> }).jobs;

describe("enable-openid-connect on Forgejo (#4753)", () => {
  test("a scheduled Op whose permissions ask for id-token: write gets it on its job; one that does not, does not", () => {
    const withToken = jobs(generateForgejoOpPipeline([{ name: "drift", schedule: "0 6 * * *", permissions: { "id-token": "write" } }]).files[0]!.yaml);
    expect(withToken.drift!["enable-openid-connect"]).toBe(true);
    const without = jobs(generateForgejoOpPipeline([{ name: "drift", schedule: "0 6 * * *" }]).files[0]!.yaml);
    expect(without.drift!["enable-openid-connect"]).toBeUndefined();
  });

  test("a job's own permissions decide over the workflow's", () => {
    const out = withOpenIdConnect({ a: { steps: [] }, b: { permissions: { "id-token": "write" } }, c: { permissions: { contents: "read" } } }, { "id-token": "write" });
    expect(out.a).toMatchObject({ "enable-openid-connect": true });
    expect(out.b).toMatchObject({ "enable-openid-connect": true });
    expect(out.c).not.toHaveProperty("enable-openid-connect");
    expect(withOpenIdConnect({ a: {} }, { contents: "read" }).a).toEqual({});
  });
});
