# The app's own image. delivery/ builds it with this directory as the context.
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/server.mjs"]
