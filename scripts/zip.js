const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const distDir = path.join(projectRoot, "dist");
const artifactDir = path.join(projectRoot, "release-artifacts");
const zipName = `${pkg.name}-v${pkg.version}.zip`;
const zipPath = path.join(artifactDir, zipName);

if (!fs.existsSync(path.join(distDir, "manifest.json"))) {
  throw new Error("dist/manifest.json not found. Run npm run build first.");
}

fs.mkdirSync(artifactDir, { recursive: true });
fs.rmSync(zipPath, { force: true });

execFileSync("zip", ["-qr", zipPath, "."], {
  cwd: distDir,
  stdio: "inherit"
});

const listing = execFileSync("zipinfo", ["-1", zipPath], {
  encoding: "utf8"
});
if (!listing.split(/\r?\n/).includes("manifest.json")) {
  throw new Error("zip root must contain manifest.json");
}

console.log(`Created ${path.relative(projectRoot, zipPath)}`);
