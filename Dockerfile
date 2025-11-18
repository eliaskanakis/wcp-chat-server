# ws-server/Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package.json and package-lock.json if you have it
COPY package*.json ./

# Install only prod dependencies (enough for your simple server)
RUN npm install --only=production

# Copy the rest of the code
COPY . .

# Cloud Run will set PORT, default to 8080
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
