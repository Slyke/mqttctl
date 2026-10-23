FROM node:24.22.1-bookworm-slim AS build

WORKDIR /workspace/mqttctl

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY mqttctl/package.json mqttctl/package-lock.json ./
COPY mqttctl/mqttctl-fe/package.json ./mqttctl-fe/package.json
COPY mqttctl/mqttctl-api/package.json ./mqttctl-api/package.json
RUN npm ci

COPY . /workspace
# Keep this stage on the target platform (including native dependencies).
ARG BUILD_HASH
RUN npm run build && npm prune --omit=dev

FROM node:24.22.1-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends mosquitto-clients ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY mqttctl/package.json mqttctl/package-lock.json ./
COPY mqttctl/mqttctl-fe/package.json ./mqttctl-fe/package.json
COPY mqttctl/mqttctl-api/package.json ./mqttctl-api/package.json
COPY --from=build /workspace/mqttctl/node_modules ./node_modules
COPY mqttctl/mqttctl-fe/server.mjs ./mqttctl-fe/server.mjs

COPY --from=build /workspace/mqttctl/mqttctl-fe/build ./mqttctl-fe/build
COPY --from=build /workspace/mqttctl/mqttctl-fe/static ./mqttctl-fe/static

EXPOSE 3000

CMD ["npm", "run", "start"]
