/**
 * The release train's workflows on GitHub (#5119): the member repository's,
 * which runs the release and answers the control repo, and the control
 * repo's, which starts the promote with dispatch tokens and nothing else.
 */

import { describe, expect, test } from "vitest";
import { resolveControlTarget } from "@intentius/chant/control/dispatch";
import { generateTrainControlPipeline, generateTrainMemberPipeline } from "./train-pipeline";
import { generateControlPipeline } from "./control-pipeline";

const control = resolveControlTarget({ repo: "github.com/acme/control", op: "deploy", tokenSecret: "PLYWOOD_CONTROL_TOKEN" }, "network");
const words = { product: "plywood" };

describe("the member repository's train workflow", () => {
  test("takes the train's dispatch, checks out the release's commit and runs chant run --components all --release", () => {
    const file = generateTrainMemberPipeline(control, { words });
    expect(file.path).toBe(".github/workflows/plywood-train.yml");
    expect(file.content).toMatch(/repository_dispatch:\n\s+types:\n\s+- plywood-train/);
    expect(file.content).toContain("ref: '${{ github.event.client_payload.commit || inputs.commit }}'");
    expect(file.content).toContain('npx --no-install chant run --components all --env "$env" --release "$release"');
    expect(file.content).toContain("CHANT_TRAIN_RELEASE: '${{ github.event.client_payload.release || inputs.release }}'");
  });

  test("answers the control repo with plywood-applied and the train's fields, whatever the run did, and only that step holds the token", () => {
    const yaml = generateTrainMemberPipeline(control, { words }).content;
    expect(yaml).toContain("if: '${{ !cancelled() }}'");
    expect(yaml).toContain('"event_type":"plywood-applied"');
    expect(yaml).toContain(`"train":"'"$train"'"`);
    expect(yaml.match(/secrets\.PLYWOOD_CONTROL_TOKEN/g)).toHaveLength(1);
    expect(yaml.indexOf("secrets.PLYWOOD_CONTROL_TOKEN")).toBeGreaterThan(yaml.indexOf("chant run --components all"));
  });

  test("the product's cloud login goes before the run, under the repository's own identity", () => {
    const login = { name: "Log in", uses: "example/login@v1" };
    const yaml = generateTrainMemberPipeline(control, { words, login: [login], permissions: { "id-token": "write" }, dir: "infra" }).content;
    expect(yaml.indexOf("example/login@v1")).toBeLessThan(yaml.indexOf("chant run --components all"));
    expect(yaml).toMatch(/permissions:\n\s+contents: write\n\s+id-token: write/);
    expect(yaml).toContain("working-directory: infra");
  });
});

describe("the control repo's train workflow", () => {
  test("starts the promote with one dispatch token per member repository and no credential step", () => {
    const file = generateTrainControlPipeline(["api", "web"], { words });
    expect(file.path).toBe(".github/workflows/plywood-train.yml");
    expect(file.content).toContain('workspace train promote "$env" ${train:+"$train"} --json');
    expect(file.content).toContain("CHANT_TRAIN_TOKEN_API: '${{ secrets.CHANT_TRAIN_TOKEN_API }}'");
    expect(file.content).toContain("CHANT_TRAIN_TOKEN_WEB: '${{ secrets.CHANT_TRAIN_TOKEN_WEB }}'");
    expect(file.content.match(/secrets\./g)).toHaveLength(2);
    expect(file.content).toMatch(/permissions:\n\s+contents: write\n(?!\s+id-token)/);
    expect(file.content).not.toMatch(/id-token|aws-actions|google-github-actions|azure\/login|configure-aws-credentials/);
    // One step that dispatches, after the checkout: nothing logs in anywhere.
    expect(file.content.match(/- (uses|name):/g)).toHaveLength(2);
  });

  test("the dependents workflow, which takes the members' answers, maps the same tokens", () => {
    const yaml = generateControlPipeline({ words, trainMembers: ["api", "web"] }).content;
    expect(yaml).toContain("CHANT_TRAIN_TOKEN_API: '${{ secrets.CHANT_TRAIN_TOKEN_API }}'");
    expect(yaml).toContain("CHANT_CONTROL_TRAIN: '${{ github.event.client_payload.train || inputs.train }}'");
    expect(yaml).toContain('workspace train promote "$tenv" "$train" --continue --json');
    expect(yaml).not.toMatch(/id-token/);
  });
});
