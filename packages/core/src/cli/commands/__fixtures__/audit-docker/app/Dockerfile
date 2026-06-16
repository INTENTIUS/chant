FROM node:20
RUN apt-get update && apt-get install -y curl
COPY . /app
CMD ["node", "server.js"]
