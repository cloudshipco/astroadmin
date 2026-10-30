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

A remote `path` may hold only letters, digits and `. _ ~ / + @ , = -`, and
must not start with `-` or `=`. rsync hands the path to the remote end
through its login shell: rsync before 3.2.4 and the macOS `openrsync` send
it unescaped, so `$HOME`, backticks, `$(...)`, `;` and spaces are the
shell's (and zsh turns a leading `=ls` into `/bin/ls`), and even
rsync 3.4 leaves `*` unescaped (`w*` syncs into the first match, with
`--delete`). Anything else is refused whatever the rsync version, and
`allowDestructivePath` does not lift this.

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
  is accepted. A home directory written as an absolute path (`/home/deploy`,
  `/root`) is not detected, since AstroAdmin cannot know where the remote
  user's home is: check that one yourself.

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
deploy results. They are status fields only: the build's and rsync's output
name server paths and the destination, so they go to the server log, never
into the response.

```json
{
  "success": true,
  "committed": true,
  "pushed": true,
  "commit": { "hash": "abc123", "summary": { "changes": 1, "insertions": 5, "deletions": 2 } },
  "build": { "success": true, "duration": 3500 },
  "deploy": { "success": true, "adapter": "rsync", "dryRun": false },
  "message": "Published: committed and pushed, built and deployed"
}
```

A failed build returns `"success": false`, `"deploy": null` and a `build`
with a fixed `error` and `problems`: the error codes the build's output
names, each as a sentence AstroAdmin wrote (an unknown code reads "Astro
refused the build (<code>); see the server log").

```json
{
  "success": false,
  "build": {
    "success": false,
    "duration": 2100,
    "error": "The build command failed.",
    "problems": [{ "code": "ImageNotFound", "message": "..." }]
  },
  "deploy": null,
  "error": "Build failed - deployment skipped"
}
```

A failed deploy returns `"success": false` with
`"deploy": { "success": false, "error": "The deployment failed; see the server log." }`.
