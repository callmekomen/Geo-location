# Naija Routes — single-stage image. No build step, no native deps required.
FROM node:22-alpine

# better-sqlite3 is optional: if the toolchain is here it gets compiled and used,
# otherwise the app falls back to node:sqlite. Either way the install succeeds.
RUN apk add --no-cache python3 make g++ tini

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN npm run vendor && npm run verify

# The database lives on a volume so reports survive a redeploy.
RUN mkdir -p /data && chown -R node:node /data /app
ENV DATABASE_PATH=/data/naija-routes.db \
    HOST=0.0.0.0 \
    PORT=3000
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
