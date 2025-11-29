FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

# Fix: NextAuth needs a secret ONLY during build
ENV NEXTAUTH_SECRET="dummy"

RUN npm run build

EXPOSE 8080

CMD ["node", "dist/index.js"]
