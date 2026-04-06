const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;
  if (process.env.SKIP_NOTARIZE === 'true') {
    console.log('Skipping notarization (SKIP_NOTARIZE=true)');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  const keychainProfile = process.env.APPLE_NOTARY_PROFILE || process.env.NOTARY_KEYCHAIN_PROFILE;
  const keychain = process.env.APPLE_NOTARY_KEYCHAIN || process.env.NOTARY_KEYCHAIN;

  if (keychainProfile) {
    console.log(`Notarizing ${appName} with keychain profile ${keychainProfile}...`);
    await notarize({
      appPath,
      keychainProfile,
      ...(keychain ? { keychain } : {}),
    });
    console.log('Notarization complete.');
    return;
  }

  console.log(`Notarizing ${appName} with Apple ID credentials...`);
  const appleId = process.env.APPLE_ID;
  const teamId = process.env.APPLE_TEAM_ID;
  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_ID_PASSWORD;

  if (!appleId || !teamId || !password) {
    throw new Error(
      'Set APPLE_NOTARY_PROFILE (recommended) or APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD for notarization',
    );
  }

  await notarize({
    appPath,
    appleId,
    appleIdPassword: password,
    teamId,
  });

  console.log('Notarization complete.');
};
