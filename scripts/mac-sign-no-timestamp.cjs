const { spawnSync } = require("child_process");
const path = require("path");

exports.default = async function signWithoutTimestamp(opts) {
  const appPath = opts && opts.app;
  if (!appPath) {
    throw new Error("mac-sign-no-timestamp: missing opts.app");
  }

  const env = {
    ...process.env,
    LYNN_SIGN_APP: appPath,
  };

  if (opts.identity && opts.identity.name) {
    env.CODESIGN_IDENTITY = opts.identity.name;
  }

  const script = path.join(__dirname, "sign-local.cjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: path.join(__dirname, ".."),
    env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`mac-sign-no-timestamp: sign-local failed with exit code ${result.status}`);
  }
};
