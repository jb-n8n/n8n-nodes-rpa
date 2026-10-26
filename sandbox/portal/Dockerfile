FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
COPY . .
RUN mkdir -p /data && chown node:node /data
ENV PORT=8080 STATE_FILE=/data/state.json
USER node
EXPOSE 8080
CMD ["node", "server.js"]
