FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache ca-certificates
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
