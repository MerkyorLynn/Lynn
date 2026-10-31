const path = require('node:path');
const { createHash } = require('node:crypto');

function resolveDesktopUserDataPath({ lynnHome, defaultHome, appData, defaultUserData }) {
  const resolved = path.resolve(lynnHome);
  if (resolved === path.resolve(defaultHome)) return defaultUserData;
  const fingerprint = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  return path.join(appData, `Lynn-profile-${fingerprint}`);
}

module.exports = { resolveDesktopUserDataPath };
