FROM node:22-alpine

RUN apk add --no-cache curl openssl

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN node scripts/write-build-info.mjs \
  && chmod +x scripts/run-with-restart-delay.sh \
  && mkdir -p /app/data/certs \
  && chown -R node:node /app

USER node
EXPOSE 3001 3443

CMD ["./scripts/run-with-restart-delay.sh"]
