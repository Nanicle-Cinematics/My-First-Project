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
# NOTE: the prune below does NOT drop the prisma CLI (~70MB), and moving
# prisma between dependencies and devDependencies does not change that:
# @prisma/client declares prisma as an OPTIONAL PEER dependency, so npm
# keeps it in the production tree either way (its package-lock entry has
# no "dev" flag). Verified empirically, not assumed.
#
# Dropping those 70MB requires deleting it outright after generate:
#   RUN rm -rf node_modules/prisma node_modules/.bin/prisma
# That looks safe -- the runtime query engine lives in
# node_modules/.prisma/client/ and @prisma/client never requires the CLI
# at runtime -- but it has not been proven in a real image build, and the
# failure mode is a container that boots green and dies on first query.
# Do it as its own change, with a deploy you watch.
RUN npx prisma generate
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
