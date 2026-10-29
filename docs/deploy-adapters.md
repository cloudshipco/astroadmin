# Deploy adapters

Most sites need no adapter: Publish pushes to git, and a host that builds on
push (Netlify, Cloudflare Pages, GitHub Pages through Actions) rebuilds the
site. An adapter is for hosting without that, where the machine running
AstroAdmin builds the site and copies it to the web server. rsync is the only
adapter.

With an adapter configured, Publish runs the git steps described in
[configuration](./configuration.md#git-and-publishing) (when git is enabled),
then a production build (`build.production`, else the site's own
`astro build --outDir dist`), then the deploy. The adapter uploads `dist/`,
so a custom `build.production` must write there. If the build fails, nothing
is deployed. With `GIT_ENABLED=false`, Publish only builds and deploys.

## rsync

```javascript
// astroadmin.config.js
export default {
  deploy: {
    adapter: 'rsync',
    rsync: {
      path: '/var/www/site-a/public',  // required: destination
      host: 'server.example.com',      // omit to copy to a local directory
      user: 'deploy',                  // required when host is set
      port: 22,                        // SSH port
      keyPath: '~/.ssh/deploy_key',    // SSH private key
      exclude: ['.DS_Store'],          // rsync --exclude patterns
      dryRun: false,                   // true: report, change nothing
      allowDestructivePath: false,     // true: skip the destination check below
    },
  },
};
```

AstroAdmin runs `rsync -av --delete dist/ <destination>`, adding `-z` and
`-e "ssh -p <port> -i <keyPath> -o StrictHostKeyChecking=accept-new"` for a
remote host. `--delete` removes files at the destination that are not in
`dist/`, so point `path` at a directory that holds only the site. The key
path is quoted, so it may contain spaces, and `port` must be a whole number.
`user` may hold letters, digits, `.`, `_` and `-`; `host` is a host name, an
IPv4 address, or an IPv6 address in brackets (`[2001:db8::1]`, which needs
rsync 3: the `openrsync` macOS ships as `/usr/bin/rsync` does not parse it).
Neither may start with `-`: rsync passes `user@host` to ssh as one argument,
where a leading `-` would be read as an ssh option. Put the server and user
in their own fields, not in `path`: without `host`, a `path` such as
`deploy@server.example.com:/var/www` (a `:` before the first `/`) is
refused.

Publish refuses a destination where `--delete` would destroy something, and
says why, before it commits or builds anything:

- for a local copy: the filesystem root, the home directory or any directory
  above it, the project or any directory above it, anything inside the
  project, and the build output itself or anything inside it. A relative
  `path` is resolved against the project, as rsync resolves it, and symlinks
  are followed;
- for a remote host: `/`, the remote user's home (`~`, `.`, an empty path),
  any other user's home (`~deploy`, `~root/`: the remote shell expands
  them) and anything above one (`..`). A relative remote path is relative
  to the remote user's home; `~deploy/www` is a folder inside that home and
  is accepted.

If the destination really is one of these, set `allowDestructivePath: true`
(the boolean) to skip the check.

The values can come from the environment:

```javascript
export default {
  deploy: {
    adapter: process.env.DEPLOY_ADAPTER || null,
    rsync: {
      host: process.env.DEPLOY_HOST,
      user: process.env.DEPLOY_USER,
      path: process.env.DEPLOY_PATH,
      keyPath: process.env.DEPLOY_KEY_PATH,
    },
  },
};
```

rsync must be installed on the machine running AstroAdmin, and the deploy
user needs write access to `path`. Set `dryRun: true` and publish once to see
what would be copied.

## What Publish returns

With an adapter, the `POST /api/publish` response includes the build and
deploy results:

```json
{
  "success": true,
  "committed": true,
  "pushed": true,
  "commit": { "hash": "abc123", "summary": { "changes": 1, "insertions": 5, "deletions": 2 } },
  "build": { "success": true, "duration": 3500, "output": "..." },
  "deploy": { "success": true, "adapter": "rsync", "output": "...", "dryRun": false, "local": false },
  "message": "Published: committed and pushed, built and deployed"
}
```

A failed build or deploy returns `"success": false` with the step's output.
