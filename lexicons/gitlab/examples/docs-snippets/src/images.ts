import { Image } from "@intentius/chant-lexicon-gitlab";

export const nodeImage = new Image({ name: "node:20-alpine" });

export const customImage = new Image({
  name: "registry.example.com/my-image:latest",
  entrypoint: ["/bin/sh", "-c"],
});
