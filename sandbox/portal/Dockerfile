FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
WORKDIR /app
COPY . .
RUN mkdir -p /data && chown node:node /data
ENV PORT=8080 STATE_FILE=/data/state.json
USER node
EXPOSE 8080
CMD ["node", "server.js"]
