FROM node:18-alpine

WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy rest of the app
COPY . .

# ❗ During build, NextAuth requires a secret
# We provide a harmless dummy value ONLY for build-time.
# Your REAL secret will still come from Fly.io secrets at runtime.
RUN NEXTAUTH_SECRET=dummy npm run build

EXPOSE 8080

CMD ["node", "dist/index.js"]
