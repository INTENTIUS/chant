/**
 * Parse the Docker Engine API OpenAPI spec for Dockerfile-related types.
 *
 * We extract only the image-builder relevant definitions:
 * ContainerConfig, BuildInfo, and related types.
 */

export interface DockerfileParseResult {
  typeName: string;       // "Docker::Dockerfile"
  shortName: string;      // "Dockerfile"
  description?: string;
  instructions: DockerfileInstruction[];
}

export interface DockerfileInstruction {
  name: string;
  description?: string;
  multi?: boolean;  // can appear multiple times (as a per-kind field, an array)
  /**
   * Only available as a step (`{ shell: ... }` in `steps`), not as a per-kind
   * field. The per-kind fields keep the set and fixed order they always had.
   */
  stepOnly?: boolean;
  /** As a step, the value may be a JSON exec-form array as well as a string. */
  execForm?: boolean;
  /** As a step, the value may be a number as well as a string. */
  numeric?: boolean;
}

/**
 * Parse the Docker Engine API YAML buffer for Dockerfile instruction types.
 * Returns a single DockerfileParseResult describing the Dockerfile entity.
 */
export function parseEngineApi(_data: Buffer): DockerfileParseResult {
  return {
    typeName: "Docker::Dockerfile",
    shortName: "Dockerfile",
    description: "A Dockerfile definition with ordered build instructions",
    instructions: [
      { name: "from", description: "Base image (required first instruction)" },
      { name: "arg", description: "Build-time argument", multi: true },
      { name: "env", description: "Environment variable", multi: true },
      { name: "run", description: "Run a command during build", multi: true, execForm: true },
      { name: "copy", description: "Copy files from build context", multi: true },
      { name: "add", description: "Add files (supports URLs and archives)", multi: true },
      { name: "workdir", description: "Set working directory" },
      { name: "user", description: "Set user for subsequent instructions" },
      { name: "expose", description: "Document exposed ports", multi: true, numeric: true },
      { name: "volume", description: "Create mount points", multi: true },
      { name: "label", description: "Add metadata labels", multi: true },
      { name: "entrypoint", description: "Set the entrypoint executable", execForm: true },
      { name: "cmd", description: "Default command arguments", execForm: true },
      { name: "healthcheck", description: "Health check instruction" },
      { name: "shell", description: "Set the shell for shell-form commands (JSON array form)", stepOnly: true, execForm: true },
      { name: "stopsignal", description: "Signal sent to stop the container", stepOnly: true },
      { name: "onbuild", description: "Instruction to run when the image is used as a base", stepOnly: true },
    ],
  };
}
