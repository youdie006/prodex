FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY prodex.mjs ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim AS browser
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium xvfb xauth x11vnc novnc websockify procps fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/prodex.mjs ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY containers/browser ./containers/browser
COPY LICENSE ./
RUN ln -s /app/prodex.mjs /usr/local/bin/prodex \
    && mkdir -p /home/node/bridge && chown -R node:node /home/node && chmod 700 /home/node
USER node
ENV HOME=/home/node DISPLAY=:99 XAUTHORITY=/tmp/prodex-display/Xauthority \
    PRODEX_CHROME=/usr/bin/chromium PRODEX_HEADLESS=0 PRODEX_NO_AUTO_LOGIN=1
WORKDIR /home/node/bridge
CMD ["node", "/app/containers/browser/service.mjs"]
