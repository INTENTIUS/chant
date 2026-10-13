import { NodeImage } from "./shared/node-image";

const api = NodeImage({ port: 8080, main: "api.js" });

export { api };
