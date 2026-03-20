import { Service, Volume } from "@intentius/chant-lexicon-docker";

export const app = new Service({
  image: "nginx:alpine",
  ports: ["8080:80"],
  restart: "unless-stopped",
});

export const data = new Volume({});
