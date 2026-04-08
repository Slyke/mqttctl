FROM node:24-bookworm-slim

WORKDIR /workspace/mqttctl

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ mosquitto-clients ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY mqttctl/package.json mqttctl/package-lock.json ./
COPY mqttctl/mqttctl-fe/package.json ./mqttctl-fe/package.json
COPY mqttctl/mqttctl-api/package.json ./mqttctl-api/package.json
RUN npm install

EXPOSE 3000
