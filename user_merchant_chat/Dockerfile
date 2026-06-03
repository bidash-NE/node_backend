# user_merchant_chat/Dockerfile

# =========================
# Stage 1: Builder
# =========================
FROM node:20-alpine AS builder

WORKDIR /app

# Required by Prisma runtime/client generation
RUN apk add --no-cache openssl

# Copy root package + Prisma files
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies including dev dependencies for prisma generate
RUN npm ci --include=dev

# Generate Prisma client
RUN npx prisma generate

# Copy service and shared libraries
COPY user_merchant_chat ./user_merchant_chat
COPY lib ./lib

# Safety: support both require("../lib/prisma") and require("./lib/prisma")
RUN mkdir -p /app/user_merchant_chat/lib && \
    cp -a /app/lib/. /app/user_merchant_chat/lib/

# Remove dev dependencies for production
RUN npm prune --production


# =========================
# Stage 2: Production
# =========================
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

# Non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Create upload directory for chat images
RUN mkdir -p /app/user_merchant_chat/uploads/chat && \
    chown -R nodejs:nodejs /app/user_merchant_chat/uploads

# Copy production build
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/generated ./generated
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/lib ./lib
COPY --from=builder --chown=nodejs:nodejs /app/user_merchant_chat ./user_merchant_chat

USER nodejs

WORKDIR /app/user_merchant_chat

ENV NODE_ENV=production
ENV PORT=4010
ENV UPLOAD_ROOT=/app/user_merchant_chat/uploads

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4010/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

EXPOSE 4010

CMD ["node", "server.js"]