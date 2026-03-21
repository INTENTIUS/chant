import { Service } from "@intentius/chant-lexicon-docker";
import { MINIO_IMAGE } from "./config";

export const minio = new Service({
  image: MINIO_IMAGE,
  ports: ["9000:9000", "9001:9001"],
  networks: ["solrNet"],
  volumes: ["minioData:/data"],
  environment: {
    MINIO_ROOT_USER:     "minioadmin",
    MINIO_ROOT_PASSWORD: "minioadmin",
  },
  command: ["server", "/data", "--console-address", ":9001"],
  restart: "unless-stopped",
  healthcheck: {
    test: ["CMD", "curl", "-sf", "http://localhost:9000/minio/health/live"],
    interval: "10s",
    timeout: "5s",
    retries: 5,
  },
});
