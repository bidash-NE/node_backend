# Stage 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Copy expo service package files
COPY expo_push_notification/package*.json ./expo_push_notification/

# Install dependencies
WORKDIR /app/expo_push_notification
RUN npm ci --include=dev

# Copy prisma schema from root (where it actually exists)
COPY prisma /app/prisma

# Generate Prisma Client (point to the schema location)
WORKDIR /app
RUN npx prisma generate --schema=./prisma/schema.prisma

# Copy expo service source code
COPY expo_push_notification /app/expo_push_notification
COPY lib /app/lib

# Prune dev dependencies
WORKDIR /app/expo_push_notification
RUN npm prune --production

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# Install OpenSSL for Prisma runtime
RUN apk add --no-cache openssl

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy from builder
COPY --from=builder --chown=nodejs:nodejs /app/expo_push_notification/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/expo_push_notification/package*.json ./
COPY --from=builder --chown=nodejs:nodejs /app/expo_push_notification ./
COPY --from=builder --chown=nodejs:nodejs /app/generated ./generated
COPY --from=builder --chown=nodejs:nodejs /app/lib ./lib
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma

# Switch to non-root user
USER nodejs

# Environment variables
ENV NODE_ENV=production
ENV PORT=3007

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3007/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)})"

EXPOSE 3007

# Start the application
CMD ["node", "server.js"]