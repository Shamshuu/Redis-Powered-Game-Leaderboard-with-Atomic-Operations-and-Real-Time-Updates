FROM node:20-alpine

# Install curl for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

# Copy dependency configs
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application source and static public directory
COPY src/ ./src/
COPY public/ ./public/

EXPOSE 3000

CMD ["node", "src/index.js"]
