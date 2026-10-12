FROM oven/bun:1.3.14
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server.ts ./
USER bun
EXPOSE 8790
CMD ["bun", "server.ts"]
