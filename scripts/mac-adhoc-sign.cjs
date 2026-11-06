// ponytail: no Apple Developer ID on this machine, so electron-builder skips signing entirely.
// Ad-hoc sign the packed bundle so its seal is consistent; recipients still need `xattr -cr` (no notarization).
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");

module.exports = async ({ appOutDir, electronPlatformName, packager }) => {
  if (electronPlatformName !== "darwin") return;
  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  // Ship the Vision helper before sealing the application. End users do not need Xcode.
  const contents = path.join(appPath, "Contents");
  const executable = execFileSync("/usr/libexec/PlistBuddy", ["-c","Print :CFBundleExecutable",path.join(contents,"Info.plist")], {encoding:"utf8"}).trim();
  const archs = execFileSync("/usr/bin/lipo", ["-archs",path.join(contents,"MacOS",executable)], {encoding:"utf8"}).trim().split(/\s+/);
  const temp = mkdtempSync(path.join(os.tmpdir(),"smartcut-subject-build-"));
  try {
    const binaries = archs.map(arch => {
      const binary = path.join(temp,arch);
      execFileSync("/usr/bin/xcrun", ["swiftc","-O","-suppress-warnings","-target",arch+"-apple-macos14.0",path.join(__dirname,"../server/aiEdit/subjectWorker.swift"),"-o",binary],{stdio:"inherit"});
      return binary;
    });
    const resources=path.join(contents,"Resources"); mkdirSync(resources,{recursive:true});
    execFileSync("/usr/bin/lipo",["-create",...binaries,"-output",path.join(resources,"smartcut-subject")]);
  } finally {rmSync(temp,{recursive:true,force:true});}
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
};
