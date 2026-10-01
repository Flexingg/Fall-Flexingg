# Gauntlet: API + PWA in one image. Build from the repo root:
#   docker build -t gauntlet .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/api apps/api
COPY apps/web apps/web
RUN pnpm --filter @gauntlet/web exec vite build \
 && pnpm --filter @gauntlet/api deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production \
    WEB_DIST=/app/web \
    PORT=8080
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /app/apps/web/dist ./web
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "--import", "tsx", "src/server.ts"]
