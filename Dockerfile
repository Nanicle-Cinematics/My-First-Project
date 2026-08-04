# Used by Fly.io and any other Docker-based host.
FROM node:22-slim

# ca-certificates: required for sslmode=verify-full against Neon (lib/database-url.js).
# curl + gnupg: build-time only, to add the PostgreSQL apt repository key below.
# postgresql-client-17: required at RUNTIME -- lib/operations-scheduler.js shells
#   out to scripts/pg-backup.sh, which runs pg_dump inside this container.
# No compiler toolchain is needed: nothing in the dependency tree builds from
# source (Prisma ships prebuilt engines), since better-sqlite3 was removed.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# `prisma generate` needs prisma/schema.prisma, so this must run after
# COPY . . -- and it must run explicitly, because @prisma/client does not
# generate its query engine as part of a production install. Omitting this
# step is what crash-looped the app during the Phase 8g cutover.
#
# The prune does NOT drop the prisma CLI (~70MB): @prisma/client declares
# prisma as an OPTIONAL PEER dependency, so npm keeps it in the production
# tree no matter which package.json section lists it. Removing it therefore
# has to be explicit -- hence the rm below.
#
# This is safe because the CLI is only ever a build-time tool: the runtime
# query engine is generated into node_modules/.prisma/client/ (a separate
# directory the prune and the rm both leave alone), and @prisma/client
# never requires the prisma package at runtime. Verified by reproducing
# this exact sequence locally, then booting the real server with the CLI
# absent and getting {"status":"ready","db":"ok"} from /readyz -- the same
# endpoint fly.toml health-checks -- 6 times out of 6, plus working
# generated model methods (church.count(), user.count()).
#
# If this ever regresses, the symptom is /readyz failing while /healthz
# passes, since only /readyz touches the database.
RUN npx prisma generate
RUN npm prune --omit=dev
RUN rm -rf node_modules/prisma node_modules/.bin/prisma

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
