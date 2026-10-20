import type { Declarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import { templateProps, type TemplateProps } from "./resources";

/**
 * The e2b serializer: each declared `Template` becomes `e2b.<name>.Dockerfile`
 * (`FROM`, then `ENV`, `WORKDIR` and one `RUN` per step), named after the
 * template so several can sit in one directory.
 *
 * The primary output is a JSON index of the templates, keyed by the name each
 * was exported as. Each entry carries the Dockerfile's name and `build`, the
 * `e2b template create` command line that builds the template from it, run in
 * the output directory. A build with no templates (a project that only runs
 * Ops here) gets an empty index.
 */
export const e2bSerializer: Serializer = {
  name: "e2b",
  rulePrefix: "E2B",
  serialize(entities: Map<string, Declarable>): SerializerResult {
    const index: Record<string, unknown> = {};
    const files: Record<string, string> = {};

    const templates = [...entities]
      .map(([exportName, entity]) => [exportName, templateProps(entity)] as const)
      .filter((e): e is readonly [string, TemplateProps] => e[1] !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));

    for (const [exportName, props] of templates) {
      const name = props.name || exportName;
      const dockerfile = `e2b.${name}.Dockerfile`;
      files[dockerfile] = renderDockerfile(props);
      index[exportName] = {
        name,
        dockerfile,
        build: createCommand(name, dockerfile, props),
        ...(props.cpuCount !== undefined ? { cpuCount: props.cpuCount } : {}),
        ...(props.memoryMB !== undefined ? { memoryMB: props.memoryMB } : {}),
      };
    }

    return {
      primary: JSON.stringify({ templates: index }, null, 2) + "\n",
      files,
      verbatimFiles: Object.keys(files),
    };
  },
};

/** A Dockerfile string literal: Docker reads double-quoted values with JSON's escapes. */
const quote = (value: string): string => JSON.stringify(value);

/** A word as one shell argument. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9._:@+=/,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderDockerfile(props: TemplateProps): string {
  const lines = [`FROM ${props.fromImage}`];
  for (const [key, value] of Object.entries(props.env ?? {})) lines.push(`ENV ${key}=${quote(value)}`);
  if (props.workdir) lines.push(`WORKDIR ${props.workdir}`);
  for (const step of props.run ?? []) lines.push(`RUN ${step}`);
  return lines.join("\n") + "\n";
}

/** The `e2b template create` command line that builds the template, run where the Dockerfile is. */
export function createCommand(name: string, dockerfile: string, props: TemplateProps): string {
  const args = ["e2b", "template", "create", name, "--dockerfile", dockerfile];
  if (props.startCmd) args.push("--cmd", props.startCmd);
  if (props.readyCmd) args.push("--ready-cmd", props.readyCmd);
  if (props.cpuCount !== undefined) args.push("--cpu-count", String(props.cpuCount));
  if (props.memoryMB !== undefined) args.push("--memory-mb", String(props.memoryMB));
  return args.map(shellWord).join(" ");
}
