# wallet_payment/Dockerfile

# Stage 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Copy root package files and root Prisma schema
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies including dev dependencies for prisma generate
RUN npm ci --include=dev

# Generate Prisma Client from root schema
RUN npx prisma generate

# Copy wallet service and shared lib
COPY wallet_payment ./wallet_payment
COPY lib ./lib

# Optional safety: make root lib available inside service folder too
RUN mkdir -p /app/wallet_payment/lib && \
    cp -a /app/lib/. /app/wallet_payment/lib/

# Prune dev dependencies for production
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
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/generated ./generated
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/lib ./lib
COPY --from=builder --chown=nodejs:nodejs /app/wallet_payment ./wallet_payment

# Switch to non-root user
USER nodejs

# Set working directory to wallet service
WORKDIR /app/wallet_payment

ENV NODE_ENV=production
ENV PORT=1111

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://localhost:1111/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)}).on('error', () => process.exit(1))"

EXPOSE 1111

CMD ["node", "server.js"]