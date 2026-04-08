#!/bin/sh
set -e

CERT_DIR="/certs"
CERT_FILE="$CERT_DIR/fullchain.pem"
KEY_FILE="$CERT_DIR/privkey.pem"

mkdir -p "$CERT_DIR"

# Install openssl if not present
if ! command -v openssl >/dev/null 2>&1; then
  apk add --no-cache openssl
fi

if [ ! -f "$CERT_FILE" ]; then
  echo "Generating self-signed certificate for $DOMAIN"

  openssl req -x509 -nodes -days 365 \
    -newkey rsa:2048 \
    -keyout "$KEY_FILE" \
    -out "$CERT_FILE" \
    -subj "/CN=$DOMAIN"
fi