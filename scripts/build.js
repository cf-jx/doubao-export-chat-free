const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const srcDir = path.join(projectRoot, "src");
const distDir = path.join(projectRoot, "dist");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function cleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  ensureDir(dirPath);
}

function copyRecursive(source, target) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    ensureDir(target);
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(target, entry));
    }
    return;
  }

  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

function main() {
  if (!fs.existsSync(srcDir)) {
    throw new Error("src directory not found");
  }

  cleanDir(distDir);
  copyRecursive(srcDir, distDir);

  console.log(`Built extension to ${distDir}`);
}

main();
