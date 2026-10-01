#!/bin/sh
# Runs once, when the data volume is empty. Creates:
#   gauntlet          role + database for the Gauntlet API
#   sparky            owner of sparkyfitness_db; CREATEROLE so SparkyFitness can create its
#                     restricted runtime role (sparky_app) itself on first boot
set -eu
: "${GAUNTLET_DB_PASSWORD:?set GAUNTLET_DB_PASSWORD}"
: "${SPARKY_DB_PASSWORD:?set SPARKY_DB_PASSWORD}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v gpw="$GAUNTLET_DB_PASSWORD" -v spw="$SPARKY_DB_PASSWORD" <<'SQL'
CREATE ROLE gauntlet LOGIN PASSWORD :'gpw';
CREATE DATABASE gauntlet OWNER gauntlet;
CREATE ROLE sparky LOGIN CREATEROLE PASSWORD :'spw';
CREATE DATABASE sparkyfitness_db OWNER sparky;
SQL
echo "gauntlet init: created databases gauntlet and sparkyfitness_db"
