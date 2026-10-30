# Static build served by nginx. Pass public build-time values as build args:
#   docker build --build-arg VITE_SUPABASE_URL=... --build-arg VITE_SUPABASE_ANON_KEY=... \
#                --build-arg VITE_GOOGLE_MAPS_API_KEY=... -t edibell .
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_GOOGLE_MAPS_API_KEY
RUN pnpm build

FROM nginx:1.27-alpine
COPY --from=build /app/dist/public /usr/share/nginx/html
RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  location / { try_files $uri /index.html; }\n  add_header X-Content-Type-Options nosniff;\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
