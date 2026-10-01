# SparkyFitness's Garmin Connect service, unchanged except that its listen address is a setting
# (GARMIN_SERVICE_HOST, default 0.0.0.0 as before). Fly.io's private network is IPv6-only and the
# stock image can't listen there, so Fly sets GARMIN_SERVICE_HOST=::
ARG SPARKY_VERSION=v1.7.3
FROM codewithcj/sparkyfitness_garmin:${SPARKY_VERSION}
USER root
RUN grep -q 'host="0.0.0.0"' /app/main.py \
 && sed -i 's/host="0.0.0.0"/host=os.getenv("GARMIN_SERVICE_HOST", "0.0.0.0")/' /app/main.py \
 && grep -q GARMIN_SERVICE_HOST /app/main.py \
 && python -c "import ast,sys; ast.parse(open('/app/main.py').read())"
USER daemon
