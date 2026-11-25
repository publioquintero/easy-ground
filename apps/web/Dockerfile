# Easy Ground web app: build the PWA with Node, serve it with nginx.
# Build context is the repo root (npm workspaces: apps/web depends on packages/core).

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages/core packages/core
COPY apps/web apps/web
RUN npm run build -w @easy-ground/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/healthz || exit 1
