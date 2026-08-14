# Web process: serves the embedded app UI + API routes.
# Build from the repo root: docker build -f docker/Dockerfile -t duplify-web .
FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

# Bind for Railway's proxy only at runtime — setting HOST before build
# breaks Vite URL parsing (Invalid URL: 0.0.0.0).
ENV HOST=0.0.0.0

CMD ["npm", "run", "docker-start"]
