FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797
WORKDIR /app
COPY . .
RUN mkdir -p /data && chown node:node /data
ENV PORT=8080 STATE_FILE=/data/state.json
USER node
EXPOSE 8080
CMD ["node", "server.js"]
