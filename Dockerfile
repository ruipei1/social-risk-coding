FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json model.mjs comparison.mjs server.mjs manage.mjs starter-codebook.mjs ./
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4317 DB_PATH=/app/data/coding.sqlite
EXPOSE 4317
CMD ["node", "server.mjs"]
