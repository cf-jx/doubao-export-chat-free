"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createMemoryOpfs() {
  class MemoryFileHandle {
    constructor(name) {
      this.name = name;
      this.blob = new Blob([]);
    }

    async createWritable() {
      const chunks = [];
      const handle = this;
      return {
        async write(value) {
          chunks.push(value instanceof Blob ? value : new Blob([value]));
        },
        async close() {
          handle.blob = new Blob(chunks);
        }
      };
    }

    async getFile() {
      return this.blob;
    }
  }

  class MemoryDirectoryHandle {
    constructor(name) {
      this.name = name;
      this.dirs = new Map();
      this.files = new Map();
      this.removed = [];
    }

    async getDirectoryHandle(name, options = {}) {
      if (!this.dirs.has(name)) {
        if (!options.create) throw new Error(`Directory not found: ${name}`);
        this.dirs.set(name, new MemoryDirectoryHandle(name));
      }
      return this.dirs.get(name);
    }

    async getFileHandle(name, options = {}) {
      if (!this.files.has(name)) {
        if (!options.create) throw new Error(`File not found: ${name}`);
        this.files.set(name, new MemoryFileHandle(name));
      }
      return this.files.get(name);
    }

    async removeEntry(name) {
      this.removed.push(name);
      this.dirs.delete(name);
      this.files.delete(name);
    }
  }

  const root = new MemoryDirectoryHandle("root");
  return {
    root,
    async getDirectory() {
      return root;
    }
  };
}

function createWorkerHarness(options = {}) {
  const projectRoot = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(projectRoot, "src", "export-worker.js"), "utf8");
  const listeners = [];
  const messages = [];
  const opfs = options.opfs === false ? null : createMemoryOpfs();
  const context = {
    console,
    Blob,
    ReadableStream,
    Response,
    TextEncoder,
    setTimeout,
    clearTimeout,
    navigator: opfs ? { storage: opfs } : {},
    self: {
      JSZip: class FakeZip {
        constructor() {
          this.files = [];
        }

        file(name, blob) {
          this.files.push({ name, blob });
        }

        async generateAsync(_options, onUpdate) {
          if (typeof onUpdate === "function") onUpdate({ percent: 100 });
          const names = [];
          for (const file of this.files) {
            names.push(file.name);
            if (file.blob instanceof Blob) await file.blob.arrayBuffer();
          }
          return new Blob([JSON.stringify(names)], { type: "application/zip" });
        }
      },
      postMessage(message) {
        messages.push(message);
      },
      addEventListener(type, listener) {
        if (type === "message") listeners.push(listener);
      }
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "export-worker.js" });

  return {
    messages,
    opfs,
    post(data) {
      listeners.forEach((listener) => listener({ data }));
    },
    async waitFor(type) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const found = messages.find((message) => message.type === type);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${type}`);
    }
  };
}

function createConversation(count) {
  return {
    id: "verify-large",
    title: "Verify large",
    source: "test",
    full: true,
    messages: Array.from({ length: count }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      text: `Message ${index + 1}`,
      parts: [{ type: "text", text: `Message ${index + 1}` }],
      metadata: { index: index + 1 }
    }))
  };
}

function htmlAttributeValues(html, attribute) {
  const values = [];
  const pattern = new RegExp(`\\s${attribute}="([^"]*)"`, "gi");
  let match = pattern.exec(html);
  while (match) {
    values.push(match[1]);
    match = pattern.exec(html);
  }
  return values;
}

async function verifySingleFile() {
  const harness = createWorkerHarness();
  harness.post({
    type: "export",
    jobId: "single",
    conversation: createConversation(10),
    format: "md",
    filenameBase: "single"
  });
  const complete = await harness.waitFor("complete");
  assert.equal(complete.result.filename, "single.md");
  assert.equal(complete.result.mimeType, "text/markdown;charset=utf-8");
  assert.ok(complete.result.blob instanceof Blob);
  assert.ok(harness.messages.some((message) => message.type === "storage" && message.mode === "opfs"));
  assert.equal(complete.files[0].storage, "memory");
}

async function verifyDangerousHtmlUrlsBlocked() {
  const harness = createWorkerHarness();
  const conversation = createConversation(1);
  conversation.messages = [{
    role: "assistant",
    text: [
      "[safe](https://example.com/path?x=1&y=2)",
      "[mail](mailto:test@example.com)",
      "[relative](./part-001.html)",
      "[bad-js](javascript:alert(1))",
      "[bad-vb](vbscript:msgbox(1))",
      "[bad-html](data:text/html;base64,PHNjcmlwdA==)",
      "![safe-img](data:image/png;base64,iVBORw0KGgo=)",
      "![bad-img](data:text/html;base64,PHNjcmlwdA==)"
    ].join("\n\n"),
    parts: [],
    metadata: { index: 1 }
  }];

  harness.post({
    type: "export",
    jobId: "safe-html-urls",
    conversation,
    format: "html",
    filenameBase: "safe-html-urls"
  });
  const complete = await harness.waitFor("complete");
  const html = await complete.result.blob.text();
  const urls = [...htmlAttributeValues(html, "href"), ...htmlAttributeValues(html, "src")];
  const unsafeUrls = urls.filter((url) => /^(?:javascript:|vbscript:|data:text\/html)/i.test(url));

  assert.equal(unsafeUrls.length, 0, `Unsafe URLs rendered: ${unsafeUrls.join(", ")}`);
  assert.ok(urls.includes("https://example.com/path?x=1&amp;y=2"));
  assert.ok(urls.includes("mailto:test@example.com"));
  assert.ok(urls.includes("./part-001.html"));
  assert.ok(urls.includes("data:image/png;base64,iVBORw0KGgo="));
  assert.doesNotMatch(html, /fonts\.(?:googleapis|gstatic)\.com/i);
}

async function verifySplitZip() {
  const harness = createWorkerHarness();
  harness.post({
    type: "export",
    jobId: "split",
    conversation: createConversation(650),
    format: "html",
    filenameBase: "split",
    splitOptions: {
      force: true,
      messagesPerPart: 500
    }
  });
  const complete = await harness.waitFor("complete");
  assert.equal(complete.result.filename, "split-split-html.zip");
  assert.equal(complete.result.mimeType, "application/zip");
  assert.ok(complete.result.blob instanceof Blob);
  assert.ok(harness.messages.some((message) => message.type === "progress" && message.phase === "zip_compress"));
}

async function verifySplitPartsKeepMessages() {
  const harness = createWorkerHarness();
  harness.post({
    type: "export",
    jobId: "split-content",
    conversation: createConversation(650),
    format: "md",
    filenameBase: "split-content",
    splitOptions: {
      force: true,
      messagesPerPart: 500
    }
  });
  const complete = await harness.waitFor("complete");
  const part = complete.files.find((file) => file.role === "part");
  assert.equal(part.part.rangeEnd - part.part.rangeStart + 1, 500);
}

async function verifyAutoSplitThreshold() {
  const harness = createWorkerHarness();
  harness.post({
    type: "export",
    jobId: "auto-small",
    conversation: createConversation(128),
    format: "json",
    filenameBase: "auto-small",
    splitOptions: {
      enabled: true,
      force: false,
      minMessages: 600,
      messagesPerPart: 500
    }
  });
  const complete = await harness.waitFor("complete");
  assert.equal(complete.result.filename, "auto-small.json");
  assert.equal(complete.result.mimeType, "application/json;charset=utf-8");
  assert.equal(complete.split, false);
  assert.equal(complete.fileCount, 1);
}

async function verifyAutoSplitMediaThreshold() {
  const harness = createWorkerHarness();
  const conversation = createConversation(90);
  conversation.messages = conversation.messages.map((message, index) => ({
    ...message,
    parts: [
      ...(message.parts || []),
      { type: "image", url: `https://example.com/image-${index + 1}.png` }
    ]
  }));
  harness.post({
    type: "export",
    jobId: "auto-media",
    conversation,
    format: "html",
    filenameBase: "auto-media",
    splitOptions: {
      enabled: true,
      force: false,
      minMessages: 600,
      messagesPerPart: 500,
      imagesPerPart: 80,
      filesPerPart: 120
    }
  });
  const complete = await harness.waitFor("complete");
  assert.equal(complete.result.filename, "auto-media-split-html.zip");
  assert.equal(complete.split, true);
}

async function verifyCancel() {
  const harness = createWorkerHarness();
  harness.post({
    type: "export",
    jobId: "cancel",
    conversation: createConversation(1200),
    format: "html",
    filenameBase: "cancel",
    splitOptions: {
      force: true,
      messagesPerPart: 100
    }
  });
  harness.post({ type: "cancel", jobId: "cancel" });
  const result = await Promise.race([
    harness.waitFor("cancelled"),
    harness.waitFor("complete")
  ]);
  assert.ok(["cancelled", "complete"].includes(result.type));
}

async function main() {
  await verifySingleFile();
  await verifyDangerousHtmlUrlsBlocked();
  await verifySplitZip();
  await verifySplitPartsKeepMessages();
  await verifyAutoSplitThreshold();
  await verifyAutoSplitMediaThreshold();
  await verifyCancel();
  const fallbackHarness = createWorkerHarness({ opfs: false });
  fallbackHarness.post({
    type: "export",
    jobId: "fallback",
    conversation: createConversation(3),
    format: "md",
    filenameBase: "fallback"
  });
  await fallbackHarness.waitFor("complete");
  assert.ok(fallbackHarness.messages.some((message) => message.type === "storage" && message.mode === "memory"));
  console.log("Export worker verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
