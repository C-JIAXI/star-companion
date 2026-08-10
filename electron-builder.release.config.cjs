const base = require("./electron-builder.config.cjs");

module.exports = {
  ...base,
  extraMetadata: { starCompanionBuildType: "release" },
  win: { ...base.win, signAndEditExecutable: true },
  forceCodeSigning: true
};
