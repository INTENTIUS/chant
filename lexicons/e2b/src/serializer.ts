import type { Declarable } from "@intentius/chant/declarable";
import type { Serializer, SerializerResult } from "@intentius/chant/serializer";
import { templateProps, type TemplateProps } from "./resources";

/**
 * The e2b serializer: each declared `Template` becomes the pair of files
 * `e2b template build` reads, named after the template so several can sit in
 * one directory:
 *
 * - `e2b.<name>.Dockerfile`: `FROM`, then `ENV`, `WORKDIR` and one `RUN` per step;
 * - `e2b.<name>.toml`: the template's name, its Dockerfile, its start and
 *   ready commands, and its CPU, memory and team.
 *
 * The primary output is a JSON index of the templates, keyed by the name each
 * was exported as, with the two file names and the sizes. A build with no
 * templates (a project that only runs Ops here) gets an empty index.
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
      const config = `e2b.${name}.toml`;
      files[dockerfile] = renderDockerfile(props);
      files[config] = renderToml(name, dockerfile, props);
      index[exportName] = {
        name,
        dockerfile,
        config,
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

export function renderDockerfile(props: TemplateProps): string {
  const lines = [`FROM ${props.fromImage}`];
  for (const [key, value] of Object.entries(props.env ?? {})) lines.push(`ENV ${key}=${quote(value)}`);
  if (props.workdir) lines.push(`WORKDIR ${props.workdir}`);
  for (const step of props.run ?? []) lines.push(`RUN ${step}`);
  return lines.join("\n") + "\n";
}

export function renderToml(name: string, dockerfile: string, props: TemplateProps): string {
  const lines = [
    `# Built with: e2b template build --config e2b.${name}.toml`,
    `template_name = ${quote(name)}`,
    `dockerfile = ${quote(dockerfile)}`,
  ];
  if (props.startCmd) lines.push(`start_cmd = ${quote(props.startCmd)}`);
  if (props.readyCmd) lines.push(`ready_cmd = ${quote(props.readyCmd)}`);
  if (props.cpuCount !== undefined) lines.push(`cpu_count = ${props.cpuCount}`);
  if (props.memoryMB !== undefined) lines.push(`memory_mb = ${props.memoryMB}`);
  if (props.teamId) lines.push(`team_id = ${quote(props.teamId)}`);
  return lines.join("\n") + "\n";
}
