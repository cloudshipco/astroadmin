# Deploy Adapters

AstroAdmin can automatically deploy your built site when you click Publish. The publish pipeline works as follows:

```
User clicks Publish
    ↓
1. Git commit + push (saves changes to repository)
    ↓
2. Build site (astro build)
    ↓
3. Deploy to remote server (if configured)
    ↓
Done - site is live
```

## Configuration

Add a `deploy` section to your `astroadmin.config.js`:

```javascript
export default {
  deploy: {
    adapter: 'rsync',
    rsync: {
      host: 'myserver.com',
      user: 'deploy',
      path: '/var/www/mysite/public',
    }
  }
};
```

## rsync Adapter

The rsync adapter syncs your built `dist/` directory to a destination path. It supports both:
- **Local deployment** - sync to another directory on the same machine
- **Remote deployment** - sync to a remote server over SSH

### Local Deployment

For deploying to a local directory (e.g., a web server running on the same machine):

```javascript
export default {
  deploy: {
    adapter: 'rsync',
    rsync: {
      path: '/var/www/mysite/public',  // Local destination path
    }
  }
};
```

### Remote Deployment

For deploying to a remote server over SSH:

```javascript
export default {
  deploy: {
    adapter: 'rsync',
    rsync: {
      path: '/var/www/mysite/public',  // Remote destination path
      host: 'myserver.com',            // Remote hostname or IP
      user: 'deploy',                  // SSH username
    }
  }
};
```

### Full Configuration

```javascript
export default {
  deploy: {
    adapter: 'rsync',
    rsync: {
      // Required
      path: '/var/www/mysite/public',

      // Required for remote deploy (omit for local)
      host: 'myserver.com',
      user: 'deploy',

      // Optional (remote only)
      port: 22,                           // SSH port (default: 22)
      keyPath: '~/.ssh/deploy_key',       // Path to SSH private key

      // Optional (both local and remote)
      exclude: ['.git', 'node_modules'],  // Patterns to exclude
      dryRun: false,                      // Test without making changes
    }
  }
};
```

### Using Environment Variables

For security, use environment variables for sensitive values:

```javascript
export default {
  deploy: {
    adapter: process.env.DEPLOY_ADAPTER || null,
    rsync: {
      host: process.env.DEPLOY_HOST,
      user: process.env.DEPLOY_USER,
      path: process.env.DEPLOY_PATH,
      keyPath: process.env.DEPLOY_KEY_PATH,
    }
  }
};
```

Then in `.env`:

```bash
DEPLOY_ADAPTER=rsync
DEPLOY_HOST=myserver.com
DEPLOY_USER=deploy
DEPLOY_PATH=/var/www/mysite/public
DEPLOY_KEY_PATH=~/.ssh/deploy_key
```

## Server Setup

### SSH Key Authentication

1. Generate a deploy key (if you don't have one):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/deploy_key -C "astroadmin-deploy"
   ```

2. Add the public key to your server:
   ```bash
   ssh-copy-id -i ~/.ssh/deploy_key.pub deploy@myserver.com
   ```

3. Reference the key in your config:
   ```javascript
   rsync: {
     keyPath: '~/.ssh/deploy_key',
     // ...
   }
   ```

### Remote Directory Permissions

Ensure the deploy user has write access to the destination directory:

```bash
# On your server
sudo chown -R deploy:www-data /var/www/mysite
sudo chmod -R 775 /var/www/mysite
```

## Testing Deployment

Use dry-run mode to test without making changes:

```javascript
export default {
  deploy: {
    adapter: 'rsync',
    rsync: {
      host: 'myserver.com',
      user: 'deploy',
      path: '/var/www/mysite',
      dryRun: true,  // Test mode - no files transferred
    }
  }
};
```

Click Publish and check the output to see what would be synced.

## How rsync Works

**Local deployment:**

```bash
rsync -av --delete \
  ./dist/ \
  /var/www/mysite/
```

**Remote deployment:**

```bash
rsync -avz --delete \
  -e "ssh -p 22 -i ~/.ssh/deploy_key -o StrictHostKeyChecking=accept-new" \
  ./dist/ \
  deploy@myserver.com:/var/www/mysite/
```

Key behaviors:
- `-a` (archive): Preserves permissions, timestamps, etc.
- `-v` (verbose): Shows files being transferred
- `-z` (compress): Compresses data during transfer (remote only)
- `--delete`: Removes files at destination that don't exist in source

## Troubleshooting

### SSH Connection Failed

- Verify SSH access manually: `ssh deploy@myserver.com`
- Check the SSH key path is correct
- Ensure the key has proper permissions: `chmod 600 ~/.ssh/deploy_key`

### Permission Denied on Remote

- Verify the user has write access to the destination path
- Check directory ownership and permissions

### rsync Not Found

Install rsync on your local machine:
- macOS: `brew install rsync`
- Ubuntu/Debian: `sudo apt install rsync`
- Windows: Use WSL or install via Cygwin

### Build Failed Before Deploy

Check the build output in the response. Common issues:
- Missing dependencies
- TypeScript errors
- Invalid Astro configuration

## Future Adapters

Additional deploy adapters are planned:

- **s3** - AWS S3 bucket sync
- **ftp** - FTP/SFTP upload
- **vercel** - Vercel CLI deployment
- **netlify** - Netlify CLI deployment

## API Response

When deploy is configured, the publish endpoint returns additional fields:

```json
{
  "success": true,
  "committed": true,
  "pushed": true,
  "commit": {
    "hash": "abc123",
    "summary": { "changes": 1, "insertions": 5, "deletions": 2 }
  },
  "build": {
    "success": true,
    "duration": 3500,
    "output": "..."
  },
  "deploy": {
    "success": true,
    "adapter": "rsync",
    "output": "...",
    "dryRun": false,
    "local": true
  },
  "message": "Changes committed, pushed, built, and deployed"
}
```

## Next Steps

- [Configuration](./configuration.md) - Other configuration options
- [Getting Started](./getting-started.md) - Run AstroAdmin
