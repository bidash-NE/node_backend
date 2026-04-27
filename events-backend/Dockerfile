FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including dev) for prisma generate
RUN npm install

# Generate Prisma Client
RUN npx prisma generate

# Remove dev dependencies to keep image smaller
RUN npm prune --production

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]