#!/bin/sh
set -eu

# The application owns its database without bootstrap administrator privileges.
psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 \
  --set database_user="$INCIDENT_SYSTEM_DATABASE_USER" \
  --set database_password="$INCIDENT_SYSTEM_DATABASE_PASSWORD" \
  --set database_name="$INCIDENT_SYSTEM_DATABASE_NAME" <<'SQL'
CREATE ROLE :"database_user" LOGIN PASSWORD :'database_password'
    NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE :"database_name" OWNER :"database_user";
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
SQL
