export const config = {
  dynamoDB: [{ name: "products", partitionKey: "id" }],
  s3: [{ name: "documents", prefix: "data/" }],
};
