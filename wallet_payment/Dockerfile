# wallet_payment/Dockerfile

# Stage 1: Prisma generator
FROM node:20-alpine AS prisma-builder

WORKDIR /app

RUN apk add --no-cache openssl

# Root package is used only for Prisma generation
COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --include=dev

# Generate Prisma client from root prisma/schema.prisma
RUN npx prisma generate


# Stage 2: Wallet service dependencies
FROM node:20-alpine AS wallet-builder

WORKDIR /app

RUN apk add --no-cache openssl

# Install wallet_payment service dependencies, not root dependencies
COPY wallet_payment/package*.json ./wallet_payment/

WORKDIR /app/wallet_payment

RUN npm ci --omit=dev

# Copy wallet service source
WORKDIR /app
COPY wallet_payment ./wallet_payment

# Copy shared Prisma lib
COPY lib ./lib

# Optional safety: make lib available inside wallet_payment also
RUN mkdir -p /app/wallet_payment/lib && \
    cp -a /app/lib/. /app/wallet_payment/lib/


# Stage 3: Production
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy wallet service with its own node_modules
COPY --from=wallet-builder --chown=nodejs:nodejs /app/wallet_payment ./wallet_payment

# Copy shared lib
COPY --from=wallet-builder --chown=nodejs:nodejs /app/lib ./lib

# Copy generated Prisma client from root Prisma build
COPY --from=prisma-builder --chown=nodejs:nodejs /app/generated ./generated
COPY --from=prisma-builder --chown=nodejs:nodejs /app/prisma ./prisma

USER nodejs

WORKDIR /app/wallet_payment

ENV NODE_ENV=production
ENV PORT=1111

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('http').get('http://localhost:1111/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)}).on('error', () => process.exit(1))"

EXPOSE 1111

CMD ["node", "server.js"]