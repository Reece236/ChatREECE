FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# Conversations, the key pepper and the generated admin key live here. Mount a
# volume at this path or a redeploy takes every visitor's key with it.
ENV DATA_DIR=/data
VOLUME ["/data"]

ENV PORT=3000
EXPOSE 3000

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
