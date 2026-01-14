# AstroAdmin Production Deployment

Deploy AstroAdmin with your Astro site using Docker Compose.

## Quick Start

Run the interactive setup script:

```bash
cd docker
bun setup.ts
```

This will prompt you for:
- Git repository URL
- Domain names
- Admin credentials

And automatically:
- Generate SSH deploy keys
- Clone your repositories
- Create configuration files
- Update nginx with your domains

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    NGINX (port 80/443)                       │
│   example.com → static site                                  │
│   admin.example.com → AstroAdmin                             │
│   preview.example.com → Astro dev server                     │
└─────────────────────────────────────────────────────────────┘
          │                              │
          ▼                              ▼
┌─────────────────────┐    ┌─────────────────────┐
│  AstroAdmin         │    │   astro-dev         │
│  Content editing    │    │   Live preview      │
│  Git push           │    │                     │
└─────────────────────┘    └─────────────────────┘
          │
          ▼
┌─────────────────────┐
│  Builder            │
│  Polls for changes  │
│  Rebuilds site      │
└─────────────────────┘
```

## Prerequisites

- Docker and Docker Compose
- A server with ports 80/443 available
- DNS configured for your domains
- SSH deploy keys for your Git repository

## Setup

### 1. Clone this repository

```bash
git clone https://github.com/cloudshipco/astroadmin.git
cd astroadmin/docker
```

### 2. Clone your Astro site

You need two clones of your site:
- `./site` - For AstroAdmin to edit (read-write)
- `./site-live` - For the builder to pull and build (read-only)

```bash
git clone git@github.com:you/your-site.git site
git clone git@github.com:you/your-site.git site-live
```

### 3. Add Dockerfile.dev to your site

Copy the template to your site repository:

```bash
cp Dockerfile.dev.example site/Dockerfile.dev
```

Commit and push this to your repo so the builder can use it.

### 4. Generate SSH deploy keys

Create two deploy keys - one read-write (for AstroAdmin to push) and one read-only (for the builder to pull).

```bash
# Create key directories
mkdir -p ssh/rw ssh/ro

# Generate read-write key (for AstroAdmin)
ssh-keygen -t ed25519 -f ssh/rw/id_ed25519 -N "" -C "astroadmin-rw"

# Generate read-only key (for builder)
ssh-keygen -t ed25519 -f ssh/ro/id_ed25519 -N "" -C "astroadmin-ro"
```

Add these keys to your GitHub repository:
1. Go to your repo → Settings → Deploy keys
2. Add the read-write key (`ssh/rw/id_ed25519.pub`) with write access enabled
3. Add the read-only key (`ssh/ro/id_ed25519.pub`) without write access

### 5. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set:
- `ADMIN_USERNAME` and `ADMIN_PASSWORD` - Your login credentials
- `SESSION_SECRET` - Generate with `openssl rand -hex 32`
- `PREVIEW_URL` - Your preview domain (e.g., `http://preview.example.com`)

### 6. Configure nginx

Edit `nginx/conf.d/default.conf` and update the `server_name` directives to match your domains.

### 7. Create dist directory

```bash
mkdir -p dist
```

### 8. Start the services

```bash
docker-compose up -d
```

## Usage

### Editing Content

1. Go to `https://admin.example.com`
2. Log in with your credentials
3. Edit content in the visual editor
4. Click "Commit" to save changes to Git
5. Click "Push" (or enable auto-push) to publish

### Publishing Flow

When you push changes:
1. The builder container detects the new commit (checks every 60 seconds)
2. It pulls the changes and runs `npm run build`
3. The built files are copied to the dist volume
4. nginx serves the new content immediately

### Viewing Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f builder
docker-compose logs -f astroadmin
```

## SSL/TLS Setup

For HTTPS, add SSL certificates to the `certs/` directory and update the nginx configuration.

Using Let's Encrypt with certbot:

```bash
# Install certbot
apt install certbot

# Generate certificates
certbot certonly --webroot -w ./dist -d example.com -d www.example.com
certbot certonly --webroot -w ./dist -d admin.example.com
certbot certonly --webroot -w ./dist -d preview.example.com

# Link certificates
mkdir -p certs
ln -s /etc/letsencrypt/live/example.com/fullchain.pem certs/
ln -s /etc/letsencrypt/live/example.com/privkey.pem certs/
```

Then update `nginx/conf.d/default.conf` to use HTTPS.

## Troubleshooting

### Builder not detecting changes

Check the builder logs:
```bash
docker-compose logs builder
```

Verify the SSH key is working:
```bash
docker-compose exec builder ssh -T git@github.com
```

### Preview not loading

Ensure the PREVIEW_URL is accessible from your browser (not just internally).

### Permission errors

Ensure the site directories have correct permissions:
```bash
chmod -R 755 site site-live dist
```

## Configuration Reference

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `ADMIN_USERNAME` | Login username | `admin` |
| `ADMIN_PASSWORD` | Login password | `admin` |
| `SESSION_SECRET` | Session encryption key | (required) |
| `PREVIEW_URL` | Browser-accessible preview URL | `http://localhost:4321` |
| `GIT_AUTO_PUSH` | Auto-push after commit | `false` |
| `POLL_INTERVAL` | Builder poll interval (seconds) | `60` |
| `BRANCH` | Git branch to track | `main` |
| `HTTP_PORT` | nginx HTTP port | `80` |
| `HTTPS_PORT` | nginx HTTPS port | `443` |
