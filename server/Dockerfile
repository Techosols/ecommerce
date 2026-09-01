# One image, two commands (§1.1): the API and the worker can never drift apart.
#   API    → node dist/main/api.js     (the default CMD)
#   worker → node dist/main/worker.js

FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

USER node
EXPOSE 4000
# tini reaps zombies and forwards SIGTERM, which the graceful shutdown depends on.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main/api.js"]
