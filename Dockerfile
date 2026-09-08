FROM node:22-alpine

ARG VERSELINK_COMMIT=unknown
ARG VERSELINK_ENVIRONMENT=unknown
ARG VERSELINK_VERSION=unknown

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV APP_COMMIT=${VERSELINK_COMMIT}
ENV APP_ENVIRONMENT=${VERSELINK_ENVIRONMENT}
ENV APP_VERSION=${VERSELINK_VERSION}
EXPOSE 3000
CMD ["npm", "start"]
