/** chant#4910: the engine's environment without the forge's tokens, and the binary runner that applies it. */
import { describe, expect, test } from "vitest";
import { engineEnv, tokenlessBinaryExec, type BinaryExec } from "./exec";

describe("engineEnv (chant#4910)", () => {
  test("drops chant's forge token variables, the product's own, and any variable holding one's value, but never a TF_ variable", () => {
    const env = { PATH: "/bin", GITHUB_TOKEN: "ghs_1", TG_TOKEN: "glpat-2", GITLAB_TOKEN: "glpat-2", MY_COPY: "ghs_1", TF_VAR_token: "glpat-2", TF_HTTP_PASSWORD: "ghs_1", AWS_REGION: "eu-west-1" };
    expect(engineEnv(env, ["TG_TOKEN"])).toEqual({ PATH: "/bin", TF_VAR_token: "glpat-2", TF_HTTP_PASSWORD: "ghs_1", AWS_REGION: "eu-west-1" });
    expect(engineEnv({ TG_TOKEN: "x", PATH: "/bin" })).toEqual({ TG_TOKEN: "x", PATH: "/bin" });
  });

  test("tokenlessBinaryExec runs the binary with that environment", async () => {
    let got: NodeJS.ProcessEnv = {};
    const exec: BinaryExec = async (_b, _a, _d, env) => ((got = env), { code: 0, stdout: "", out: "" });
    await tokenlessBinaryExec(["TG_MERGE_TOKEN"], exec)("tofu", ["plan"], "/w", { TG_MERGE_TOKEN: "m", CI_JOB_TOKEN: "j", HOME: "/h" });
    expect(got).toEqual({ HOME: "/h" });
  });
});
