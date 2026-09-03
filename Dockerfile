# ---- build stage: compile native deps (better-sqlite3) ----
FROM node:20-slim AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package*.json ./
RUN npm install --omit=dev

# ---- runtime stage ----
FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY server ./server
COPY public ./public

WORKDIR /app/server
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "index.js"]
