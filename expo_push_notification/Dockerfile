# Stage 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Copy expo package files
COPY expo_push_notification/package*.json ./

# Install all dependencies
RUN npm ci --include=dev

# Copy prisma schema from root
COPY prisma ./prisma

# Generate Prisma Client to the correct location (../../generated from /app/expo)
# This will create /app/generated/prisma
RUN npx prisma generate --schema=./prisma/schema.prisma

# Copy expo source code
COPY expo_push_notification ./
COPY lib ./lib

# Prune dev dependencies
RUN npm prune --production

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./
COPY --from=builder --chown=nodejs:nodejs /app ./
COPY --from=builder --chown=nodejs:nodejs /app/generated ./generated

USER nodejs

ENV NODE_ENV=production
ENV PORT=3007

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3007/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)})"

EXPOSE 3007

CMD ["node", "server.js"]