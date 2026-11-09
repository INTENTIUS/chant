/**
 * GitLab's comment commands by polling (#4785): GitLab starts no pipeline on
 * a note, so with `noteCommands` a job of the target branch's pipeline,
 * started by a schedule with CHANT_NOTE_COMMANDS=1, polls the notes and
 * starts the jobs the commands ask for.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];
const WORDS = { product: "plywood", commands: { preview: "plan" as const, up: "apply" as const, lock: "lock" as const, unlock: "unlock" as const }, bin: "npx --no-install plywood" };

interface Job { stage: string; rules: Array<{ if: string }>; script: string[]; resource_group?: string }
type Doc = { workflow: { rules: Array<{ if: string }> }; stages: string[] } & Record<string, Job>;
const RULE = '$CI_PIPELINE_SOURCE =~ /^(schedule|web|api|trigger)$/ && $CHANT_NOTE_COMMANDS == "1" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH';

describe("the GitLab pipeline's note-commands job", () => {
  test("runs in a scheduled pipeline of the target branch, one at a time, with a flag per job a command starts", () => {
    const doc = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { words: WORDS, noteCommands: true, previewComment: true, applyBeforeMerge: true, locks: "plan" } }).yaml) as Doc;
    const job = doc["note-commands"]!;
    expect(job.rules).toEqual([{ if: RULE }]);
    expect(doc.workflow.rules.map((r) => r.if)).toContain(RULE);
    expect(doc.stages).toContain("note-commands");
    expect(job.resource_group).toBe("note-commands");
    expect(job.script.at(-1)).toBe("npx --no-install plywood components pr-notes --forge gitlab --preview-comment --apply-before-merge --locks");
  });

  test("an apply on merge retries its apply job, and a named branch is the job's", () => {
    const doc = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { noteCommands: true, applyOnMerge: true, branch: "trunk" } }).yaml) as Doc;
    expect(doc["note-commands"]!.script.at(-1)).toBe('chant components pr-notes --forge gitlab --branch "trunk" --apply-on-merge');
    expect(doc["note-commands"]!.rules[0]!.if).toContain('$CI_COMMIT_BRANCH == "trunk"');
  });

  test("no job without noteCommands", () => {
    const doc = parseYAML(generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { words: WORDS } }).yaml) as Doc;
    expect(doc["note-commands"]).toBeUndefined();
    expect(doc.workflow.rules.map((r) => r.if)).not.toContain(RULE);
  });
});
