# One image for every backend process; the command picks the role:
#   api (default) | workers | migrate
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY deploy/entrypoint.sh /usr/local/bin/noma
RUN chmod +x /usr/local/bin/noma
USER node
EXPOSE 3000
ENTRYPOINT ["noma"]
CMD ["api"]
