# AstroAdmin Production Dockerfile
# Builds a production-ready AstroAdmin image

FROM node:20-alpine

# Install git and ssh for Git operations
RUN apk add --no-cache git openssh-client

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./
RUN npm ci --production

# Copy application code (CSS is pre-built and committed)
COPY . .

# Setup SSH directory for Git operations
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh

# Configure Git to use SSH
RUN git config --global core.sshCommand "ssh -o StrictHostKeyChecking=accept-new"

# Mark /site as safe directory (volume has different ownership)
RUN git config --global --add safe.directory /site

# Environment defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

# Run AstroAdmin pointing to /site volume
CMD ["node", "bin/cli.js", "dev", "--project", "/site"]
