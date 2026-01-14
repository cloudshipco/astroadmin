# AstroAdmin Builder Dockerfile
# Polls for Git changes and rebuilds the production site

FROM node:20-alpine

# Install git and ssh for Git operations
RUN apk add --no-cache git openssh-client

WORKDIR /site-live

# Setup SSH directory
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh

# Configure Git to use SSH
RUN git config --global core.sshCommand "ssh -o StrictHostKeyChecking=accept-new"

# Copy the builder script
COPY builder.sh /builder.sh
RUN chmod +x /builder.sh

# Environment defaults
ENV POLL_INTERVAL=60
ENV BRANCH=main

CMD ["/builder.sh"]
