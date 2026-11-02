FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server/ ./server/
COPY account/ ./account/
COPY assets/ ./assets/
COPY art/ ./art/
COPY fonts/ ./fonts/
COPY about/ ./about/
COPY admin/ ./admin/
COPY archive/ ./archive/
COPY figures/ ./figures/
COPY quiz/ ./quiz/
COPY route/ ./route/
COPY index.html 404.html ./

ENV HOST=0.0.0.0 PORT=9000 NODE_ENV=production MYSQL_AUTO_INIT=false MYSQL_CONNECTION_LIMIT=2
USER node
EXPOSE 9000
CMD ["node", "server/index.mjs"]
