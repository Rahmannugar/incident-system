#!/bin/sh
set -eu

provision_database() {
  psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 \
    --set database_user="$1" --set database_password="$2" --set database_name="$3" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', :'database_user', :'database_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'database_user')
\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'database_name', :'database_user')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'database_name')
\gexec
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
SQL
}

# Re-running provisioning adds missing databases without resetting existing credentials.
provision_database "$INCIDENT_SYSTEM_DATABASE_USER" "$INCIDENT_SYSTEM_DATABASE_PASSWORD" "$INCIDENT_SYSTEM_DATABASE_NAME"
provision_database "$INCIDENT_SYSTEM_IDENTITY_DATABASE_USER" "$INCIDENT_SYSTEM_IDENTITY_DATABASE_PASSWORD" "$INCIDENT_SYSTEM_IDENTITY_DATABASE_NAME"
provision_database "$INCIDENT_SYSTEM_ORDER_DATABASE_USER" "$INCIDENT_SYSTEM_ORDER_DATABASE_PASSWORD" "$INCIDENT_SYSTEM_ORDER_DATABASE_NAME"
provision_database "$INCIDENT_SYSTEM_PAYMENT_DATABASE_USER" "$INCIDENT_SYSTEM_PAYMENT_DATABASE_PASSWORD" "$INCIDENT_SYSTEM_PAYMENT_DATABASE_NAME"
