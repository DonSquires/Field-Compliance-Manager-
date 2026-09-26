FROM node:22-alpine

RUN apk add --no-cache poppler-utils tesseract-ocr tesseract-ocr-data-eng

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts
COPY server.js ./
COPY src ./src
USER node
EXPOSE 3000
CMD ["node", "server.js"]