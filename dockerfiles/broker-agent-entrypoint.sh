#!/bin/sh
set -eu

/usr/local/bin/init-broker-tls.sh
exec /docker-entrypoint.sh "$@"
