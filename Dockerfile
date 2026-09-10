FROM node:20-alpine

# Install Python and dependencies
RUN apk add --no-cache python3 py3-pip ffmpeg
RUN pip3 install --no-cache-dir yt-dlp requests --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
