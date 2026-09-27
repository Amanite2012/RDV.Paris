FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY web ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3100
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3100/healthz || exit 1
CMD ["node", "web/server.js"]
