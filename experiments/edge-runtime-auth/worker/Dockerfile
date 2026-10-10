# workerd (the Cloudflare Workers runtime) via wrangler dev, in a container so the
# runtime binary never runs on the host. The image holds only wrangler; the
# worker bundle and its .dev.vars are mounted at run time. ca-certificates is
# required: node:22-slim ships without a trust store, and workerd then fails
# every outbound https fetch with "internal error".
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && apt-get clean \
    && npm install -g wrangler@4 && npm cache clean --force
WORKDIR /app
ENV WRANGLER_SEND_METRICS=false CI=1
EXPOSE 8787
CMD ["wrangler", "dev", "--local", "--ip", "0.0.0.0", "--port", "8787"]
