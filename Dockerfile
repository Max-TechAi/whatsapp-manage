# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY src/ ./src/

RUN npx tsc

# Production stage
FROM node:22-alpine

# Install ffmpeg for media transcoding
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/db/migrations ./src/db/migrations
COPY src/public ./src/public
COPY drizzle.config.ts ./

# Create non-root user and set permissions
RUN addgroup -S appgroup && adduser -S appuser -G appgroup && \
    mkdir -p /app/logs && \
    chown -R appuser:appgroup /app
USER appuser

ENV NODE_ENV=production

EXPOSE 3000 3001

CMD ["node", "dist/index.js"]
