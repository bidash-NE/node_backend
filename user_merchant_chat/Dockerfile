# user_merchant_chat/Dockerfile

# =========================
# Stage 1: Builder
# =========================
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

# Copy service package files, not root package files
COPY user_merchant_chat/package*.json ./user_merchant_chat/

# Copy root Prisma files because Prisma schema/client is shared
COPY prisma ./prisma/

# Copy shared lib
COPY lib ./lib/

# Install dependencies inside service folder
WORKDIR /app/user_merchant_chat
RUN npm ci --include=dev

# Generate Prisma from root prisma schema
WORKDIR /app
RUN ./user_merchant_chat/node_modules/.bin/prisma generate --schema=./prisma/schema.prisma

# Copy full service source
COPY user_merchant_chat ./user_merchant_chat

# Make shared lib available from both paths:
# - /app/lib
# - /app/user_merchant_chat/lib
RUN mkdir -p /app/user_merchant_chat/lib && \
    cp -a /app/lib/. /app/user_merchant_chat/lib/

# Prune dev dependencies from service node_modules
WORKDIR /app/user_merchant_chat
RUN npm prune --production


# =========================
# Stage 2: Production
# =========================
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

RUN mkdir -p /app/user_merchant_chat/uploads/chat && \
    chown -R nodejs:nodejs /app/user_merchant_chat/uploads

# Copy service node_modules
COPY --from=builder --chown=nodejs:nodejs /app/user_merchant_chat/node_modules ./user_merchant_chat/node_modules

# Copy generated Prisma client if your prisma output is /app/generated
COPY --from=builder --chown=nodejs:nodejs /app/generated ./generated

# Copy Prisma schema and shared lib
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/lib ./lib

# Copy full service
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