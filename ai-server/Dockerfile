FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app /app
RUN npm ci --omit=dev

EXPOSE 8080
CMD ["node", "dist/index.js"]
