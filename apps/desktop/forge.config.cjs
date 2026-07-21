const fs = require("node:fs");
const path = require("node:path");

const extension = process.platform === "win32" ? ".exe" : "";
const agent = path.resolve(
  __dirname,
  `../../target/release/mdbase-connect-agent${extension}`
);

module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "dev.mdbase.connect",
    executableName: "mdbase-connect",
    protocols: [{ name: "mdbase connect", schemes: ["mdbase-connect"] }],
    extraResource: fs.existsSync(agent)
      ? [agent]
      : []
  },
  hooks: {
    packageAfterCopy: async () => {
      if (!fs.existsSync(agent)) {
        throw new Error(`Release connector agent is missing: ${agent}`);
      }
    }
  },
  makers: [
    { name: "@electron-forge/maker-squirrel" },
    { name: "@electron-forge/maker-zip", platforms: ["darwin"] },
    { name: "@electron-forge/maker-deb" },
    { name: "@electron-forge/maker-rpm" }
  ]
};
