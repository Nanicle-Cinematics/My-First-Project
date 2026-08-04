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

# Only package*.json and the schema are needed to build node_modules, so
# copying them alone keeps this layer cached until dependencies or the
# schema actually change -- the rest of the source arrives afterwards.
COPY package*.json ./
COPY prisma ./prisma

# All four steps MUST stay in one RUN. Each RUN is a layer, and deleting a
# file in a later layer does not reclaim its bytes -- the earlier layer
# still carries them and the image still ships them. Splitting this into
# separate RUNs is exactly why an earlier attempt at removing the ~70MB
# prisma CLI left the image size completely unchanged at 231MB.
#
#   npm install  - full install: prisma (the CLI) is a devDependency and
#                  is required by the generate step below
#   generate     - must be explicit; @prisma/client does not build its
#                  query engine during a plain install, and omitting this
#                  is what crash-looped the app during the Phase 8g cutover
#   prune        - drops devDependencies, but NOT prisma: @prisma/client
#                  declares it an optional PEER dependency, so npm keeps it
#                  in the production tree whatever package.json says
#   rm           - therefore removes the CLI explicitly
#
# Removing the CLI is safe because it is build-time only: the query engine
# lives in node_modules/.prisma/client/, which nothing here touches, and
# @prisma/client never requires the prisma package at runtime. Verified by
# running this sequence locally, then booting the real server with the CLI
# absent and getting {"status":"ready","db":"ok"} from /readyz -- the
# endpoint fly.toml health-checks -- on 6 of 6 attempts, with working
# generated model methods (church.count(), user.count()).
#
# If this regresses, the symptom is /readyz failing while /healthz passes,
# since only /readyz touches the database.
RUN npm install \
 && npx prisma generate \
 && npm prune --omit=dev \
 && rm -rf node_modules/prisma node_modules/.bin/prisma

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
