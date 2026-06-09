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

Release reminder: upload GUI installer assets to `/opt/lobster-brain/public/downloads/`,
not to `/var/www/download-site/downloads/`. The `/var/www/download-site` tree only
serves the static page shell (`download.html`, `app.js`, images, CSS).

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

## GUI Release Checklist

1. Build, sign, notarize, staple, and Gatekeeper-validate each platform artifact.

2. Upload installers, blockmaps, and updater manifests to the nginx alias directory:

   ```bash
   VERSION=<gui-version>
   rsync -av \
     dist/Lynn-${VERSION}-macOS-arm64.dmg \
     dist/Lynn-${VERSION}-macOS-arm64.dmg.blockmap \
     dist/Lynn-${VERSION}-macOS-x64.dmg \
     dist/Lynn-${VERSION}-macOS-x64.dmg.blockmap \
     dist/Lynn-${VERSION}-Windows-Setup.exe \
     dist/Lynn-${VERSION}-Windows-Setup.exe.blockmap \
     dist/latest-mac.yml \
     dist/latest.yml \
     tencent:/opt/lobster-brain/public/downloads/
   ```

3. Verify public URLs, not just server files:

   ```bash
   VERSION=<gui-version>
   curl -fsSIL https://download.merkyorlynn.com/downloads/Lynn-${VERSION}-macOS-arm64.dmg
   curl -fsSIL https://download.merkyorlynn.com/downloads/Lynn-${VERSION}-macOS-x64.dmg
   curl -fsSIL https://download.merkyorlynn.com/downloads/Lynn-${VERSION}-Windows-Setup.exe
   curl -fsSL https://download.merkyorlynn.com/downloads/latest-mac.yml
   curl -fsSL https://download.merkyorlynn.com/downloads/latest.yml
   ```

4. If any public URL returns stale size/hash, first confirm that the files landed
   under `/opt/lobster-brain/public/downloads/`; stale `/var/www/download-site/downloads/`
   uploads do not affect public downloads.
