import { Service } from "@intentius/chant-lexicon-docker";
import { DYNAMO_IMAGE } from "./config";

export const dynamo = new Service({
  image: DYNAMO_IMAGE,
  ports: ["8000:8000"],
  networks: ["solrNet"],
  command: ["-jar", "DynamoDBLocal.jar", "-sharedDb", "-inMemory"],
  restart: "unless-stopped",
});
