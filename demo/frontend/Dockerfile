FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY public/ ./public/
COPY src/ ./src/
COPY *.json ./
COPY *.js ./

# Build the app
RUN npm run build

# Serve the built app
EXPOSE 3000
CMD ["npm", "start"]