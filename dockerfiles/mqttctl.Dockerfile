FROM node:24-bookworm-slim AS build

WORKDIR /workspace/mqttctl

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY mqttctl/package.json mqttctl/package-lock.json ./
COPY mqttctl/mqttctl-fe/package.json ./mqttctl-fe/package.json
COPY mqttctl/mqttctl-api/package.json ./mqttctl-api/package.json
RUN npm install

COPY . /workspace
RUN npm run build

FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends mosquitto-clients ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY mqttctl/package.json mqttctl/package-lock.json ./
COPY mqttctl/mqttctl-fe/package.json ./mqttctl-fe/package.json
COPY mqttctl/mqttctl-api/package.json ./mqttctl-api/package.json
RUN npm install --omit=dev

COPY --from=build /workspace/mqttctl/mqttctl-fe/build ./mqttctl-fe/build
COPY --from=build /workspace/mqttctl/mqttctl-fe/static ./mqttctl-fe/static

EXPOSE 3000

CMD ["npm", "run", "start"]
