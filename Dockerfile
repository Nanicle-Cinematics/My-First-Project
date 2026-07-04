# Used by Fly.io and any other Docker-based host.
FROM node:22-slim

# Tools needed to compile better-sqlite3 native bindings.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential ca-certificates postgresql-client curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# prisma (the CLI) is a devDependency, so it's only present for this step —
# `prisma generate` needs prisma/schema.prisma, which requires COPY . . to
# have already happened. Pruning afterward removes devDependencies but
# keeps the generated client output (node_modules/.prisma, @prisma/client),
# which aren't themselves devDependencies.
RUN npx prisma generate
RUN npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
