FROM node:24.22.3-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.34.9
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build:testnet

FROM node:24.22.3-bookworm-slim
ENV NODE_ENV=production EWALLET_MODE=testnet HOST=0.0.0.0 PORT=8787 EWALLET_DATABASE_PATH=/data/backend.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "services/backend/src/server.ts"]
