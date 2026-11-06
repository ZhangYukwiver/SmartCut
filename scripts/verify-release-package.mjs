#!/usr/bin/env node

import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extractFile as extractArchiveFile, listPackage, statFile as statArchiveFile } from "@electron/asar";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 用户数据（服务数据目录、收件箱、解析库、本机 CLI 状态）和凭据一类的名字，出现在包里任何一层都不行
const privateNames = /^(?:\.local-data(?:-.*)?|ai-edit|local-ai|inbox|analyses\.json|migrated-from-legacy\.json|cookies?(?:\.sqlite|\.db|\.json)?(?:-journal|-wal|-shm)?|login data(?:-journal|-wal|-shm)?|local state|web data(?:-journal|-wal|-shm)?|\.env(?:\..*)?|\.git|\.ssh)$/i;
const runtimeDependencyRoots = new Set([
  "fflate",
  "electron-updater",
  "builder-util-runtime",
  "debug",
  "ms",
  "fs-extra",
  "graceful-fs",
  "jsonfile",
  "universalify",
  "js-yaml",
  "argparse",
  "sax",
  "lazy-val",
  "lodash.escaperegexp",
  "lodash.isequal",
  "semver",
  "tiny-typed-emitter",
  "onnxruntime-node",
  "onnxruntime-common",
  "sharp",
  "@img",
  "detect-libc",
]);
// 打包时要和源码逐字节一致的文件：服务入口、桌面外壳、运行时要读的数据和第三方许可证
const sourceFiles = [
  "server/server.mjs", "server/analysisRoutes.mjs", "server/videoAnalysis.mjs", "server/localAi.mjs", "server/systemProxy.mjs",
  "server/aiEdit/index.mjs", "server/aiEdit/tools.mjs", "server/aiEdit/catalog.json", "server/aiEdit/probe-video.mp4",
  "server/aiEdit/cutout.mjs", "server/aiEdit/cutoutWorker.mjs", "server/aiEdit/imageRefine.mjs", "server/aiEdit/imageRefineWorker.mjs",
  "server/aiEdit/draftTemplates/draft_content_template.json",
  "server/licenses/openfilm-LICENSE.txt", "server/licenses/pyJianYingDraft-Apache-2.0.txt",
  "server/licenses/BiRefNet-MIT.txt", "server/licenses/LaMa-Apache-2.0.txt",
  "desktop/main.mjs", "desktop/preload.cjs", "desktop/inbox.mjs", "desktop/migrate.mjs", "desktop/filmWindow.mjs", "desktop/staticServer.mjs",
];
const extractFile = (archive, relative) => extractArchiveFile(archive, path.normalize(relative));
const statFile = (archive, relative) => statArchiveFile(archive, path.normalize(relative));

export function assertPublicPackagePath(value) {
  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean);
  assert(parts.every((part) => part !== ".." && !privateNames.test(part)), `Private data path in package: ${value}`);
}

export function assertPublicUpdateMetadata(value, packageName) {
  const metadata = Object.fromEntries(value.trim().split(/\r?\n/u).map((line) => {
    const match = /^([A-Za-z]+): ([A-Za-z0-9_.-]+)$/u.exec(line);
    assert(match, "Unexpected updater metadata value");
    return [match[1], match[2]];
  }));
  assert.deepEqual(Object.keys(metadata).sort(), ["owner", "provider", "releaseType", "repo", "updaterCacheDirName"]);
  assert.equal(metadata.provider, "github");
  assert.equal(metadata.releaseType, "release");
  assert.equal(metadata.updaterCacheDirName, `${packageName}-updater`);
  if (process.env.GITHUB_REPOSITORY) {
    assert.equal(`${metadata.owner}/${metadata.repo}`, process.env.GITHUB_REPOSITORY);
  }
}

async function filesUnder(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), `Unexpected symlink: ${relative}`);
    if (entry.isDirectory()) files.push(...await filesUnder(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

export async function verifyReleasePackage(resourcesDirectory, { sourceDirectory = projectDirectory, tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined } = {}) {
  const resources = path.resolve(resourcesDirectory);
  const archive = path.join(resources, "app.asar");
  const sourcePackage = JSON.parse(await readFile(path.join(sourceDirectory, "package.json"), "utf8"));
  const packedPackage = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
  assert.equal(packedPackage.version, sourcePackage.version, "Packaged version differs from source");
  assert.equal(packedPackage.main, "desktop/main.mjs");
  if (tag) assert.equal(tag, `v${sourcePackage.version}`, "Tag differs from packaged version");

  const entries = listPackage(archive).map((entry) => entry.replaceAll("\\", "/").replace(/^\//, ""));
  for (const entry of entries) {
    assertPublicPackagePath(entry);
    assert(/^(?:desktop|server|dist|build|node_modules)(?:\/|$)|^package\.json$/.test(entry), `Unexpected archive path: ${entry}`);
    assert(!entry.startsWith("server/fixtures") && !entry.endsWith(".test.mjs"), `Test fixture in package: ${entry}`);
    if (entry.startsWith("node_modules/")) {
      const dependencyRoot = entry.split("/")[1];
      assert(dependencyRoot === "playwright-core" || runtimeDependencyRoots.has(dependencyRoot), `Unexpected runtime dependency: ${entry}`);
    }
  }

  for (const relative of sourceFiles) {
    assert.deepEqual(extractFile(archive, relative), await readFile(path.join(sourceDirectory, relative)), `Outdated packaged source: ${relative}`);
  }

  const distFiles = await filesUnder(path.join(sourceDirectory, "dist"));
  assert(distFiles.includes("index.html"), "Web build is missing index.html");
  const packedDist = entries.filter((entry) => entry.startsWith("dist/") && !("files" in statFile(archive, entry)));
  assert.deepEqual(packedDist.sort(), distFiles.map((entry) => `dist/${entry}`).sort(), "Packaged web file list differs from current build");
  let aiEditBundled = false;
  let analysisBundled = false;
  for (const relative of distFiles) {
    const contents = extractFile(archive, `dist/${relative}`);
    assert.deepEqual(contents, await readFile(path.join(sourceDirectory, "dist", relative)), `Outdated packaged web asset: ${relative}`);
    if (relative.endsWith(".js")) {
      const source = contents.toString("utf8");
      aiEditBundled ||= source.includes("/v1/ai-edit/");
      analysisBundled ||= source.includes("/v1/analyses");
    }
  }
  assert(aiEditBundled && analysisBundled, "Web bundle is missing the AI edit or analysis pages");

  for (const relative of ["node_modules/playwright-core/package.json", "node_modules/playwright-core/index.js"]) {
    assert.equal(statFile(archive, relative).unpacked, true, "Playwright must be unpacked");
    assert.deepEqual(await readFile(path.join(resources, "app.asar.unpacked", relative)), await readFile(path.join(sourceDirectory, relative)));
  }

  for (const relative of await filesUnder(resources)) {
    assertPublicPackagePath(relative);
    assert(relative === "app.asar" || relative === "app-update.yml" || relative === "default_app.asar" || relative === "elevate.exe" || relative === "icon.icns" || (process.platform === "darwin" && relative === "smartcut-subject") || /^[^/]+\.lproj\/(?:locale\.pak|InfoPlist\.strings)$/.test(relative) || relative.startsWith("app.asar.unpacked/"), `Unexpected resource: ${relative}`);
    if (relative === "app-update.yml") {
      assertPublicUpdateMetadata(await readFile(path.join(resources, relative), "utf8"), sourcePackage.name);
    }
    if (relative === "default_app.asar") {
      const electronResources = process.platform === "darwin" ? "Electron.app/Contents/Resources" : "resources";
      assert.deepEqual(await readFile(path.join(resources, relative)), await readFile(path.join(sourceDirectory, "node_modules/electron/dist", electronResources, relative)), "Unexpected Electron default archive");
    }
    if (relative.startsWith("app.asar.unpacked/")) {
      const archiveRelative = relative.slice("app.asar.unpacked/".length);
      assert.equal(statFile(archive, archiveRelative).unpacked, true, `Untracked unpacked resource: ${relative}`);
    }
  }
  if (process.platform === "darwin") await access(path.join(resources, "smartcut-subject"), constants.X_OK);
  return { version: packedPackage.version, webFiles: distFiles.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/verify-release-package.mjs <packaged resources directory>");
  const result = await verifyReleasePackage(process.argv[2]);
  console.log(`Verified release ${result.version}: current server and desktop shell, ${result.webFiles} web assets and no private data paths.`);
}
