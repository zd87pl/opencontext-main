FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src/ ./src/
COPY data/ ./data/

# Create data directory
RUN mkdir -p /data

# Start the seeder
CMD ["npm", "start"]