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
    extraResource: fs.existsSync(agent)
      ? [agent]
      : []
  },
  makers: [
    { name: "@electron-forge/maker-squirrel" },
    { name: "@electron-forge/maker-zip", platforms: ["darwin"] },
    { name: "@electron-forge/maker-deb" },
    { name: "@electron-forge/maker-rpm" }
  ]
};
