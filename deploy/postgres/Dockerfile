# One Postgres for both Gauntlet and its bundled SparkyFitness (separate databases and roles).
# SparkyFitness is tested on Postgres 18; Gauntlet works on 16+.
FROM postgres:18.3-alpine
COPY init.sh /docker-entrypoint-initdb.d/10-gauntlet.sh
