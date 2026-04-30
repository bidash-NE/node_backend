# Stage 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev) for building
RUN npm ci --include=dev

# Generate Prisma Client
RUN npx prisma generate

# Copy source code
COPY . .

# Prune dev dependencies for production
RUN npm prune --production

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# Install OpenSSL for Prisma runtime
RUN apk add --no-cache openssl

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./
COPY --from=builder --chown=nodejs:nodejs /app ./

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