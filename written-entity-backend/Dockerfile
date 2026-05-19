FROM node:20-alpine

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy Prisma schema first (needed for postinstall)
COPY prisma ./prisma/

# Install dependencies
RUN npm install --prefer-offline --no-audit

# Copy rest of application code
COPY . .

# Build TypeScript
RUN npm run build

EXPOSE 10000

CMD ["npm", "start"]
