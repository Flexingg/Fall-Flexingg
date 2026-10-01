# SparkyFitness's Garmin Connect service, started through serve.py so it listens on IPv4 and IPv6
# (see serve.py for why). Everything else is the official image, unchanged.
ARG SPARKY_VERSION=v1.7.3
FROM codewithcj/sparkyfitness_garmin:${SPARKY_VERSION}
COPY serve.py /app/serve.py
CMD ["python", "serve.py"]
