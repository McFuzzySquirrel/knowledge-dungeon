FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
RUN mkdir -p /data && chown appuser:appgroup /data
USER appuser
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server/index.js"]
