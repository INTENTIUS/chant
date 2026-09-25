/**
 * The workspace reader conformance suite for vitest (#2657, #2679):
 * {@link describeWorkspaceReaderConformance} wraps the runner-neutral checks
 * of `./index` in `describe` and `it`, one test per listed command and one
 * for the workspace's files. This is the only module of the suite that
 * imports vitest; `@intentius/chant/workspace/conformance` imports no runner.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  conformanceTarget,
  MCP_READ_TOOLS,
  READ_CONTRACT_COMMANDS,
  READ_CONTRACT_SCHEMAS,
  readAndCheck,
  recordingTransport,
  selectCommands,
  treeChanges,
  treeDigest,
  type WorkspaceReaderConformanceConfig,
} from "./index";

export function describeWorkspaceReaderConformance(config: WorkspaceReaderConformanceConfig): void {
  const { checked } = selectCommands(config.commands, config.over);
  let target: ReturnType<typeof conformanceTarget> | undefined;
  const recorder = recordingTransport(
    () => {
      if (!target) throw new Error("the conformance workspace is not ready");
      return target;
    },
    config.timeoutMs,
    config.over,
  );
  const over = config.over === "mcp" ? " over MCP (#2707)" : "";

  describe(`workspace reader conformance (#2657)${over}: ${config.name}`, () => {
    let before: Record<string, string> | undefined;
    const reader = config.reader(recorder.transport);

    beforeAll(() => {
      target = conformanceTarget(config);
    }, 300_000);
    afterAll(async () => {
      await recorder.close();
      target?.dispose();
    });

    for (const command of READ_CONTRACT_COMMANDS) {
      if (!checked.includes(command)) {
        it.skip(`${command}: not applicable, ${config.over === "mcp" && !MCP_READ_TOOLS[command] ? "chant serve mcp has no tool for it" : "the reader does not list it in commands"}`, () => {});
        continue;
      }
      it(
        `${command}: reads through chant workspace ${command} alone, and returns a document that validates against ${READ_CONTRACT_SCHEMAS[command]}`,
        async () => {
          before ??= treeDigest(target!.workspaceDir);
          const result = await readAndCheck(reader, recorder, command);
          expect(result.problems).toEqual([]);
        },
        120_000,
      );
    }

    it("leaves every file in the workspace as it was", () => {
      expect(before, "no read ran").toBeDefined();
      expect(treeChanges(before!, treeDigest(target!.workspaceDir))).toEqual([]);
    });
  });
}

export * from "./index";
