# Backup and Restore

This runbook covers the two supported application database modes: SQLite and Postgres.

`mqttctl` snapshots are useful operator exports, but they are not a full disaster-recovery backup. They do not recreate app users, sessions, secrets, or DynSec client passwords. A recoverable backup needs the application database plus the runtime files that define the broker and deployment.

## What To Back Up

Back up these items together and store them somewhere encrypted:

- app database:
  - SQLite: the file from `MQTTCTL_SQLITE_PATH`
  - Postgres: a logical dump of the configured database
- control-plane runtime files:
  - `MQTTCTL_CONFIG_PATH`
  - `MQTTCTL_SECRETS_PATH`
  - optional `MQTTCTL_UI_OVERRIDE_CSS_PATH`
- broker-agent runtime file:
  - `MQTTCTL_BROKER_AGENT_CONFIG_PATH`
- Mosquitto runtime files:
  - main config from `broker.mainConfigPath`
  - DynSec state from `broker.dynsecStateFilePath`
  - persistence data directory, if Mosquitto persistence is enabled
  - TLS CA, public certs, and private keys needed by Mosquitto or broker-agent

For the compose layout in this repo, that usually means:

- `config/compose/gui-api/mqttctl.config.json`
- `config/compose/gui-api/mqttctl.secrets.json`
- `config/compose/gui-api/custom.css`
- `config/compose/gui-api/app-data/`
- `config/compose/mqtt-agent/broker-agent.config.json`
- `config/compose/mqtt-agent/mosquitto.conf`
- `config/compose/mqtt-agent/shared/data/`
- `config/compose/mqtt-agent/certs/`, if present

Do not commit backup archives. They contain secrets and often contain private keys.

## Consistency Rules

Use a short maintenance window when you need a single exact restore point.

1. Pause operator changes in the UI.
2. Avoid broker config pushes, DynSec mutations, reloads, restarts, and MQTT Explorer publish tests while the backup runs.
3. Prefer a storage snapshot or a stopped-service backup for Mosquitto data if exact broker state matters.
4. Record the control-plane build label shown in the UI sidebar or startup logs.

The app database can be backed up online with the database-native tools below. Broker files are separate from the app database, so include them in the same backup set.

## SQLite Backup

Preferred online backup, from a host or maintenance container that has `sqlite3`:

```bash
set -eu

BACKUP_DIR=/secure/backups/mqttctl/$(date -u +%Y%m%dT%H%M%SZ)
SQLITE_PATH=/absolute/path/to/mqttctl.sqlite

mkdir -p "$BACKUP_DIR"
sqlite3 "$SQLITE_PATH" ".backup '$BACKUP_DIR/mqttctl.sqlite'"
sha256sum "$BACKUP_DIR/mqttctl.sqlite" > "$BACKUP_DIR/SHA256SUMS"
```

If `sqlite3` is not available, take a cold file backup:

```bash
set -eu

BACKUP_DIR=/secure/backups/mqttctl/$(date -u +%Y%m%dT%H%M%SZ)
SQLITE_PATH=/absolute/path/to/mqttctl.sqlite

mkdir -p "$BACKUP_DIR"
# Stop only the control-plane process before copying these files.
cp -a "$SQLITE_PATH" "$BACKUP_DIR/mqttctl.sqlite"
for suffix in -wal -shm; do
  if [ -e "$SQLITE_PATH$suffix" ]; then
    cp -a "$SQLITE_PATH$suffix" "$BACKUP_DIR/mqttctl.sqlite$suffix"
  fi
done
sha256sum "$BACKUP_DIR"/mqttctl.sqlite* > "$BACKUP_DIR/SHA256SUMS"
```

Then archive the runtime files from the same maintenance window. Omit optional paths such as `custom.css` or `certs/` if your deployment does not use them.

```bash
tar -czf "$BACKUP_DIR/runtime-files.tgz" \
  config/compose/gui-api/mqttctl.config.json \
  config/compose/gui-api/mqttctl.secrets.json \
  config/compose/gui-api/custom.css \
  config/compose/mqtt-agent/broker-agent.config.json \
  config/compose/mqtt-agent/mosquitto.conf \
  config/compose/mqtt-agent/shared/data \
  config/compose/mqtt-agent/certs
```

Adjust paths for non-compose deployments.

## SQLite Restore

Restore into a stopped control plane.

1. Stop `mqttctl`.
2. Stop Mosquitto or broker-agent too if you are restoring broker files.
3. Move the current database aside before replacing it.
4. Restore the SQLite database file to `MQTTCTL_SQLITE_PATH`.
5. Restore runtime files and broker files from the same backup set.
6. Start Mosquitto or broker-agent.
7. Start `mqttctl`.

Example:

```bash
set -eu

BACKUP_DIR=/secure/backups/mqttctl/20260617T120000Z
SQLITE_PATH=/absolute/path/to/mqttctl.sqlite

mkdir -p "$(dirname "$SQLITE_PATH")"
if [ -e "$SQLITE_PATH" ]; then
  mv "$SQLITE_PATH" "$SQLITE_PATH.before-restore.$(date -u +%Y%m%dT%H%M%SZ)"
fi
rm -f "$SQLITE_PATH-wal" "$SQLITE_PATH-shm"
cp -a "$BACKUP_DIR/mqttctl.sqlite" "$SQLITE_PATH"
```

After startup, check the Dashboard, Audit page, DynSec page, and MQTT Config page before allowing normal writes.

## Postgres Backup

Use `pg_dump` from a trusted host, job, or admin container with network access to the database.

```bash
set -eu

BACKUP_DIR=/secure/backups/mqttctl/$(date -u +%Y%m%dT%H%M%SZ)
PGHOST=postgres.example.internal
PGPORT=5432
PGDATABASE=mqttctl
PGUSER=mqttctl
export PGPASSWORD='replace-with-postgres-password'

mkdir -p "$BACKUP_DIR"
pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$BACKUP_DIR/mqttctl.pgcustom" \
  "$PGDATABASE"
sha256sum "$BACKUP_DIR/mqttctl.pgcustom" > "$BACKUP_DIR/SHA256SUMS"
```

Archive the runtime and broker files from the same maintenance window. Omit optional paths such as `custom.css` or `certs/` if your deployment does not use them.

```bash
tar -czf "$BACKUP_DIR/runtime-files.tgz" \
  config/compose/gui-api/mqttctl.config.json \
  config/compose/gui-api/mqttctl.secrets.json \
  config/compose/gui-api/custom.css \
  config/compose/mqtt-agent/broker-agent.config.json \
  config/compose/mqtt-agent/mosquitto.conf \
  config/compose/mqtt-agent/shared/data \
  config/compose/mqtt-agent/certs
```

For Kubernetes, run the same logical dump against the service endpoint or use a scheduled database backup tool. Keep the config, secrets, PVC snapshots, and database dump under the same retention policy.

## Postgres Restore

Restore into an empty database when possible. This avoids mixing restored rows with stale rows.

1. Stop `mqttctl`.
2. Stop Mosquitto or broker-agent too if you are restoring broker files.
3. Create an empty target database or clear the existing target.
4. Restore with `pg_restore`.
5. Restore runtime files and broker files from the same backup set.
6. Start Mosquitto or broker-agent.
7. Start `mqttctl`.

Example restore into a fresh database:

```bash
set -eu

BACKUP_DIR=/secure/backups/mqttctl/20260617T120000Z
PGHOST=postgres.example.internal
PGPORT=5432
PGDATABASE=mqttctl
PGUSER=mqttctl
export PGPASSWORD='replace-with-postgres-password'

createdb "$PGDATABASE"
pg_restore \
  --dbname="$PGDATABASE" \
  --no-owner \
  --no-acl \
  "$BACKUP_DIR/mqttctl.pgcustom"
```

If you must restore over an existing database, stop the app first and use a controlled destructive restore:

```bash
pg_restore \
  --dbname="$PGDATABASE" \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  "$BACKUP_DIR/mqttctl.pgcustom"
```

After startup, check the Dashboard, Audit page, DynSec page, and MQTT Config page before allowing normal writes.

## Restore Verification

Run these checks after either SQLite or Postgres restore:

1. Confirm `mqttctl` starts without DB bootstrap errors.
2. Confirm the Dashboard shows broker reachability and DynSec readability.
3. Confirm the Audit page loads and export includes an integrity summary.
4. Confirm App Users contains the expected admin users.
5. Confirm the MQTT Config page can pull the broker config.
6. Confirm DynSec clients, groups, roles, ACLs, and default-role settings are present.
7. Confirm a non-production MQTT test client can authenticate with expected permissions.

Keep at least one recent restore test outside production. A backup that has never been restored is only an assumption.
