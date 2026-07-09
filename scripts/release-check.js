const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function walkFiles(dir, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, output);
    } else {
      output.push(fullPath);
    }
  }
  return output;
}

function assertNoPrivateContactValues() {
  const blocked = ["zzn12345lj", "scf19327", "1050634371"];
  const roots = ["src", "preview", "docs", "README.md", "RELEASE_NOTES_1.0.0.md"];
  const files = roots.flatMap((entry) => {
    const fullPath = path.join(projectRoot, entry);
    if (!fs.existsSync(fullPath)) return [];
    return fs.statSync(fullPath).isDirectory() ? walkFiles(fullPath) : [fullPath];
  });

  for (const file of files) {
    if (/\.(png|jpg|jpeg|gif|webp|ico)$/i.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const value of blocked) {
      assert.equal(text.includes(value), false, `${path.relative(projectRoot, file)} contains private contact value`);
    }
  }
}

function main() {
  const pkg = readJson("package.json");
  const manifest = readJson("src/manifest.json");

  assert.equal(manifest.manifest_version, 3, "manifest must use MV3");
  assert.equal(pkg.version, manifest.version, "package and manifest versions must match");
  assert.equal(manifest.version, "1.0.0", "Chrome release version must be 1.0.0");
  assert.equal(Object.hasOwn(manifest, "key"), false, "Chrome Web Store source manifest must not include a fixed key");
  assert.equal(pkg.scripts["build:obfuscated"], undefined, "obfuscated build script must not exist");
  assert.equal(pkg.devDependencies?.["javascript-obfuscator"], undefined, "obfuscator dependency must not exist");
  assert.deepEqual(manifest.permissions, ["storage", "downloads", "unlimitedStorage"], "permissions must stay minimal");
  assert.equal((manifest.host_permissions || []).some((value) => /<all_urls>|\*/.test(value) && !String(value).includes("doubao.com")), false, "host permissions must stay scoped to Doubao");

  const content = readText("src/content.js");
  assert.equal(/激活码|需激活|data-license-action|data-contact-copy/.test(content), false, "content script must not expose activation or private contact UI");

  assertNoPrivateContactValues();
  console.log("Release checks passed");
}

main();
