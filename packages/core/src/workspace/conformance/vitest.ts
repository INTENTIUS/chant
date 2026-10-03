/**
 * The workspace reader conformance suite for vitest (#2657, #2679):
 * {@link describeWorkspaceReaderConformance} wraps the runner-neutral checks
 * of `./index` in `describe` and `it`, one test per listed command and one
 * for the workspace's files. {@link describeWorkspaceWriterConformance}
 * (#3159) does the same for the writer suite: one test per step of the
 * script, and one per check after it. This is the only module of the suite
 * that imports vitest; `@intentius/chant/workspace/conformance` imports no
 * runner.
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
  runWorkspaceWriterConformance,
  selectActions,
  WRITER_SCRIPT,
  type WorkspaceReaderConformanceConfig,
  type WorkspaceWriterConformanceConfig,
  type WorkspaceWriterConformanceReport,
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

/**
 * The writer suite in vitest: the runner-neutral run happens once, before the
 * tests, and each test reports its part of it. A step whose action the writer
 * does not list is skipped, as not applicable; the suite still performed it.
 */
export function describeWorkspaceWriterConformance(config: WorkspaceWriterConformanceConfig): void {
  const { checked } = selectActions(config.actions);
  describe(`workspace writer conformance (#3159): ${config.name}`, () => {
    let report: WorkspaceWriterConformanceReport | undefined;
    beforeAll(async () => {
      report = await runWorkspaceWriterConformance(config.writer, config);
    }, 900_000);
    const ran = () => {
      expect(report, "the writer suite did not run").toBeDefined();
      return report!;
    };

    for (const s of WRITER_SCRIPT) {
      if (!checked.includes(s.action)) {
        it.skip(`${s.id}: ${s.action} is not applicable, the writer does not list it in actions`, () => {});
        continue;
      }
      it(`${s.id}: writes through chant workspace ${s.action} alone, and every change it made is one chant reports`, () => {
        expect(ran().results.find((r) => r.id === s.id)?.problems).toEqual([]);
      });
    }
    it("facts() reads only through the read contract and changes nothing", () => expect(ran().after.facts).toEqual([]));
    it("the state directory holds only what privateState declares", () => expect(ran().after.state).toEqual([]));
    it("amnesia: with its private state deleted, the writer shows the same facts", () => expect(ran().after.amnesia).toEqual([]));
    it("everything the writer holds is in the repository, or one of ws-074's four exceptions", () => expect(ran().after.holds).toEqual([]));
    it("every fact the script produced reads back through the read contract, uncommitted ones included", () => expect(ran().after.readBack).toEqual([]));
  });
}

export * from "./index";
