FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
