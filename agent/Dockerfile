# Voice agent. Build from the REPO ROOT, not from agent/:
#
#     docker build -f agent/Dockerfile -t voxikin-agent .
#
# The root is the context so api/schema.sql comes along. The agent applies the
# same schema the Care API does — one schema for the product, not one per lane —
# and an agent/-only context left that file outside the image, so the container
# threw on first boot the moment VOXIKIN_MIGRATE_ON_BOOT was on.
FROM node:22-slim

WORKDIR /app

# Copy package files and install dependencies
COPY agent/package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY agent ./

# The shared schema, at the path SqliteRepository._migrate() falls back to when
# the repo is not checked out beside it. Deployments against Turso apply the
# schema out of band and never read this; it is here so the local and
# first-run paths behave the same in a container as out of one.
COPY api/schema.sql ./schema.sql

# Documentation only — the platform picks the real port and passes it as $PORT.
EXPOSE 3001

# Health check — verify the server responds. Reads $PORT because the platform
# chooses it; a hardcoded 3001 reported the container unhealthy forever on any
# host that picked something else.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Start the server
CMD ["node", "src/server.js"]
