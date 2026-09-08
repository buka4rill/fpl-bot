# syntax=docker/dockerfile:1

# Pinned to match the pnpm version this repo was developed against
# (`pnpm --version` locally) — corepack refuses to silently drift.
ARG PNPM_VERSION=10.34.5

FROM node:20-alpine AS build
WORKDIR /app
# CI=true tells pnpm to trust pnpm-workspace.yaml's onlyBuiltDependencies
# non-interactively — without it, pnpm still refuses to run @parcel/watcher/
# unrs-resolver's install scripts even with that config present, since a
# `docker build` has no TTY to fall back to prompting on (confirmed live:
# the exact same config passes locally, where a TTY is available).
ENV CI=true
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Separate, from-scratch prod-only install rather than copying node_modules
# from the build stage — avoids carrying devDependencies (ts-node, jest,
# playwright, ...) into the runtime image.
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV CI=true
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
# Build output lands at dist/src/main.js, not dist/main.js — tsconfig's
# rootDir spans both src/ and scripts/ (see package.json's start:prod).
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/src/main.js"]
