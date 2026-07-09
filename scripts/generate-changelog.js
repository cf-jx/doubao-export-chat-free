const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const outputPath = path.join(projectRoot, "src", "changelog.html");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function versionParts(version) {
  return String(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = versionParts(a.version);
  const right = versionParts(b.version);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (right[index] || 0) - (left[index] || 0);
    if (diff !== 0) return diff;
  }
  return a.file.localeCompare(b.file);
}

function readReleaseNotes() {
  return fs.readdirSync(projectRoot)
    .map((file) => {
      const match = file.match(/^RELEASE_NOTES_(\d+\.\d+\.\d+)\.md$/);
      return match ? { file, version: match[1] } : null;
    })
    .filter(Boolean)
    .sort(compareVersions)
    .map((entry) => ({
      ...entry,
      markdown: fs.readFileSync(path.join(projectRoot, entry.file), "utf8")
    }));
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function flushParagraph(output, paragraph) {
  if (!paragraph.length) return;
  output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
  paragraph.length = 0;
}

function markdownToHtml(markdown) {
  const output = [];
  const paragraph = [];
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  let fenceLines = [];
  let listType = null;

  function closeList() {
    if (!listType) return;
    output.push(`</${listType}>`);
    listType = null;
  }

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flushParagraph(output, paragraph);
      closeList();
      if (inFence) {
        output.push(`<pre><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
        fenceLines = [];
        inFence = false;
      } else {
        inFence = true;
      }
      return;
    }

    if (inFence) {
      fenceLines.push(line);
      return;
    }

    if (!trimmed) {
      flushParagraph(output, paragraph);
      closeList();
      return;
    }

    const heading = trimmed.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      flushParagraph(output, paragraph);
      closeList();
      const level = Math.min(heading[1].length + 1, 4);
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      return;
    }

    if (/^#\s+/.test(trimmed)) {
      return;
    }

    const bullet = trimmed.match(/^-\s+(.+)$/);
    if (bullet) {
      flushParagraph(output, paragraph);
      if (listType !== "ul") {
        closeList();
        output.push("<ul>");
        listType = "ul";
      }
      output.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      return;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph(output, paragraph);
      if (listType !== "ol") {
        closeList();
        output.push("<ol>");
        listType = "ol";
      }
      output.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
      return;
    }

    closeList();
    paragraph.push(trimmed);
  });

  flushParagraph(output, paragraph);
  if (inFence) {
    output.push(`<pre><code>${escapeHtml(fenceLines.join("\n"))}</code></pre>`);
  }
  closeList();
  return output.join("\n");
}

function renderRelease(entry) {
  const title = `v${entry.version}`;
  return `
      <article class="release-card" id="v${escapeHtml(entry.version)}">
        <header class="release-card__header">
          <span class="release-card__version">${escapeHtml(title)}</span>
          <a class="release-card__anchor" href="#v${escapeHtml(entry.version)}" aria-label="Link to ${escapeHtml(title)}">#</a>
        </header>
        <div class="release-card__body">
${markdownToHtml(entry.markdown).split("\n").map((line) => `          ${line}`).join("\n")}
        </div>
      </article>`;
}

function renderPage(entries) {
  const releases = entries.map(renderRelease).join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>豆包导出更新说明</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --surface: #ffffff;
      --text: #15181d;
      --muted: #687182;
      --border: #e6e8ee;
      --accent: #2f6feb;
      --accent-soft: #eaf1ff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-size: 15px;
      line-height: 1.7;
    }
    main {
      width: min(760px, calc(100% - 32px));
      margin: 0 auto;
      padding: 48px 0 64px;
    }
    .page-header {
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    .page-header p {
      margin: 0;
      color: var(--muted);
    }
    .release-stack {
      display: grid;
      gap: 16px;
    }
    .release-card {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface);
      box-shadow: 0 12px 30px rgba(25, 30, 40, 0.06);
      overflow: hidden;
    }
    .release-card__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 18px 22px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, #ffffff, #fbfcff);
    }
    .release-card__version {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 0 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 700;
      font-size: 14px;
    }
    .release-card__anchor {
      color: var(--muted);
      text-decoration: none;
      font-weight: 700;
    }
    .release-card__body {
      padding: 20px 22px 24px;
    }
    .release-card__body h3,
    .release-card__body h4 {
      margin: 22px 0 8px;
      font-size: 17px;
      line-height: 1.35;
    }
    .release-card__body h3:first-child,
    .release-card__body h4:first-child,
    .release-card__body p:first-child {
      margin-top: 0;
    }
    p, ul, ol, pre {
      margin: 10px 0;
    }
    ul, ol {
      padding-left: 1.35em;
    }
    code {
      border-radius: 6px;
      background: #f1f3f7;
      padding: 2px 5px;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 0.92em;
    }
    pre {
      overflow: auto;
      border-radius: 10px;
      background: #f1f3f7;
      padding: 12px 14px;
    }
    pre code {
      padding: 0;
      background: transparent;
    }
    @media (max-width: 520px) {
      main {
        width: min(100% - 20px, 760px);
        padding: 28px 0 48px;
      }
      .release-card__header,
      .release-card__body {
        padding-left: 16px;
        padding-right: 16px;
      }
    }
  </style>
</head>
<body>
  <main>
    <header class="page-header">
      <h1>豆包导出更新说明</h1>
      <p>最新版本在最上方。每次发布后由仓库里的 RELEASE_NOTES 自动生成。</p>
    </header>
    <section class="release-stack" aria-label="更新记录">
${releases || "      <p>暂无更新记录。</p>"}
    </section>
  </main>
</body>
</html>
`;
}

function main() {
  const entries = readReleaseNotes();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, renderPage(entries), "utf8");
  console.log(`Generated ${path.relative(projectRoot, outputPath)} from ${entries.length} release note file(s)`);
}

main();
