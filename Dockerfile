FROM node:18-slim

# Install ffmpeg and required packages
RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copy package files first for faster rebuilds
COPY package.json package-lock.json* ./

RUN npm install --production=false

# Copy app source
COPY . .

# Ensure uploads dir exists
RUN mkdir -p uploads && chown -R node:node uploads

ENV NODE_ENV=development

EXPOSE 3000

# Default command runs server; docker-compose overrides for worker
CMD ["npm", "start"]
