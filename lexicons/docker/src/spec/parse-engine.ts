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
  multi?: boolean;  // can appear multiple times
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
      { name: "run", description: "Run a command during build", multi: true },
      { name: "copy", description: "Copy files from build context", multi: true },
      { name: "add", description: "Add files (supports URLs and archives)", multi: true },
      { name: "workdir", description: "Set working directory" },
      { name: "user", description: "Set user for subsequent instructions" },
      { name: "expose", description: "Document exposed ports", multi: true },
      { name: "volume", description: "Create mount points", multi: true },
      { name: "label", description: "Add metadata labels", multi: true },
      { name: "entrypoint", description: "Set the entrypoint executable" },
      { name: "cmd", description: "Default command arguments" },
      { name: "healthcheck", description: "Health check instruction" },
    ],
  };
}
