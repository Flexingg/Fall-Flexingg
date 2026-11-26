# Backup service: same Postgres 18 alpine base as deploy/postgres, so pg_dump/pg_restore match the
# server. jq reads the request files, tzdata makes BACKUP_TIME follow TZ.
FROM postgres:18.3-alpine
RUN apk add --no-cache jq tzdata
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
# The postgres image's entrypoint would start a database; this service only runs the loop.
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["loop"]
