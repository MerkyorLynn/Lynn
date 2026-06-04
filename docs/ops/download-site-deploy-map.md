# Download Site Deploy Map

This file is the release-time memory for `download.merkyorlynn.com`.

## Server Paths

The static page and binary downloads do not live in the same directory.

| Public URL | Server path | Notes |
|---|---|---|
| `https://download.merkyorlynn.com/download.html` | `/var/www/download-site/download.html` | Static mirror page root |
| `https://download.merkyorlynn.com/app.js` | `/var/www/download-site/app.js` | Static mirror page script |
| `https://download.merkyorlynn.com/downloads/cli/*` | `/opt/lobster-brain/public/downloads/cli/*` | nginx `alias`; not under `/var/www/download-site` |
| `https://download.merkyorlynn.com/downloads/*` | `/opt/lobster-brain/public/downloads/*` | App installers and other downloadable assets |

## CLI Release Checklist

1. Build the CLI package only through the guarded script:

   ```bash
   npm run pack:cli -- --out /tmp/lynn-cli-pack
   ```

2. Upload the exact tarball to the nginx alias directory:

   ```bash
   VERSION=<cli-version>
   scp /tmp/lynn-cli-pack/lynn-cli-${VERSION}.tgz tencent:/tmp/
   ssh tencent "sudo install -m 0644 /tmp/lynn-cli-${VERSION}.tgz /opt/lobster-brain/public/downloads/cli/lynn-cli-${VERSION}.tgz"
   ```

3. Verify the public URL, not just the server file:

   ```bash
   VERSION=<cli-version>
   curl -fsSIL https://download.merkyorlynn.com/downloads/cli/lynn-cli-${VERSION}.tgz
   curl -fsSL https://download.merkyorlynn.com/downloads/cli/lynn-cli-${VERSION}.tgz -o /tmp/lynn-cli.remote.tgz
   shasum -a 256 /tmp/lynn-cli.remote.tgz
   ```

4. Run the remote install smoke:

   ```bash
   VERSION=<cli-version>
   LYNN_CLI_TARBALL_URL=https://download.merkyorlynn.com/downloads/cli/lynn-cli-${VERSION}.tgz npm run test:cli-install:remote
   ```

The release is not considered published until the public URL returns `200`,
the sha256 matches the local pack manifest, and remote install smoke passes.
