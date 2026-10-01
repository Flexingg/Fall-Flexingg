# The SparkyFitness website, unchanged except that app sign-in returns are handed to Gauntlet
# (see redirect.sh). Build with --build-arg GAUNTLET_URL=https://gauntlet.example.com
ARG SPARKY_VERSION=v1.7.3
FROM codewithcj/sparkyfitness:${SPARKY_VERSION}
ARG GAUNTLET_URL=
COPY redirect.sh /tmp/redirect.sh
USER root
RUN sh /tmp/redirect.sh "${GAUNTLET_URL}" && rm /tmp/redirect.sh
