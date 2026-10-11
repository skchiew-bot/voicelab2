FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY admin ./admin
COPY portal ./portal
RUN npm run build:admin && npm run build:portal
EXPOSE 3000
CMD ["npx", "tsx", "src/server.ts"]
