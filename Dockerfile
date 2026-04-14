FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist /app/dist
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev && npm cache clean --force
USER node
EXPOSE 8000
CMD ["node", "dist/server.js"]
