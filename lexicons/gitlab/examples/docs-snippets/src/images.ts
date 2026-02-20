import * as _ from "./_";

export const nodeImage = new _.Image({ name: "node:20-alpine" });

export const customImage = new _.Image({
  name: "registry.example.com/my-image:latest",
  entrypoint: ["/bin/sh", "-c"],
});
