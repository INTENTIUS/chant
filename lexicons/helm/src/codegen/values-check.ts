/**
 * Type-check a parsed values file against an inferred values type: the check
 * a pull request can run on a values file without rendering the chart.
 */

import { ts } from "@intentius/chant/lint/typescript";

/** The compiler's messages for `const v: <type> = <values>`; none means the values fit. */
export function typecheckValues(type: string, values: unknown): string[] {
  const code = `type Values = ${type};\nexport const v: Values = ${JSON.stringify(values ?? {})};\n`;
  const fileName = "/virtual/values-check.ts";
  const options: ts.CompilerOptions = { strict: true, noEmit: true, lib: ["lib.es2022.d.ts"], types: [] };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (name, lang, ...rest) =>
    name === fileName ? ts.createSourceFile(name, code, lang) : original.call(host, name, lang, ...rest);
  const program = ts.createProgram([fileName], options, host);
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(fileName)).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}
