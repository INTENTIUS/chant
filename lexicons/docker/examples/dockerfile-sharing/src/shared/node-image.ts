import { Composite } from "@intentius/chant";
import { Dockerfile, type DockerfileStage } from "@intentius/chant-lexicon-docker";
import { NODE_IMAGE, nodeBuild, nodeRuntime } from "./node";

export interface NodeImageProps {
  /** The port the service listens on. */
  port: number;
  /** The script in dist/ to run. */
  main: string;
}

/** A whole Node service Dockerfile from two parameters. Its file is Dockerfile.<export>Image. */
export const NodeImage = Composite((props: NodeImageProps) => {
  const runtime: DockerfileStage = {
    from: NODE_IMAGE,
    steps: [
      ...nodeRuntime,
      { expose: props.port },
      { cmd: ["node", `dist/${props.main}`] },
    ],
  };
  const image = new Dockerfile({ stages: [nodeBuild, runtime] });
  return { image };
}, "NodeImage");
