const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createLargeExportContractHarness } = require("./large-export-contract");

function createContext() {
  const storageData = Object.create(null);
  const context = {
    console,
    URL,
    Date,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Set,
    Map,
    Promise,
    Blob,
    Uint8Array,
    ArrayBuffer,
    TextEncoder,
    TextDecoder,
    AbortController,
    atob(value) {
      return Buffer.from(String(value), "base64").toString("binary");
    },
    btoa(value) {
      return Buffer.from(String(value), "binary").toString("base64");
    },
    Node: {
      DOCUMENT_POSITION_FOLLOWING: 4,
      DOCUMENT_POSITION_PRECEDING: 2
    },
    crypto: {
      subtle: nodeCrypto.webcrypto.subtle,
      getRandomValues: nodeCrypto.webcrypto.getRandomValues.bind(nodeCrypto.webcrypto),
      randomUUID: () => "test-random-id"
    },
    location: {
      origin: "https://www.doubao.com",
      href: "https://www.doubao.com/chat/100?web_tab_id=page-tab"
    },
    performance: {
      getEntriesByType: () => []
    },
    history: {
      pushState() {},
      replaceState() {}
    },
    MutationObserver: function MutationObserver() {
      this.observe = () => {};
      this.disconnect = () => {};
    },
    sessionStorage: {
      _data: Object.create(null),
      getItem(key) {
        return this._data[key] || "";
      },
      setItem(key, value) {
        this._data[key] = String(value);
      }
    },
    chrome: {
      storage: {
        local: {
          async get(keys) {
            if (Array.isArray(keys)) {
              return Object.fromEntries(keys.map((key) => [key, storageData[key]]));
            }
            if (typeof keys === "string") {
              return { [keys]: storageData[keys] };
            }
            if (keys && typeof keys === "object") {
              return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
                key,
                Object.prototype.hasOwnProperty.call(storageData, key) ? storageData[key] : fallback
              ]));
            }
            return { ...storageData };
          },
          async set(items) {
            Object.assign(storageData, items || {});
            return {};
          }
        }
      }
    },
    document: null,
    window: null,
    __anchors: [],
    __storageData: storageData,
    __zipInstances: []
  };

  context.document = {
    title: "Test Conversation",
    readyState: "complete",
    body: {},
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: (selector) => selector.includes("a") && selector.includes("/chat/") ? context.__anchors : [],
    getElementById: () => null,
    createElement: () => ({
      style: {},
      appendChild() {},
      remove() {},
      addEventListener() {},
      set innerHTML(value) {
        this._innerHTML = value;
      }
    })
  };

  context.window = {
    location: context.location,
    document: context.document,
    atob: context.atob,
    btoa: context.btoa,
    TextEncoder,
    TextDecoder,
    crypto: context.crypto,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {}
  };

  return context;
}

function loadHelpers() {
  const projectRoot = path.resolve(__dirname, "..");
  const sourcePath = path.join(projectRoot, "src", "content.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const marker = "  async function init() {";
  const cutIndex = source.indexOf(marker);
  if (cutIndex === -1) {
    throw new Error("Unable to isolate helper functions from content.js");
  }

  const factorySource = `${source.slice(0, cutIndex)}
  return {
    state,
    currentConversationId,
    currentConversationUrl,
    parseSingleChainMessages,
    shouldReplaceConversation,
    buildWebTabIdCandidates,
    ensureRequestUrl,
    isSingleChainUrl,
    collectSidebarSummaries,
    handleBridgeMessage,
    panelHtml,
    bindPanel,
    executeJsonRequest,
    fetchAllConversationMessages,
    createSingleChainPagePace,
    updateSingleChainPagePace,
    singleChainPageSleepMs,
    ensureCurrentConversationFresh,
    buildDomConversation,
    saveCache,
    mergeDomMessagesWithCache,
    setConversationLoadFeedback,
    runtimeLogText,
    cachedCurrentConversationForExport,
    filterMessagesByDateRange,
    applyDateRangeToConversation,
    dateRangeFileToken,
    rawRemoteMessageCountFromConversationItem,
    remoteMessageCountFromConversationItem,
    renderMarkdown,
    buildMarkdownExportText,
    buildTextExportText,
    conversationWithEmbeddedAssets,
    conversationSplitMetrics,
    shouldSplitConversation,
    shouldForceSplitConversation,
    shouldForceSplitForCurrentConversation,
    splitPartsForConversation,
    buildSplitConversationZip,
    downloadBlob,
    requireLicenseForAccess,
    requireLicenseForExport,
    progressMessage
  };
})();`;

  const context = createContext();
  const helpers = vm.runInNewContext(factorySource, context, { filename: "content.js" });
  return { helpers, context };
}

function loadExportWorkerHelpers() {
  const projectRoot = path.resolve(__dirname, "..");
  const sourcePath = path.join(projectRoot, "src", "export-worker.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  const marker = '  self.addEventListener("message", (event) => {';
  const cutIndex = source.indexOf(marker);
  if (cutIndex === -1) {
    throw new Error("Unable to isolate helper functions from export-worker.js");
  }

  const factorySource = `${source.slice(0, cutIndex)}
  return {
    renderMarkdown
  };
})();`;

  const context = {
    console,
    URL,
    Date,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Set,
    Map,
    Promise,
    Blob,
    Uint8Array,
    ArrayBuffer,
    self: {}
  };
  return vm.runInNewContext(factorySource, context, { filename: "export-worker.js" });
}

function readProjectFile(relativePath) {
  const projectRoot = path.resolve(__dirname, "..");
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function extractRegion(html, pattern, label) {
  const match = html.match(pattern);
  assert.ok(match, `Missing ${label}`);
  return match[0];
}

function assertWindowControlsContract(source, label) {
  assert.match(source, /data-window-action="close"/, `${label} must keep the close control`);
  assert.match(source, /data-window-action="drag"/, `${label} must use the yellow button for dragging`);
  assert.match(source, /data-window-action="reset"/, `${label} must use the green button for reset`);
  assert.doesNotMatch(source, /data-window-action="minimize"/, `${label} must not keep the old minimize action`);
  assert.doesNotMatch(source, /data-window-action="expand"/, `${label} must not keep the old expand action`);
}

function assertMinimalShellContract(html, label) {
  assert.doesNotMatch(html, /<aside class="dbx-sidebar"/, `${label} must remove the old sidebar`);
  assert.doesNotMatch(html, /<nav class="dbx-nav"/, `${label} must remove the old navigation rail`);
  assert.doesNotMatch(html, /data-tab=/, `${label} must not keep tab navigation attributes`);
  assert.doesNotMatch(html, new RegExp(["批", "量", "导", "出"].join("")), `${label} must not expose batch export`);
  assert.doesNotMatch(html, /会话库/, `${label} must not keep the old 会话库 label`);
  assert.match(html, /class="dbx-titlebar-actions"/, `${label} must keep the top-right action area`);
  assert.match(html, /豆包导出助手/, `${label} must show the product name in the titlebar`);
  assert.match(html, /class="dbx-about-action[^"]*"/, `${label} must expose the about action button`);
  assert.match(html, /data-action="toggle-about"/, `${label} about action must toggle the drawer`);
  assert.doesNotMatch(html, /需激活/, `${label} titlebar must not show access gating copy`);
}

function assertCurrentPanelContract(html, label) {
  const currentPanel = extractRegion(html, /data-panel="current"[\s\S]*?<\/section>/, `${label} current panel`);

  [
    /基本设置/,
    /查看导出详情/,
    /请求状态/,
    /数据来源/,
    /模板状态/,
    /查看扫描详情/
  ].forEach((pattern) => {
    assert.doesNotMatch(currentPanel, pattern, `${label} current panel must hide technical blocks by default`);
  });
}

function assertAboutDrawerContract(html, label) {
  const aboutDrawer = extractRegion(html, /<aside[\s\S]*?class="dbx-about-drawer[\s\S]*?<\/aside>/, `${label} about drawer`);
  assert.match(aboutDrawer, /<h2>关于<\/h2>/, `${label} about drawer must have a clear title`);
  assert.match(aboutDrawer, /data-action="close-about"/, `${label} about drawer must have a close action`);
  assert.match(aboutDrawer, /免费版/, `${label} about drawer must show free release copy`);
  assert.match(aboutDrawer, /本工具仅供用户本地备份本人账号聊天记录，数据不上传服务器/, `${label} about drawer must include the local backup privacy note`);
  assert.match(aboutDrawer, /所有处理都在当前浏览器本地完成/, `${label} about drawer must explain local processing`);
  assert.doesNotMatch(aboutDrawer, /激活|授权|微信|小红书|QQ 群/, `${label} about drawer must not expose access gating or private contacts`);
  assert.doesNotMatch(aboutDrawer, /查看更新说明|changelog\.html/, `${label} about drawer must not expose the changelog entry`);
}

function assertFooterFeedbackContract(html, label) {
  const footer = extractRegion(html, /<div class="dbx-footer"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, `${label} footer`);
  assert.match(footer, /dbx-footer-feedback/, `${label} footer must contain the progress notification bar`);
  assert.match(
    footer,
    /role="progressbar"/,
    `${label} footer feedback must expose progress status`
  );
  assert.doesNotMatch(html, /data-feedback-scope=/, `${label} panels must not contain duplicated progress notification bars`);
}

function assertCompactCurrentLayoutContract(html, label) {
  const currentPanel = extractRegion(html, /data-panel="current"[\s\S]*?<\/section>/, `${label} current panel`);
  assert.doesNotMatch(currentPanel, /dbx-summary-row|dbx-summary-chip/, `${label} current panel must not show header status chips`);
  assert.doesNotMatch(currentPanel, /dbx-hero|dbx-title-copy/, `${label} current panel must not reserve a title hero`);
  assert.doesNotMatch(currentPanel, /选择格式后直接导出当前会话/, `${label} current panel must keep the header compact`);
  assert.match(currentPanel, /data-split-mode-toggle[\s\S]*data-date-range-toggle/, `${label} date range toggle must sit after split export in the compact option grid`);
}

function assertFreeAccessContract(source, label) {
  const accessGuard = extractRegion(
    source,
    /async function requireLicenseForAccess[\s\S]*?async function requireLicenseForExport/,
    `${label} free access guard`
  );
  assert.match(accessGuard, /return true/, `${label} access guard must allow free use`);
  assert.doesNotMatch(accessGuard, /throw|激活|license_required/, `${label} access guard must not block export`);

  const actionCatch = extractRegion(
    source,
    /const message = progressMessage\(error\);[\s\S]*?syncPanelDom\(overlay\);/,
    `${label} action error handler`
  );
  assert.doesNotMatch(actionCatch, /showToast\(message\)/, `${label} action errors must stay inside the panel`);
}

function assertExportRefreshAvoidGlobalToastContract(source, label) {
  const exportCurrent = extractRegion(
    source,
    /async function exportCurrentConversation[\s\S]*?function formatTimeLabel/,
    `${label} current export flow`
  );
  assert.doesNotMatch(exportCurrent, /showToast\(/, `${label} current export flow must keep feedback inside the panel`);

  const refreshFlow = extractRegion(
    source,
    /if \(action === "refresh-current"\)[\s\S]*?if \(action === "go-current"\)/,
    `${label} current refresh flow`
  );
  assert.doesNotMatch(refreshFlow, /showToast\(/, `${label} current refresh flow must keep feedback inside the panel`);

  const actionCatch = extractRegion(
    source,
    /const message = progressMessage\(error\);[\s\S]*?syncPanelDom\(overlay\);/,
    `${label} action error handler`
  );
  assert.doesNotMatch(actionCatch, /else[\s\S]*showToast\(message\)/, `${label} action failures must not use the global toast`);
}

function assertProgressCopyContract(source, label) {
  assert.match(
    source,
    /导出中|正在导出|打包中|正在打包|处理中/,
    `${label} must include explicit export progress copy near the main actions`
  );
}

function createAnchor({ href, title, id = "", className = "", ariaCurrent = "", isSidebar = true }) {
  return {
    id,
    href: new URL(href, "https://www.doubao.com").toString(),
    className,
    textContent: title,
    innerText: title,
    getAttribute(name) {
      if (name === "id") return id;
      if (name === "href") return href;
      if (name === "aria-current") return ariaCurrent;
      return "";
    },
    closest() {
      return isSidebar ? {} : null;
    }
  };
}

function installFakeMessageDom(context, messages) {
  class FakeElement {
    constructor({ attrs = {}, className = "", text = "", children = [], order = 0 } = {}) {
      this.attrs = attrs;
      this.className = className;
      this.textContent = text;
      this.innerText = text;
      this.children = children;
      this.order = order;
      this.style = {};
      this.hidden = false;
      this.scrollTop = 0;
      this.scrollHeight = 0;
      this.clientHeight = 0;
      this.parentElement = null;
      children.forEach((child) => {
        child.parentElement = this;
      });
    }

    getAttribute(name) {
      return this.attrs[name] || "";
    }

    closest(selector) {
      if (selector.includes("sidebar") || selector.includes("leftside") || selector.includes("sider") || selector.includes("aside")) {
        return null;
      }
      if (selector.includes("[data-testid='send_message']") || selector.includes("[data-testid='receive_message']")) {
        const testId = this.getAttribute("data-testid");
        return testId === "send_message" || testId === "receive_message" ? this : null;
      }
      return null;
    }

    matchesSelector(selector) {
      return selector
        .split(",")
        .map((part) => part.trim())
        .some((part) => {
          if (part === "[data-message-id]") return Boolean(this.getAttribute("data-message-id"));
          if (part === "[data-testid='send_message']") return this.getAttribute("data-testid") === "send_message";
          if (part === "[data-testid='receive_message']") return this.getAttribute("data-testid") === "receive_message";
          if (part === "[data-target-id='message-box-target-id']") return this.getAttribute("data-target-id") === "message-box-target-id";
          if (part === "[data-testid='message-list']") return this.getAttribute("data-testid") === "message-list";
          if (part === "[data-testid='message-block-container']") return this.getAttribute("data-testid") === "message-block-container";
          if (part === "[class*='message-list-']") return String(this.className || "").includes("message-list-");
          return false;
        });
    }

    querySelectorAll(selector) {
      const output = [];
      const visit = (element) => {
        element.children.forEach((child) => {
          if (child.matchesSelector(selector)) output.push(child);
          visit(child);
        });
      };
      visit(this);
      return output;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    compareDocumentPosition(other) {
      return this.order < other.order
        ? context.Node.DOCUMENT_POSITION_FOLLOWING
        : context.Node.DOCUMENT_POSITION_PRECEDING;
    }

    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600
      };
    }
  }

  const rows = messages.map((message, index) => new FakeElement({
    attrs: {
      "data-message-id": message.id
    },
    className: message.role === "user" ? "v_list_row justify-end" : "v_list_row assistant-message",
    text: message.text,
    order: index + 1
  }));
  const root = new FakeElement({
    attrs: {
      "data-target-id": "message-box-target-id"
    },
    className: "message-list-zLoNs1",
    children: rows,
    order: 0
  });
  root.scrollTop = 120;
  root.scrollHeight = Math.max(900, rows.length * 120);
  root.clientHeight = 480;
  root.style.overflowY = "auto";

  context.document.querySelectorAll = (selector) => {
    if (selector.includes("a") && selector.includes("/chat/")) return context.__anchors;
    if (root.matchesSelector(selector)) return [root];
    return root.querySelectorAll(selector);
  };
  context.document.querySelector = (selector) => context.document.querySelectorAll(selector)[0] || null;
  context.window.getComputedStyle = (element) => ({
    overflowY: element?.style?.overflowY || "visible",
    getPropertyValue(name) {
      if (name === "pointer-events") return element?.style?.pointerEvents || "auto";
      if (name === "overflow-y") return element?.style?.overflowY || "visible";
      return "";
    }
  });
  context.document.body = root;
  context.document.documentElement = root;
  return { root, rows };
}

function resetState(helpers) {
  helpers.state.cache.conversations = {};
  helpers.state.cache.summaries = {};
  helpers.state.cache.requests = {
    single: { captured: null, success: null, failure: null },
    recent: { captured: null, success: null, failure: null },
    title: { captured: null, success: null, failure: null }
  };
  helpers.state.cache.webTabId = "";
}

function useImmediatePageTimers(context) {
  context.window.setTimeout = (callback, ms = 0) => {
    if (Number(ms || 0) < 45000 && typeof callback === "function") {
      callback();
    }
    return 1;
  };
  context.window.clearTimeout = () => {};
}

function testCurrentConversationIdSupportsAgentUrls() {
  const { helpers, context } = loadHelpers();

  assert.equal(
    helpers.currentConversationId("https://www.doubao.com/chat/bot/chat/7296007496437661747"),
    "",
    "agent chat routes must not use the bot id when no real conversation id is available"
  );
  assert.equal(
    helpers.currentConversationId("https://www.doubao.com/chat/58624263371266?web_tab_id=abc"),
    "58624263371266"
  );
  assert.equal(
    helpers.currentConversationId("https://www.doubao.com/chat/bot?conversation_id=58624263371266"),
    "58624263371266"
  );

  context.location.href = "https://www.doubao.com/chat/bot/chat/7296007496437661747";
  context.window.location = context.location;
  context.__anchors = [
    createAnchor({
      id: "conversation_38428413733584130",
      href: "/chat/bot/chat/7296007496437661747",
      title: "学习小帮手",
      className: "chat-item active-link-CytK2D e2e-test-active"
    })
  ];

  assert.equal(
    helpers.currentConversationId("https://www.doubao.com/chat/bot/chat/7296007496437661747"),
    "38428413733584130",
    "agent chat routes must use the sidebar conversation id instead of the bot id in the URL"
  );
  assert.equal(
    helpers.currentConversationUrl("38428413733584130"),
    "https://www.doubao.com/chat/bot/chat/7296007496437661747"
  );
}

function testAgentConversationIdAvoidsBotFallbacks() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);

  context.location.href = "https://www.doubao.com/chat/bot";
  context.window.location = context.location;
  context.__anchors = [];
  assert.equal(helpers.currentConversationId(), "", "agent home must not be treated as conversationId=bot");

  context.location.href = "https://www.doubao.com/chat/bot/chat/7296007496437661747";
  context.window.location = context.location;
  assert.equal(
    helpers.currentConversationId(),
    "",
    "agent bot id from the route is not a loadable conversation id"
  );

  helpers.state.cache.requests.single.captured = {
    url: "https://www.doubao.com/im/chain/single?web_tab_id=template-tab",
    pageUrl: "https://www.doubao.com/chat/bot/chat/other-bot",
    method: "POST",
    headers: {},
    bodyText: JSON.stringify({
      uplink_body: {
        pull_singe_chain_uplink_body: {
          conversation_id: "38400000000000000"
        }
      }
    })
  };
  assert.equal(
    helpers.currentConversationId(),
    "",
    "captured request ids from a different agent page must not leak into the current page"
  );

  helpers.state.cache.requests.single.captured = {
    ...helpers.state.cache.requests.single.captured,
    pageUrl: context.location.href,
    bodyText: JSON.stringify({
      uplink_body: {
        pull_singe_chain_uplink_body: {
          conversation_id: "38428413733584130"
        }
      }
    })
  };
  assert.equal(
    helpers.currentConversationId(),
    "38428413733584130",
    "agent pages can recover the real conversation id from a matching captured request"
  );

  helpers.state.cache.requests.single.captured = {
    ...helpers.state.cache.requests.single.captured,
    bodyText: JSON.stringify({
      uplink_body: {
        pull_singe_chain_uplink_body: {
          conversation_id: "7296007496437661747"
        }
      }
    })
  };
  assert.equal(
    helpers.currentConversationId(),
    "",
    "old bad cache entries that stored the bot id must not be reused as conversation ids"
  );

  helpers.state.cache.requests.single.captured = null;
  helpers.state.cache.summaries["7296007496437661747"] = {
    id: "7296007496437661747",
    title: "旧错误缓存",
    url: context.location.href
  };
  assert.equal(
    helpers.currentConversationId(),
    "",
    "old summaries keyed by the bot id must not be reused as conversation ids"
  );

  helpers.state.cache.summaries["38428413733584130"] = {
    id: "38428413733584130",
    title: "学习小帮手",
    url: context.location.href
  };
  assert.equal(
    helpers.currentConversationId(),
    "38428413733584130",
    "agent pages can recover the real conversation id from cached summaries"
  );
}

function testMessageNormalization() {
  const { helpers } = loadHelpers();
  const payload = {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            message_id: "msg-1",
            role: "assistant",
            index_in_conv: 1,
            create_time: 101,
            tts_content: "[stylesheet-group=\"0\"]{} body{margin:0;} .css-146c3p1{display:inline;font-family:Arial;} .r-13awgt0{flex:1;} ignored css noise",
            content_block: [
              {
                type: "artifact",
                artifact_text: "Artifact summary",
                cells: [
                  {
                    type: "tool_call",
                    arguments: {
                      query: "latest status"
                    }
                  }
                ]
              },
              {
                text: "Final answer"
              }
            ],
            content: JSON.stringify({
              type: "result_card",
              title: "Result card title",
              payload: {
                status: "ok"
              }
            }),
            images: [
              {
                url: "https://example.com/image.png",
                name: "image.png"
              }
            ]
          }
        ]
      }
    }
  };

  const messages = helpers.parseSingleChainMessages(payload);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "msg-1");
  assert.match(messages[0].text, /Final answer/);
  assert.doesNotMatch(messages[0].text, /\[stylesheet-group=/);
  assert.ok(messages[0].parts.some((part) => part.type === "structured" && part.label === "artifact" && part.preview));
  assert.ok(messages[0].parts.some((part) => part.type === "structured" && part.label === "tool call" && part.preview));
  assert.ok(messages[0].parts.some((part) => part.type === "structured" && part.label === "result card" && part.preview));
  assert.ok(messages[0].parts.every((part) => !Object.prototype.hasOwnProperty.call(part, "raw")));
  assert.ok(messages[0].parts.every((part) => part.type !== "text" && part.type !== "image" && part.type !== "attachment"));
  assert.ok(messages[0].attachments.some((attachment) => attachment.url === "https://example.com/image.png"));
  assert.equal(messages[0].metadata.createTime, 101);
}

function testMessageNormalizationBoundsStructuredPreviewMemory() {
  const { helpers } = loadHelpers();
  const hugeText = "x".repeat(5000);
  const payload = {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            message_id: "msg-large-structured",
            role: "assistant",
            index_in_conv: 1,
            content_block: {
              type: "reference",
              title: "Large reference",
              docs: Array.from({ length: 40 }, (_, index) => ({
                id: `doc-${index + 1}`,
                title: `Document ${index + 1}`,
                body: hugeText
              }))
            }
          }
        ]
      }
    }
  };

  const messages = helpers.parseSingleChainMessages(payload);
  const structured = messages[0].parts.find((part) => part.type === "structured");

  assert.ok(structured, "structured-only messages must keep a bounded preview");
  assert.equal(Object.prototype.hasOwnProperty.call(structured, "raw"), false);
  assert.ok(structured.preview.length <= 820, "structured preview must stay bounded");
  assert.doesNotMatch(structured.preview, new RegExp(hugeText.slice(0, 1000)));
}

function testMessageNormalizationReadsAlternateTimestampFields() {
  const { helpers } = loadHelpers();
  const payload = {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            message_id: "msg-ctime-1",
            role: "user",
            index_in_conv: 2,
            ctime: 1713421385,
            content_block: [
              {
                text: "用户消息"
              }
            ]
          }
        ]
      }
    }
  };

  const messages = helpers.parseSingleChainMessages(payload);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].metadata.createTime, 1713421385);
}

function testMessageNormalizationReadsOfficialMessageListShape() {
  const { helpers } = loadHelpers();
  const payload = {
    data: {
      message_list: [
        {
          id: "official-msg-2",
          role: "assistant",
          index: 2,
          create_time: 1713421386,
          content_block: [
            {
              text: "官方 message_list 形态"
            }
          ]
        }
      ],
      has_more: true
    }
  };

  const messages = helpers.parseSingleChainMessages(payload);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "official-msg-2");
  assert.equal(messages[0].metadata.index, 2);
  assert.equal(messages[0].text, "官方 message_list 形态");
}

function testMessageNormalizationUsesVisibleRegeneratedReply() {
  const { helpers } = loadHelpers();
  const payload = {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            message_id: "user-1",
            user_type: 1,
            index_in_conv: 1,
            content_block: [{ text: "Need a reply." }]
          },
          {
            message_id: "root-assistant-1",
            user_type: 2,
            status: 8,
            index_in_conv: 2,
            content_block: [{ text: "First generated reply." }],
            regen_msg_list: [
              { is_visible: false, msg_id_list: ["regen-assistant-1"] },
              { is_visible: true, msg_id_list: ["regen-assistant-2"] }
            ]
          },
          {
            message_id: "hidden-assistant-3",
            user_type: 2,
            status: 1,
            index_in_conv: 3,
            content_block: [{ text: "Hidden reply." }]
          }
        ],
        regen_messages: {
          "regen-assistant-1": {
            message_id: "regen-assistant-1",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 1,
            index_in_conv: 2,
            content_block: [{ text: "First generated reply." }]
          },
          "regen-assistant-2": {
            message_id: "regen-assistant-2",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 1,
            index_in_conv: 2,
            content_block: [{ text: "Second selected reply." }]
          }
        }
      }
    }
  };

  const messages = helpers.parseSingleChainMessages(payload);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].id, "regen-assistant-2");
  assert.equal(messages[1].text, "Second selected reply.");
  assert.doesNotMatch(messages.map((message) => message.text).join("\n"), /First generated reply|Hidden reply/);
}

function testMessageNormalizationReplacesSelfRootRegeneratedReply() {
  const { helpers } = loadHelpers();
  const payload = {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            message_id: "user-1",
            user_type: 1,
            index_in_conv: 1,
            content_block: [{ text: "Need a reply." }]
          },
          {
            message_id: "root-assistant-1",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 8,
            index_in_conv: 2,
            content_block: [{ text: "First generated reply." }],
            regen_msg_list: [
              { is_visible: false, msg_id_list: ["root-assistant-1"] },
              { is_visible: true, msg_id_list: ["regen-assistant-2"] }
            ]
          }
        ],
        regen_messages: [
          {
            message_id: "root-assistant-1",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 8,
            index_in_conv: 2,
            content_block: [{ text: "First generated reply." }]
          },
          {
            message_id: "regen-assistant-2",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 10,
            index_in_conv: 3,
            content_block: [{ text: "Second selected reply." }]
          }
        ]
      }
    }
  };

  const messages = helpers.parseSingleChainMessages(payload);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((message) => message.id), ["user-1", "regen-assistant-2"]);
  assert.equal(messages[1].text, "Second selected reply.");
}

function testMessageNormalizationSkipsDuplicateVisibleRegeneratedReply() {
  const { helpers } = loadHelpers();
  const payload = {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            message_id: "user-1",
            user_type: 1,
            index_in_conv: 1,
            content_block: [{ text: "Need a reply." }]
          },
          {
            message_id: "root-assistant-1",
            user_type: 2,
            status: 8,
            index_in_conv: 2,
            content_block: [{ text: "First generated reply." }],
            regen_msg_list: [
              { is_visible: true, msg_id_list: ["regen-assistant-2"] },
              { is_visible: false, msg_id_list: ["regen-assistant-1"] }
            ]
          },
          {
            message_id: "regen-assistant-2",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 0,
            index_in_conv: 2,
            content_block: [{ text: "Second selected reply." }]
          }
        ],
        regen_messages: {
          "regen-assistant-1": {
            message_id: "regen-assistant-1",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 1,
            index_in_conv: 2,
            content_block: [{ text: "First generated reply." }]
          },
          "regen-assistant-2": {
            message_id: "regen-assistant-2",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 0,
            index_in_conv: 2,
            content_block: [{ text: "Second selected reply." }]
          }
        }
      }
    }
  };

  const messages = helpers.parseSingleChainMessages(payload);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((message) => message.id), ["user-1", "regen-assistant-2"]);
}

function testMessageNormalizationKeepsVisibleRegeneratedChildWithoutRoot() {
  const { helpers } = loadHelpers();
  const payload = {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            message_id: "user-1",
            user_type: 1,
            index_in_conv: 1,
            content_block: [{ text: "Need a table." }]
          },
          {
            message_id: "regen-assistant-1",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 1,
            index_in_conv: 2,
            content_block: [{ text: "Visible selected reply." }]
          }
        ]
      }
    }
  };

  const messages = helpers.parseSingleChainMessages(payload);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].id, "regen-assistant-1");
  assert.equal(messages[1].text, "Visible selected reply.");
}

function testMessageNormalizationUsesStatusTenRegeneratedReplyWithoutVisibleList() {
  const { helpers } = loadHelpers();
  const payload = {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            message_id: "user-1",
            user_type: 1,
            index_in_conv: 1,
            content_block: [{ text: "Need a reply." }]
          },
          {
            message_id: "root-assistant-1",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 8,
            index_in_conv: 2,
            content_block: [{ text: "First generated reply." }]
          }
        ],
        regen_messages: [
          {
            message_id: "regen-assistant-1",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 1,
            index_in_conv: 2,
            content_block: [{ text: "Hidden old reply." }]
          },
          {
            message_id: "regen-assistant-2",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 10,
            index_in_conv: 3,
            content_block: [{ text: "Current selected reply." }]
          }
        ]
      }
    }
  };

  const messages = helpers.parseSingleChainMessages(payload);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((message) => message.id), ["user-1", "regen-assistant-2"]);
  assert.equal(messages[1].text, "Current selected reply.");
  const diagnostics = helpers.runtimeLogText();
  assert.match(diagnostics, /regen_branch_select/);
  assert.match(diagnostics, /status_10=1/);
  assert.match(diagnostics, /samples=/);
}

function testMessageNormalizationUsesRegeneratedReplyWhenRootStatusIsNotEight() {
  const { helpers } = loadHelpers();
  const payload = {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            message_id: "user-1",
            user_type: 1,
            index_in_conv: 1,
            content_block: [{ text: "Need a reply." }]
          },
          {
            message_id: "root-assistant-1",
            user_type: 2,
            status: 0,
            index_in_conv: 2,
            content_block: [{ text: "First generated reply." }],
            regen_msg_list: [
              { is_visible: true, msg_id_list: ["regen-assistant-2"] }
            ]
          }
        ],
        regen_messages: [
          {
            message_id: "regen-assistant-2",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 10,
            index_in_conv: 3,
            content_block: [{ text: "Visible selected reply." }]
          }
        ]
      }
    }
  };

  const messages = helpers.parseSingleChainMessages(payload);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((message) => message.id), ["user-1", "regen-assistant-2"]);
  assert.equal(messages[1].text, "Visible selected reply.");
}

function testMessageNormalizationUsesVisibleDomRegeneratedReplyWithoutSwitcher() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  installFakeMessageDom(context, [
    { id: "user-1", role: "user", text: "Need a reply." },
    { id: "regen-assistant-visible", role: "assistant", text: "Visible DOM reply." }
  ]);
  const payload = {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            message_id: "user-1",
            user_type: 1,
            index_in_conv: 1,
            content_block: [{ text: "Need a reply." }]
          },
          {
            message_id: "root-assistant-1",
            user_type: 2,
            status: 8,
            index_in_conv: 2,
            content_block: [{ text: "First generated reply." }]
          }
        ],
        regen_messages: [
          {
            message_id: "regen-assistant-visible",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 0,
            index_in_conv: 2,
            content_block: [{ text: "Visible DOM reply." }]
          },
          {
            message_id: "regen-assistant-status-10",
            regen_root_id: "root-assistant-1",
            user_type: 2,
            status: 10,
            index_in_conv: 3,
            content_block: [{ text: "Status ten reply." }]
          }
        ]
      }
    }
  };

  const messages = helpers.parseSingleChainMessages(payload);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((message) => message.id), ["user-1", "regen-assistant-visible"]);
  assert.equal(messages[1].text, "Visible DOM reply.");
  const diagnostics = helpers.runtimeLogText();
  assert.match(diagnostics, /dom_visible=1/);
  assert.match(diagnostics, /visibleDomIds=user-1,...nt-visible/);
  assert.match(diagnostics, /"reason":"dom_visible"/);
}

function testMessageNormalizationCollapsesImageVariantsByCreation() {
  const { helpers } = loadHelpers();
  const payload = {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            message_id: "msg-images-1",
            role: "user",
            images: [
              {
                creation: { id: "creation-a" },
                image_thumb: { url: "https://example.com/a-thumb.png" },
                image_preview: { url: "https://example.com/a-preview.png" },
                image_ori: { url: "https://example.com/a-ori.png" }
              },
              {
                creation: { id: "creation-b" },
                image_thumb: { url: "https://example.com/b-thumb.png" },
                image_ori: { url: "https://example.com/b-ori.png" }
              }
            ]
          }
        ]
      }
    }
  };

  const messages = helpers.parseSingleChainMessages(payload);
  assert.deepEqual(
    Array.from(messages[0].attachments, (attachment) => attachment.url),
    ["https://example.com/a-ori.png", "https://example.com/b-ori.png"]
  );
  assert.deepEqual(
    Array.from(messages[0].attachments, (attachment) => attachment.imageVariant),
    ["image_ori", "image_ori"]
  );
}

function testConversationMergeRule() {
  const { helpers } = loadHelpers();
  const existing = {
    full: true,
    messages: [{ id: "a" }, { id: "b" }],
    updatedAt: "2026-04-17T08:00:00.000Z"
  };
  const incoming = {
    full: false,
    messages: [{ id: "a" }],
    updatedAt: "2026-04-17T09:00:00.000Z"
  };
  assert.equal(helpers.shouldReplaceConversation(existing, incoming), false);
}

function testRequestCandidateOrder() {
  const { helpers } = loadHelpers();
  resetState(helpers);
  helpers.state.cache.requests.single.success = {
    url: "https://www.doubao.com/im/chain/single?web_tab_id=single-success",
    method: "POST",
    headers: {},
    bodyText: "{}"
  };
  helpers.state.cache.requests.recent.success = {
    url: "https://www.doubao.com/im/chain/recent_conv?web_tab_id=recent-success",
    method: "POST",
    headers: {},
    bodyText: "{}"
  };
  helpers.state.cache.requests.title.success = {
    url: "https://www.doubao.com/im/conversation/info?web_tab_id=title-success",
    method: "GET",
    headers: {},
    bodyText: ""
  };

  const candidates = helpers.buildWebTabIdCandidates("https://www.doubao.com/im/chain/single?web_tab_id=template-tab");
  assert.deepEqual(
    Array.from(candidates, (candidate) => candidate.value),
    ["template-tab", "page-tab", "single-success", "recent-success", "title-success"]
  );

  const requestUrl = helpers.ensureRequestUrl("", "/im/chain/single", helpers.isSingleChainUrl);
  assert.equal(requestUrl.webTabId, "page-tab");
}

function testSingleChainAdaptiveDelay() {
  const { helpers } = loadHelpers();
  const pace = helpers.createSingleChainPagePace();

  let delay = helpers.singleChainPageSleepMs(1, pace);
  assert.ok(delay >= 80 && delay < 100);

  helpers.updateSingleChainPagePace(pace, { latencyMs: 350, pageMessages: 50 });
  assert.equal(pace.mode, "fast");
  delay = helpers.singleChainPageSleepMs(4, pace);
  assert.ok(delay >= 8 && delay < 12);

  helpers.updateSingleChainPagePace(pace, { latencyMs: 1800, pageMessages: 50 });
  assert.equal(pace.mode, "probe");
  delay = helpers.singleChainPageSleepMs(500, pace);
  assert.ok(delay >= 80 && delay < 100);

  helpers.updateSingleChainPagePace(pace, { latencyMs: 200, pageMessages: 0 });
  assert.equal(pace.mode, "backoff");
  delay = helpers.singleChainPageSleepMs(6, pace);
  assert.ok(delay >= 3000 && delay < 5000);
}

async function testFetchAllConversationMessagesIgnoresStaleExpectedCount() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  useImmediatePageTimers(context);

  const conversationId = "conversation-long-api";
  helpers.state.cache.summaries[conversationId] = {
    id: conversationId,
    title: "Long API conversation",
    messageCount: 99,
    captureState: "full"
  };

  const makeMessages = (from, to) => {
    const output = [];
    for (let index = from; index >= to; index -= 1) {
      output.push({
        message_id: `msg-${index}`,
        user_type: index % 2 === 0 ? 1 : 2,
        index_in_conv: String(index),
        create_time: 1713421000 + index,
        content_block: [
          {
            text: `Message ${index}`
          }
        ]
      });
    }
    return output;
  };

  const pages = [
    { messages: makeMessages(150, 101), has_more: true, next_index: "100" },
    { messages: makeMessages(100, 51), has_more: true, next_index: "50" },
    { messages: makeMessages(50, 1), has_more: false, next_index: "0" }
  ];
  const calls = [];

  context.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    const pull = body.uplink_body?.pull_singe_chain_uplink_body || {};
    calls.push({
      url: String(url),
      anchorIndex: pull.anchor_index,
      limit: pull.limit,
      cursor: pull.msg_cursor || ""
    });
    const page = pages.shift();
    assert.ok(page, "fetchAllConversationMessages must stop after the final page");
    const payload = {
      status_code: 0,
      status_desc: "OK",
      downlink_body: {
        pull_singe_chain_downlink_body: {
          messages: page.messages,
          has_more: page.has_more,
          next_index: page.next_index,
          msg_cursor: "1",
          regen_messages: {}
        }
      }
    };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(payload);
      }
    };
  };

  const conversation = await helpers.fetchAllConversationMessages(conversationId, "Long API conversation");

  assert.equal(conversation.messages.length, 150);
  assert.equal(conversation.full, true);
  assert.equal(conversation.captureState, "full");
  assert.equal(calls.length, 3, "stale summary messageCount must not stop pagination early");
  assert.deepEqual(calls.map((call) => call.anchorIndex), [Number.MAX_SAFE_INTEGER, 100, 50]);
  assert.equal(conversation.messages[0].text, "Message 1");
  assert.equal(conversation.messages.at(-1).text, "Message 150");
}

async function testFetchAllConversationMessagesUsesIndexAnchorForOfficialShape() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  useImmediatePageTimers(context);

  const conversationId = "conversation-official-message-list";
  const makeMessages = (from, to) => {
    const output = [];
    for (let index = from; index >= to; index -= 1) {
      output.push({
        id: `official-msg-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        index,
        create_time: 1713421000 + index,
        content_block: [
          {
            text: `Official message ${index}`
          }
        ]
      });
    }
    return output;
  };

  const pages = [
    { messages: makeMessages(150, 101), has_more: true },
    { messages: makeMessages(100, 51), has_more: true },
    { messages: makeMessages(50, 1), has_more: false }
  ];
  const calls = [];

  context.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    const pull = body.uplink_body?.pull_singe_chain_uplink_body || {};
    calls.push({
      anchorIndex: pull.anchor_index,
      cursor: pull.msg_cursor || ""
    });
    const page = pages.shift();
    assert.ok(page, "fetchAllConversationMessages must keep paging through message_list");
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          status_code: 0,
          data: {
            message_list: page.messages,
            has_more: page.has_more,
            msg_cursor: "constant-cursor"
          }
        });
      }
    };
  };

  const conversation = await helpers.fetchAllConversationMessages(conversationId, "Official shape");

  assert.equal(conversation.messages.length, 150);
  assert.equal(conversation.full, true);
  assert.deepEqual(calls.map((call) => call.anchorIndex), [Number.MAX_SAFE_INTEGER, 100, 50]);
  assert.deepEqual(calls.map((call) => call.cursor), ["", "", ""]);
  assert.equal(conversation.messages[0].text, "Official message 1");
  assert.equal(conversation.messages.at(-1).text, "Official message 150");
  const diagnostics = helpers.runtimeLogText();
  assert.match(diagnostics, /doubao-export version=/);
  assert.match(diagnostics, /scroll element=/);
  assert.match(diagnostics, /plugin panelOpen=/);
  assert.match(diagnostics, /refresh_page/);
  assert.match(diagnostics, /responseShape=data\.message_list/);
  assert.match(diagnostics, /messageList=data\.message_list/);
  assert.match(diagnostics, /refresh_next/);
  assert.match(diagnostics, /anchorSource=computed_min_index/);
}

async function testFetchAllConversationMessagesLoadsHundredsOfAgentMessages() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  useImmediatePageTimers(context);

  const conversationId = "38428413733584130";
  context.location.href = "https://www.doubao.com/chat/bot/chat/7296007496437661747";
  context.window.location = context.location;
  context.__anchors = [
    createAnchor({
      id: `conversation_${conversationId}`,
      href: "/chat/bot/chat/7296007496437661747",
      title: "客户自建智能体",
      className: "chat-item active-link-CytK2D e2e-test-active"
    })
  ];

  const makeMessages = (from, to) => {
    const output = [];
    for (let index = from; index >= to; index -= 1) {
      output.push({
        message_id: `agent-msg-${index}`,
        user_type: index % 2 === 0 ? 1 : 2,
        index_in_conv: index,
        create_time: 1713421000 + index,
        content_block: [
          {
            text: `Agent message ${index}`
          }
        ]
      });
    }
    return output;
  };

  const calls = [];
  context.fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body || "{}");
    const pull = body.uplink_body?.pull_singe_chain_uplink_body || {};
    const anchor = Number(pull.anchor_index || Number.MAX_SAFE_INTEGER);
    calls.push({
      conversationId: pull.conversation_id,
      anchor
    });
    const high = anchor >= Number.MAX_SAFE_INTEGER ? 425 : Math.min(424, anchor);
    const low = Math.max(1, high - 49);
    const hasMore = low > 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          status_code: 0,
          status_desc: "OK",
          downlink_body: {
            pull_singe_chain_downlink_body: {
              messages: makeMessages(high, low),
              has_more: hasMore,
              next_index: hasMore ? String(low - 1) : "0",
              msg_cursor: "1",
              regen_messages: {}
            }
          }
        });
      }
    };
  };

  const conversation = await helpers.ensureCurrentConversationFresh(true);

  assert.equal(helpers.currentConversationId(), conversationId);
  assert.equal(conversation.id, conversationId);
  assert.equal(conversation.messages.length, 425);
  assert.equal(conversation.full, true);
  assert.equal(calls.length, 9, "hundreds of agent messages must be fetched across all pages");
  assert.ok(calls.every((call) => call.conversationId === conversationId), "requests must use the real agent conversation id");
  assert.equal(conversation.messages[0].text, "Agent message 1");
  assert.equal(conversation.messages.at(-1).text, "Agent message 425");
  const diagnostics = helpers.runtimeLogText();
  assert.match(diagnostics, /refresh_finish/);
  assert.match(diagnostics, /messages=425/);
  assert.match(diagnostics, /completeness=api_full/);
  assert.doesNotMatch(diagnostics, /conversationId=bot/);
  assert.doesNotMatch(diagnostics, /conversationId=7296007496437661747/);
}

async function testFetchAllConversationMessagesReportsProgress() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  useImmediatePageTimers(context);

  const conversationId = "conversation-progress";
  const pages = [
    { messages: [{ message_id: "msg-2", user_type: 1, index_in_conv: "2", content_block: [{ text: "Two" }] }], has_more: true, next_index: "1" },
    { messages: [{ message_id: "msg-1", user_type: 2, index_in_conv: "1", content_block: [{ text: "One" }] }], has_more: false, next_index: "0" }
  ];

  context.fetch = async () => {
    const page = pages.shift();
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          status_code: 0,
          downlink_body: {
            pull_singe_chain_downlink_body: {
              messages: page.messages,
              has_more: page.has_more,
              next_index: page.next_index,
              msg_cursor: "1",
              regen_messages: {}
            }
          }
        });
      }
    };
  };

  const progress = [];
  const conversation = await helpers.fetchAllConversationMessages(conversationId, "Progress", "", {
    onProgress: (item) => progress.push(item)
  });

  assert.equal(conversation.messages.length, 2);
  assert.equal(progress.length, 2);
  assert.deepEqual(progress.map((item) => item.loaded), [1, 2]);
  assert.deepEqual(progress.map((item) => item.page), [1, 2]);
}

async function testFetchAllConversationMessagesStopsAtKnownCache() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  useImmediatePageTimers(context);

  const conversationId = "conversation-incremental";
  const cachedMessage = {
    id: "msg-2",
    role: "assistant",
    text: "Cached",
    metadata: {
      index: 2,
      createTime: 1713421002
    }
  };
  const pages = [
    {
      messages: [
        { message_id: "msg-3", user_type: 1, index_in_conv: "3", create_time: 1713421003, content_block: [{ text: "New" }] },
        { message_id: "msg-2", user_type: 2, index_in_conv: "2", create_time: 1713421002, content_block: [{ text: "Cached" }] }
      ],
      has_more: true,
      next_index: "1"
    },
    {
      messages: [{ message_id: "msg-1", user_type: 1, index_in_conv: "1", create_time: 1713421001, content_block: [{ text: "Old" }] }],
      has_more: false,
      next_index: "0"
    }
  ];
  let requestCount = 0;

  context.fetch = async () => {
    requestCount += 1;
    const page = pages.shift();
    assert.ok(page, "incremental refresh must stop once it reaches cached messages");
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          status_code: 0,
          downlink_body: {
            pull_singe_chain_downlink_body: {
              messages: page.messages,
              has_more: page.has_more,
              next_index: page.next_index,
              msg_cursor: "1",
              regen_messages: {}
            }
          }
        });
      }
    };
  };

  const conversation = await helpers.fetchAllConversationMessages(conversationId, "Incremental", "", {
    mergeBase: {
      id: conversationId,
      full: true,
      messages: [
        { id: "msg-1", role: "user", text: "Old", metadata: { index: 1, createTime: 1713421001 } },
        cachedMessage
      ]
    },
    stopWhenSeenIds: new Set(["msg-1", "msg-2"])
  });

  assert.equal(requestCount, 1);
  assert.equal(conversation.full, true);
  assert.equal(conversation.refreshedIncrementally, true);
  assert.deepEqual(Array.from(conversation.messages, (message) => message.id), ["msg-1", "msg-2", "msg-3"]);
}

async function testCurrentRefreshKeepsPartialCacheWhenApiFails() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  useImmediatePageTimers(context);

  const botId = "7296007496437661747";
  const conversationId = "38428413733584130";
  context.location.href = `https://www.doubao.com/chat/bot/chat/${botId}`;
  context.window.location = context.location;
  context.__anchors = [
    createAnchor({
      id: `conversation_${conversationId}`,
      href: `/chat/bot/chat/${botId}`,
      title: "Agent",
      className: "chat-item active-link-CytK2D e2e-test-active"
    })
  ];
  const cachedMessages = Array.from({ length: 5 }, (_, index) => ({
    id: `dom-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Cached ${index + 1}`,
    metadata: {
      index: index + 1,
      createTime: 0
    }
  }));
  const domMessages = Array.from({ length: 10 }, (_, index) => ({
    id: `dom-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `DOM message ${index + 1}`
  }));
  installFakeMessageDom(context, domMessages);

  helpers.state.cache.conversations[conversationId] = {
    id: conversationId,
    title: "Agent",
    url: context.location.href,
    source: "api",
    full: false,
    captureState: "partial",
    messages: cachedMessages
  };
  helpers.state.cache.summaries[conversationId] = {
    id: conversationId,
    title: "Agent",
    url: context.location.href,
    source: "doubao",
    messageCount: cachedMessages.length,
    messageCountSource: "loaded_partial",
    captureState: "partial"
  };

  let fetchCalls = 0;
  context.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          status_code: 1001,
          status_desc: "数据不存在"
        });
      }
    };
  };

  const conversation = await helpers.ensureCurrentConversationFresh(true);

  assert.ok(fetchCalls >= 1, "force refresh must try the API before keeping cache");
  assert.equal(conversation.id, conversationId);
  assert.equal(conversation.messages.length, 5);
  assert.equal(conversation.source, "api");
  assert.equal(conversation.full, false);
  assert.ok(conversation.messages.some((message) => message.text === "Cached 5"));
  assert.ok(!conversation.messages.some((message) => message.text === "DOM message 10"));
  const diagnostics = helpers.runtimeLogText();
  assert.match(diagnostics, /route=agent_chat/);
  assert.match(diagnostics, /conversation_load_defer_dom/);
  assert.match(diagnostics, /current_refresh_api_failed/);
  assert.match(diagnostics, /current_refresh_api_failed_keep_cache/);
  assert.doesNotMatch(diagnostics, /current_refresh_dom_fallback_saved/);
  assert.doesNotMatch(diagnostics, /dom_capture_success/);
  assert.match(diagnostics, /messageScrollCanScrollUp=true/);
  assert.match(diagnostics, /dom rows=10/);
  assert.match(diagnostics, /responseSample=.*数据不存在/);
}

async function testCurrentRefreshDoesNotMergeDomRowsAfterApiFailure() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  useImmediatePageTimers(context);

  const botId = "7242684819778502713";
  const conversationId = "38427203728538114";
  context.location.href = `https://www.doubao.com/chat/bot/chat/${botId}`;
  context.window.location = context.location;
  context.__anchors = [
    createAnchor({
      id: `conversation_${conversationId}`,
      href: `/chat/bot/chat/${botId}`,
      title: "Agent",
      className: "chat-item active-link-CytK2D e2e-test-active"
    })
  ];
  const cachedMessages = Array.from({ length: 9 }, (_, index) => ({
    id: `msg-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Cached message ${index + 1}`,
    metadata: {
      index: index + 1,
      createTime: 0
    }
  }));
  const domMessages = Array.from({ length: 9 }, (_, index) => {
    const messageNumber = index + 5;
    return {
      id: `msg-${messageNumber}`,
      role: messageNumber % 2 === 0 ? "assistant" : "user",
      text: `DOM message ${messageNumber}`
    };
  });
  installFakeMessageDom(context, domMessages);

  helpers.state.cache.conversations[conversationId] = {
    id: conversationId,
    title: "Agent",
    url: context.location.href,
    source: "dom_fallback",
    full: false,
    captureState: "partial",
    messages: cachedMessages
  };
  helpers.state.cache.summaries[conversationId] = {
    id: conversationId,
    title: "Agent",
    url: context.location.href,
    messageCount: cachedMessages.length,
    messageCountSource: "loaded_partial",
    captureState: "partial"
  };
  context.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        status_code: 1001,
        status_desc: "数据不存在"
      });
    }
  });

  await assert.rejects(
    () => helpers.ensureCurrentConversationFresh(true),
    /当前会话 缺少请求模板/
  );
  const conversation = helpers.state.cache.conversations[conversationId];
  const ids = conversation.messages.map((message) => message.id);

  assert.equal(conversation.messages.length, 9);
  assert.equal(ids[0], "msg-1");
  assert.equal(ids.at(-1), "msg-9");
  assert.ok(ids.includes("msg-2"), "older cached messages must be preserved when API fails");
  assert.ok(!ids.includes("msg-13"), "visible DOM rows must not be merged into current chat after API failure");
  const diagnostics = helpers.runtimeLogText();
  assert.match(diagnostics, /current_refresh_api_failed_no_cache/);
  assert.doesNotMatch(diagnostics, /current_refresh_dom_fallback_saved/);
}

async function testDomFallbackDoesNotShrinkLargeCacheToVisibleRows() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  useImmediatePageTimers(context);

  const conversationId = "58624263371266";
  context.location.href = `https://www.doubao.com/chat/${conversationId}`;
  context.window.location = context.location;

  const cachedMessages = Array.from({ length: 100 }, (_, index) => ({
    id: `msg-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Cached message ${index + 1}`,
    metadata: {
      index: index + 1,
      createTime: 0
    }
  }));
  installFakeMessageDom(context, [
    { id: "msg-98", role: "assistant", text: "Visible 98" },
    { id: "msg-99", role: "user", text: "Visible 99" },
    { id: "msg-100", role: "assistant", text: "Visible 100" }
  ]);

  helpers.state.cache.conversations[conversationId] = {
    id: conversationId,
    title: "Main",
    url: context.location.href,
    source: "api",
    full: false,
    captureState: "partial",
    messages: cachedMessages,
    updatedAt: new Date().toISOString()
  };

  context.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        status_code: 1001,
        status_desc: "调用下游服务器失败"
      });
    }
  });

  const conversation = await helpers.ensureCurrentConversationFresh(true);

  assert.equal(conversation.messages.length, 100);
  assert.equal(helpers.state.cache.conversations[conversationId].messages.length, 100);
  assert.match(helpers.runtimeLogText(), /conversation_load_recover_full|current_refresh_api_failed_keep_cache/);
  assert.match(helpers.runtimeLogText(), /visibleDomIds=msg-98,msg-99,msg-100/);
  assert.doesNotMatch(helpers.runtimeLogText(), /current_refresh_dom_fallback_saved/);
}

async function testCurrentRefreshKeepsStaleFullCacheWhenApiFails() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  useImmediatePageTimers(context);

  const botId = "7242684819778502713";
  const conversationId = "38427203728538114";
  context.location.href = `https://www.doubao.com/chat/bot/chat/${botId}`;
  context.window.location = context.location;
  context.__anchors = [
    createAnchor({
      id: `conversation_${conversationId}`,
      href: `/chat/bot/chat/${botId}`,
      title: "Agent",
      className: "chat-item active-link-CytK2D e2e-test-active"
    })
  ];
  const cachedMessages = Array.from({ length: 9 }, (_, index) => ({
    id: `msg-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Cached message ${index + 1}`,
    metadata: {
      index: index + 1,
      createTime: 0
    }
  }));
  const domMessages = Array.from({ length: 9 }, (_, index) => {
    const messageNumber = index + 5;
    return {
      id: `msg-${messageNumber}`,
      role: messageNumber % 2 === 0 ? "assistant" : "user",
      text: `DOM message ${messageNumber}`
    };
  });
  installFakeMessageDom(context, domMessages);

  helpers.state.cache.conversations[conversationId] = {
    id: conversationId,
    title: "Agent",
    url: context.location.href,
    source: "api",
    full: true,
    captureState: "full",
    messages: cachedMessages,
    updatedAt: new Date().toISOString()
  };
  helpers.state.cache.summaries[conversationId] = {
    id: conversationId,
    title: "Agent",
    url: context.location.href,
    messageCount: 9,
    messageCountSource: "loaded_full",
    captureState: "full"
  };
  context.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        status_code: 1001,
        status_desc: "数据不存在"
      });
    }
  });

  const conversation = await helpers.ensureCurrentConversationFresh(true);
  const ids = conversation.messages.map((message) => message.id);

  assert.equal(conversation.messages.length, 9);
  assert.ok(ids.includes("msg-1"), "old full cache messages must not be dropped");
  assert.ok(!ids.includes("msg-13"), "visible DOM rows must not be merged when API fails");
  const diagnostics = helpers.runtimeLogText();
  assert.match(diagnostics, /conversation_load_recover_skip_stale/);
  assert.match(diagnostics, /current_refresh_api_failed_keep_cache/);
  assert.doesNotMatch(diagnostics, /current_refresh_dom_fallback_saved/);
}

async function testSaveCacheCompactsOldConversationsAfterQuotaError() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  context.location.href = "https://www.doubao.com/chat/100001";
  context.window.location = context.location;

  helpers.state.cache.conversations["100001"] = {
    id: "100001",
    title: "Current",
    url: context.location.href,
    source: "dom",
    full: false,
    captureState: "partial",
    messages: Array.from({ length: 12 }, (_, index) => ({
      id: `current-${index + 1}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `Current message ${index + 1}`,
      metadata: { index: index + 1 }
    })),
    updatedAt: "2026-06-01T12:00:00.000Z"
  };
  for (let index = 0; index < 40; index += 1) {
    const id = String(200000 + index);
    helpers.state.cache.conversations[id] = {
      id,
      title: `Old ${index}`,
      url: `https://www.doubao.com/chat/${id}`,
      source: "api",
      full: false,
      captureState: "partial",
      messages: [{
        id: `old-${index}`,
        role: "assistant",
        text: "x".repeat(12000),
        metadata: { index: 1 }
      }],
      updatedAt: new Date(Date.UTC(2026, 4, 1, 0, index)).toISOString()
    };
    helpers.state.cache.summaries[id] = {
      id,
      title: `Old ${index}`,
      url: `https://www.doubao.com/chat/${id}`,
      messageCount: 1,
      captureState: "partial"
    };
  }

  const attempts = [];
  let savedCache = null;
  context.chrome.storage.local.set = async (payload) => {
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    attempts.push(bytes);
    if (payload["doubao-export-shell-v3"] && bytes > 90000) {
      throw new Error("Resource::kQuotaBytes quota exceeded");
    }
    if (payload["doubao-export-shell-v3"]) savedCache = payload["doubao-export-shell-v3"];
  };

  const saved = await helpers.saveCache();

  assert.equal(saved, true);
  assert.ok(attempts.length > 1, "saveCache must retry with a compacted cache after quota errors");
  assert.ok(savedCache.conversations["100001"], "current conversation must survive cache compaction");
  assert.ok(Object.keys(savedCache.conversations).length < 40, "old conversations should be pruned to fit storage");
  assert.equal(savedCache.conversations["100001"].messages.length, 12);
  assert.match(helpers.runtimeLogText(), /cache_storage_compacted/);
}

async function testSaveCacheTrimsHugeConversationOnlyInStorage() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  context.location.href = "https://www.doubao.com/chat/100001";
  context.window.location = context.location;

  const messages = Array.from({ length: 1505 }, (_, index) => ({
    id: `msg-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Message ${index + 1}`,
    metadata: { index: index + 1 }
  }));
  helpers.state.cache.conversations["100001"] = {
    id: "100001",
    title: "Huge",
    url: context.location.href,
    source: "api",
    full: true,
    captureState: "full",
    messages,
    updatedAt: "2026-07-04T00:00:00.000Z"
  };
  helpers.state.cache.summaries["100001"] = {
    id: "100001",
    title: "Huge",
    messageCount: messages.length,
    messageCountSource: "loaded_full",
    captureState: "full"
  };

  let savedCache = null;
  context.chrome.storage.local.set = async (payload) => {
    if (payload["doubao-export-shell-v3"]) savedCache = payload["doubao-export-shell-v3"];
  };

  assert.equal(await helpers.saveCache(), true);
  assert.equal(helpers.state.cache.conversations["100001"].messages.length, 1505);
  assert.equal(savedCache.conversations["100001"].messages.length, 1200);
  assert.equal(savedCache.conversations["100001"].storageTrimmed, true);
  assert.equal(savedCache.summaries["100001"].captureState, "partial");
  assert.equal(savedCache.summaries["100001"].messageCountSource, "loaded_partial");
}

async function testExecuteJsonRequestTimesOut() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  let capturedSignal = null;
  let timeoutCallback = null;
  context.window.setTimeout = (callback) => {
    timeoutCallback = callback;
    return 1;
  };
  context.window.clearTimeout = () => {};
  context.fetch = async (url, options = {}) => {
    capturedSignal = options.signal;
    timeoutCallback();
    throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  };

  await assert.rejects(
    () => helpers.executeJsonRequest({
      kind: "single",
      url: "https://www.doubao.com/im/chain/single",
      method: "POST",
      headers: {},
      bodyText: "{}"
    }),
    (error) => {
      assert.equal(error.category, "timeout");
      assert.ok(capturedSignal, "executeJsonRequest must pass AbortController signal to fetch");
      return true;
    }
  );
}

function testSidebarSummaryFiltering() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  context.__anchors = [
    createAnchor({ href: "/chat/123", title: " Project A " }),
    createAnchor({ href: "/chat/abc", title: "Ignore me" }),
    createAnchor({ href: "/chat/456", title: "New Chat" }),
    createAnchor({ href: "/chat/123", title: "Project A duplicate" }),
    createAnchor({ href: "/chat/789", title: "Outside sidebar", isSidebar: false })
  ];

  const summaries = helpers.collectSidebarSummaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, "123");
  assert.equal(summaries[0].title, "Project A");
}

function testRemoteCountAndProgressIgnoreIndexLikeCounts() {
  const { helpers } = loadHelpers();
  resetState(helpers);

  assert.equal(helpers.remoteMessageCountFromConversationItem({ message_count: 26000 }), 26000);
  assert.equal(helpers.rawRemoteMessageCountFromConversationItem({ message_count: 227355 }), 227355);
  assert.equal(helpers.remoteMessageCountFromConversationItem({ message_count: 227355 }), 0);

  helpers.state.cache.summaries["100"] = {
    id: "100",
    messageCount: 50,
    messageCountSource: "remote"
  };
  helpers.setConversationLoadFeedback({
    page: 30,
    loaded: 1500,
    maxPages: 6000,
    pageMessages: 50,
    hasMore: true
  }, "current", "refresh");

  assert.match(helpers.state.exportFeedback.message, /1500 条/);
  assert.doesNotMatch(helpers.state.exportFeedback.message, /共 50 条/);
  assert.match(helpers.runtimeLogText(), /expected=0/);

  helpers.state.cache.summaries["100"] = {
    id: "100",
    messageCount: 0,
    messageCountRaw: 227355,
    messageCountSource: "remote_index_like"
  };
}

function testPanelHtmlMatchesLatestUiContract() {
  const { helpers } = loadHelpers();
  resetState(helpers);
  helpers.state.open = true;
  helpers.state.tab = "current";
  let html = helpers.panelHtml();

  assert.match(html, /dbx-dialog/);
  assertWindowControlsContract(html, "content panelHtml");
  assertMinimalShellContract(html, "content panelHtml");
  assertCurrentPanelContract(html, "content panelHtml");
  assertCompactCurrentLayoutContract(html, "content panelHtml");
  assertAboutDrawerContract(html, "content panelHtml");
  assertFooterFeedbackContract(html, "content panelHtml");
  assert.match(html, /导出当前(会话|对话)/);
  assert.match(html, /data-image-mode-toggle/, "content panelHtml must show the image toggle for Markdown export");

  helpers.state.format = "txt";
  html = helpers.panelHtml();
  assert.match(html, /data-format="txt"[\s\S]*?is-active/, "content panelHtml must select TXT export format");
  assert.doesNotMatch(html, /data-image-mode-toggle/, "content panelHtml must hide the image toggle for TXT export");
  helpers.state.format = "md";

  helpers.state.diagnostics.current = true;
  helpers.state.runtime.logs = [{
    at: "2026-05-10T05:00:00.000Z",
    type: "refresh_progress",
    message: "对话分页加载中",
    details: {
      page: 10,
      loaded: 1000
    }
  }];
  html = helpers.panelHtml();

  assert.match(html, /运行日志/, "content panelHtml must expose runtime logs in diagnostics");
  assert.match(html, /data-runtime-log-copy="true"/, "content panelHtml must expose a copy-log button");
  assert.match(html, /refresh_progress/, "content panelHtml must render recent runtime log entries");
}

async function testRuntimeLogCopyButtonCopiesDiagnostics() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  let copiedText = "";
  context.navigator = {
    clipboard: {
      async writeText(value) {
        copiedText = String(value);
      }
    }
  };
  context.document.getElementById = () => null;
  context.document.body.appendChild = () => {};

  helpers.state.runtime.logs = [{
    at: "2026-05-10T05:00:00.000Z",
    type: "timeout",
    message: "当前会话 请求超时",
    details: {
      page: 42,
      loaded: 4200
    }
  }];

  const overlay = {
    className: "",
    onclick: null,
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const copyButton = {
    getAttribute(name) {
      return name === "data-runtime-log-copy" ? "true" : "";
    }
  };

  helpers.bindPanel(overlay);
  await overlay.onclick({
    target: {
      closest(selector) {
        return selector.includes("[data-runtime-log-copy]") ? copyButton : null;
      }
    }
  });

  assert.match(copiedText, /timeout/);
  assert.match(copiedText, /loaded=4200/);
  assert.equal(helpers.runtimeLogText(), copiedText);
}

function testSplitToggleClickUpdatesState() {
  const { helpers } = loadHelpers();
  const overlay = {
    className: "",
    onclick: null,
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };

  const splitButton = {
    getAttribute(name) {
      return name === "data-split-mode-toggle" ? "true" : "";
    }
  };

  helpers.state.splitMode = "off";
  helpers.bindPanel(overlay);
  assert.equal(typeof overlay.onclick, "function", "bindPanel must register a click handler");

  overlay.onclick({
    target: {
      closest(selector) {
        return selector.includes("[data-split-mode-toggle]") ? splitButton : null;
      }
    }
  });

  assert.equal(helpers.state.splitMode, "on");
}

function testMarkdownRenderStripsImagesAndFiltersStructuredBlocksByDefault() {
  const { helpers } = loadHelpers();
  const markdown = helpers.renderMarkdown({
    id: "conversation-1",
    title: "测试会话",
    source: "api",
    messages: [
      {
        role: "user",
        parts: [
          { type: "text", text: "这是谁" },
          { type: "structured", label: "10052", preview: "{\"foo\":1}" }
        ],
        attachments: [
          { name: "image.png", url: "https://example.com/image.png" }
        ]
      },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "这是罗振宇。" }
        ]
      }
    ]
  });

  assert.doesNotMatch(markdown, /Structured Block:/);
  assert.doesNotMatch(markdown, /Attachments:/);
  assert.match(markdown, /## 豆包/);
  assert.doesNotMatch(markdown, /image\.png/);
  assert.match(markdown, /这是罗振宇。/);
}

function testMarkdownRenderSkipsImageOnlyUserMessageWhenStrippingImages() {
  const { helpers } = loadHelpers();
  const markdown = helpers.renderMarkdown({
    id: "conversation-image-only",
    title: "图片消息测试",
    source: "api",
    messages: [
      {
        role: "user",
        attachments: [
          { name: "shoulder.png", url: "https://example.com/shoulder.png", type: "image" }
        ]
      },
      {
        role: "user",
        parts: [
          { type: "text", text: "这个力矩该怎么算" }
        ]
      }
    ]
  });

  assert.match(markdown, /## 用户\s+这个力矩该怎么算/);
  assert.equal((markdown.match(/## 用户/g) || []).length, 1);
  assert.doesNotMatch(markdown, /shoulder\.png/);
}

function testMarkdownRenderEmbedsImagesWhenAssetsProvided() {
  const { helpers } = loadHelpers();
  const markdown = helpers.renderMarkdown({
    id: "conversation-image-embed",
    title: "图片嵌入测试",
    source: "api",
    messages: [
      {
        role: "user",
        attachments: [
          { name: "shoulder.png", url: "https://example.com/shoulder.png", type: "image" }
        ]
      }
    ]
  }, {
    imageMode: "embed",
    embeddedAssets: new Map([
      ["https://example.com/shoulder.png", "data:image/png;base64,ZmFrZQ=="]
    ])
  });

  assert.match(markdown, /!\[shoulder\.png\]\(data:image\/png;base64,ZmFrZQ==\)/);
}

function testMarkdownRenderCollapsesImageVariantsLikeWorker() {
  const conversation = {
    id: "conversation-image-variants",
    title: "图片变体测试",
    source: "api",
    messages: [
      {
        role: "user",
        attachments: [
          {
            name: "thumb.png",
            url: "https://example.com/thumb.png",
            type: "image",
            imageVariant: "image_thumb",
            imageGroupKey: "creation:creation-a"
          },
          {
            name: "preview.png",
            url: "https://example.com/preview.png",
            type: "image",
            imageVariant: "image_preview",
            imageGroupKey: "creation:creation-a"
          },
          {
            name: "original.png",
            url: "https://example.com/original.png",
            type: "image",
            imageVariant: "image_ori",
            imageGroupKey: "creation:creation-a"
          }
        ]
      }
    ]
  };
  const { helpers } = loadHelpers();
  const workerHelpers = loadExportWorkerHelpers();
  const options = { imageMode: "embed" };
  const contentMarkdown = helpers.renderMarkdown(conversation, options);
  const workerMarkdown = workerHelpers.renderMarkdown(conversation, options);

  assert.match(contentMarkdown, /original\.png/);
  assert.doesNotMatch(contentMarkdown, /thumb\.png|preview\.png/);
  assert.equal((contentMarkdown.match(/!\[/g) || []).length, 1);
  assert.match(workerMarkdown, /original\.png/);
  assert.doesNotMatch(workerMarkdown, /thumb\.png|preview\.png/);
  assert.equal((workerMarkdown.match(/!\[/g) || []).length, 1);
}

function testMarkdownRenderCollapsesLegacyImageVariantsByResourcePath() {
  const conversation = {
    id: "conversation-legacy-image-variants",
    title: "旧图片变体测试",
    source: "api",
    messages: [
      {
        role: "user",
        attachments: [
          {
            name: "legacy-thumb.png",
            url: "https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/legacy.png~tplv-a9rns2rl98-image.png?x-signature=thumb",
            type: "image"
          },
          {
            name: "legacy-origin.png",
            url: "https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/legacy.png~tplv-a9rns2rl98-image.png?x-signature=origin",
            type: "image"
          },
          {
            name: "legacy-preview.png",
            url: "https://p26-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/legacy.png~tplv-a9rns2rl98-image.png?x-signature=preview",
            type: "image"
          }
        ]
      }
    ]
  };
  const { helpers } = loadHelpers();
  const workerHelpers = loadExportWorkerHelpers();
  const options = { imageMode: "embed" };
  const contentMarkdown = helpers.renderMarkdown(conversation, options);
  const workerMarkdown = workerHelpers.renderMarkdown(conversation, options);

  assert.equal((contentMarkdown.match(/!\[/g) || []).length, 1);
  assert.equal((workerMarkdown.match(/!\[/g) || []).length, 1);
}

function testMarkdownRenderCollapsesDoubaoPreviewAndOriginalImageUrls() {
  const previewUrl = "https://p9-flow-imagex-sign.byteimg.com/ocean-cloud-tos/83a27a22e56b46eebee3dc7815104f54preview.jpeg~tplv-a9rns2rl98-downsize.png?rk3s=49177a0b&x-expires=2061543347&x-signature=preview";
  const originalUrl = "https://p3-flow-imagex-sign.byteimg.com/ocean-cloud-tos/83a27a22e56b46eebee3dc7815104f54.jpeg~tplv-a9rns2rl98-image.png?rk3s=49177a0b&x-expires=2061543347&x-signature=original";
  const conversation = {
    id: "conversation-doubao-preview-original",
    title: "Doubao preview original variants",
    source: "api",
    messages: [
      {
        role: "assistant",
        attachments: [
          { name: "generated-preview.png", url: previewUrl, type: "image" },
          { name: "generated-original.png", url: originalUrl, type: "image" }
        ]
      }
    ]
  };
  const { helpers } = loadHelpers();
  const workerHelpers = loadExportWorkerHelpers();
  const options = { imageMode: "embed" };
  const contentMarkdown = helpers.renderMarkdown(conversation, options);
  const workerMarkdown = workerHelpers.renderMarkdown(conversation, options);

  assert.equal((contentMarkdown.match(/!\[/g) || []).length, 1);
  assert.equal((workerMarkdown.match(/!\[/g) || []).length, 1);
  assert.match(contentMarkdown, /generated-original\.png/);
  assert.match(workerMarkdown, /generated-original\.png/);
  assert.doesNotMatch(contentMarkdown, /generated-preview\.png/);
  assert.doesNotMatch(workerMarkdown, /generated-preview\.png/);
}

function testMarkdownRenderAppendsMessageTimestampsWhenEnabled() {
  const { helpers } = loadHelpers();
  const markdownWithTimestamps = helpers.renderMarkdown({
    id: "conversation-timestamp",
    title: "时间戳测试",
    source: "api",
    messages: [
      {
        role: "user",
        parts: [
          { type: "text", text: "这条消息要带时间" }
        ],
        metadata: {
          createTime: 1713421385
        }
      }
    ]
  }, {
    timestampMode: "show"
  });
  const markdownWithoutTimestamps = helpers.renderMarkdown({
    id: "conversation-timestamp",
    title: "时间戳测试",
    source: "api",
    messages: [
      {
        role: "user",
        parts: [
          { type: "text", text: "这条消息要带时间" }
        ],
        metadata: {
          createTime: 1713421385
        }
      }
    ]
  });

  assert.match(markdownWithTimestamps, /## 用户 · \d{4}年\d{2}月\d{2}日 \d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(markdownWithoutTimestamps, /## 用户 · \d{4}年/);
}

function testDateRangeFilterIncludesStartAndWholeEndDate() {
  const { helpers } = loadHelpers();
  const messages = [
    {
      id: "before",
      metadata: { createTime: new Date(2026, 3, 30, 23, 59, 59).getTime() }
    },
    {
      id: "start",
      metadata: { createTime: new Date(2026, 4, 1, 0, 0, 0).getTime() }
    },
    {
      id: "end",
      metadata: { createTime: new Date(2026, 5, 30, 23, 59, 59).getTime() }
    },
    {
      id: "after",
      metadata: { createTime: new Date(2026, 6, 1, 0, 0, 0).getTime() }
    }
  ];

  const filtered = helpers.filterMessagesByDateRange(messages, {
    enabled: true,
    startDate: "2026-05-01",
    endDate: "2026-06-30"
  });

  assert.deepEqual(filtered.map((message) => message.id), ["start", "end"]);
  assert.equal(helpers.dateRangeFileToken({
    enabled: true,
    startDate: "2026-05-01",
    endDate: "2026-06-30"
  }), "2026-05-01_to_2026-06-30");
}

function testDateRangeFilterSkipsMessagesWithoutTimestamps() {
  const { helpers } = loadHelpers();
  const messages = [
    { id: "missing", parts: [{ type: "text", text: "No timestamp" }] },
    {
      id: "inside",
      parts: [{ type: "text", text: "Inside" }],
      metadata: { createTime: new Date(2026, 4, 10, 12, 0, 0).getTime() }
    }
  ];

  const filtered = helpers.filterMessagesByDateRange(messages, {
    enabled: true,
    startDate: "2026-05-01",
    endDate: "2026-05-31"
  });

  assert.deepEqual(filtered.map((message) => message.id), ["inside"]);
}

function testCurrentExportCanReuseFullCache() {
  const { helpers, context } = loadHelpers();
  resetState(helpers);
  helpers.state.cache.summaries["100"] = {
    id: "100",
    messageCount: 138534,
    messageCountSource: "remote"
  };
  helpers.state.cache.conversations["100"] = {
    id: "100",
    title: "Cached conversation",
    full: true,
    updatedAt: "2026-05-01T00:00:00.000Z",
    messages: [
      {
        id: "cached-message",
        metadata: {
          createTime: new Date(2026, 4, 10, 12, 0, 0).getTime()
        }
      }
    ]
  };

  const cached = helpers.cachedCurrentConversationForExport({
    enabled: true,
    startDate: "2026-05-01",
    endDate: "2026-05-11"
  });

  assert.equal(cached.id, "100");
  assert.equal(helpers.cachedCurrentConversationForExport({ enabled: false }).id, "100");

  installFakeMessageDom(context, [{
    id: "visible-regenerated-message",
    role: "assistant",
    text: "Visible regenerated reply"
  }]);
  assert.equal(
    helpers.cachedCurrentConversationForExport({ enabled: false }),
    null,
    "current export must refresh when full cache misses the visible regenerated message"
  );

  helpers.state.cache.conversations["100"].full = false;
  assert.equal(helpers.cachedCurrentConversationForExport({
    enabled: true,
    startDate: "2026-05-01",
    endDate: "2026-05-11"
  }), null);
}

async function testFreeReleaseAllowsExportWithoutActivation() {
  const { helpers } = loadHelpers();
  assert.equal(await helpers.requireLicenseForAccess("current", "refresh"), true);
  assert.equal(await helpers.requireLicenseForExport("current"), true);
}

async function testBuildMarkdownExportTextEmbedsImages() {
  const { helpers, context } = loadHelpers();
  const requests = [];
  context.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return String(name || "").toLowerCase() === "content-type" ? "image/png" : "";
        }
      },
      async blob() {
        return new Blob([Uint8Array.from([1, 2, 3, 4])], { type: "image/png" });
      }
    };
  };

  const markdown = await helpers.buildMarkdownExportText({
    id: "conversation-image-fetch",
    title: "图片抓取嵌入测试",
    source: "api",
    messages: [
      {
        role: "user",
        attachments: [
          { name: "shoulder.png", url: "https://example.com/shoulder.png", type: "image" }
        ]
      }
    ]
  }, {
    imageMode: "embed"
  });

  assert.match(markdown, /!\[shoulder\.png\]\(data:image\/png;base64,/);
  assert.equal(requests[0].options.credentials, "include");
}

async function testBuildMarkdownExportTextEmbedsSignedByteimgImageWithoutCredentials() {
  const { helpers, context } = loadHelpers();
  const requests = [];
  context.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return String(name || "").toLowerCase() === "content-type" ? "application/octet-stream" : "";
        }
      },
      async blob() {
        return new Blob([Uint8Array.from([255, 216, 255, 217])], { type: "" });
      }
    };
  };
  const imageUrl = "https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/7da697c65674445fb31d663ffc854485~tplv-a9rns2rl98-image.image?x-expires=1800000000&x-signature=test";

  const markdown = await helpers.buildMarkdownExportText({
    id: "conversation-signed-image",
    title: "Signed image embed",
    source: "api",
    messages: [
      {
        role: "user",
        attachments: [
          { name: "signed.image", url: imageUrl, type: "image" }
        ]
      }
    ]
  }, {
    imageMode: "embed"
  });

  assert.equal(requests[0].options.credentials, "omit");
  assert.match(markdown, /!\[signed\.image\]\(data:image\/jpeg;base64,/);
  assert.doesNotMatch(markdown, /flow-imagex-sign\.byteimg\.com/);
}

async function testBuildTextExportTextStripsImages() {
  const { helpers } = loadHelpers();

  const text = await helpers.buildTextExportText({
    id: "conversation-text-export",
    title: "纯文本导出测试",
    source: "api",
    messages: [
      {
        role: "user",
        attachments: [
          { name: "image-only.png", url: "https://example.com/image-only.png", type: "image" }
        ]
      },
      {
        role: "user",
        parts: [{ type: "text", text: "保留这条文字" }],
        attachments: [
          { name: "mixed.png", url: "https://example.com/mixed.png", type: "image" }
        ]
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "豆包回复" }]
      }
    ]
  }, {
    timestampMode: "hide",
    imageMode: "embed"
  });

  assert.match(text, /标题：纯文本导出测试/);
  assert.match(text, /消息数：2/);
  assert.match(text, /保留这条文字/);
  assert.match(text, /豆包回复/);
  assert.doesNotMatch(text, /!\[|image-only\.png|mixed\.png|https:\/\/example\.com/);
}

function testMarkdownRenderDedupesRepeatedAssistantText() {
  const { helpers } = loadHelpers();
  const markdown = helpers.renderMarkdown({
    id: "conversation-2",
    title: "重复消息测试",
    source: "api",
    messages: [
      {
        role: "assistant",
        parts: [
          {
            type: "text",
            text: [
              "图中人物是**罗振宇**，他是知名自媒体《罗辑思维》的主讲人，也是得到App的创始人。",
              "他因开创知识跨年演讲模式被大众熟知，每年年底的时间的朋友跨年演讲是其标志性活动。",
              "找到 3 张图片参考",
              "图中人物是**罗振宇**，他是知名自媒体《罗辑思维》的主讲人，也是得到App的创始人。",
              "他因开创知识跨年演讲模式被大众熟知，每年年底的时间的朋友跨年演讲是其标志性活动。"
            ].join("\n\n")
          },
          {
            type: "text",
            text: [
              "找到 3 张图片参考",
              "图中人物是**罗振宇**，他是知名自媒体《罗辑思维》的主讲人，也是得到App的创始人。"
            ].join("\n\n")
          }
        ]
      }
    ]
  });

  assert.equal((markdown.match(/图中人物是\*\*罗振宇\*\*，他是知名自媒体《罗辑思维》的主讲人，也是得到App的创始人。/g) || []).length, 1);
  assert.equal((markdown.match(/他因开创知识跨年演讲模式被大众熟知，每年年底的时间的朋友跨年演讲是其标志性活动。/g) || []).length, 1);
  assert.equal((markdown.match(/找到 3 张图片参考/g) || []).length, 1);
}

function testMarkdownRenderNormalizesIndentedMathInsideLists() {
  const { helpers } = loadHelpers();
  const markdown = helpers.renderMarkdown({
    id: "conversation-math",
    title: "公式导出测试",
    source: "api",
    messages: [
      {
        role: "assistant",
        parts: [
          {
            type: "text",
            text: [
              "### 一、核心公式",
              "力矩（扭矩）的通用计算公式：",
              "$$\\boldsymbol{M = F \\times L}$$",
              "1.  平衡关系：忽略轴承摩擦力的理想状态下，装置静止时绕转轴的合力矩为0，即",
              "    $$F \\times L_F = 2T \\times L_T$$",
              "2.  计算力矩：",
              "    $$M_F = F \\times L_F$$"
            ].join("\n")
          }
        ]
      }
    ]
  });

  assert.match(markdown, /\$\$\\boldsymbol\{M = F \\times L\}\$\$/);
  assert.match(markdown, /平衡关系：忽略轴承摩擦力的理想状态下，装置静止时绕转轴的合力矩为0，即 \$F \\times L_F = 2T \\times L_T\$/);
  assert.match(markdown, /2\.  计算力矩： \$M_F = F \\times L_F\$/);
  assert.doesNotMatch(markdown, /\n\s+\$\$F \\times L_F = 2T \\times L_T\$\$/);
}

function testMessageNormalizationDedupesRepeatedParagraphs() {
  const { helpers } = loadHelpers();
  const payload = {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            message_id: "msg-repeat-1",
            role: "assistant",
            index_in_conv: 1,
            create_time: 201,
            content_block: [
              {
                text: [
                  "图中人物是**罗振宇**，他是知名自媒体《罗辑思维》的主讲人，也是得到App的创始人。",
                  "他因开创知识跨年演讲模式被大众熟知，每年年底的时间的朋友跨年演讲是其标志性活动。",
                  "找到 3 张图片参考",
                  "图中人物是**罗振宇**，他是知名自媒体《罗辑思维》的主讲人，也是得到App的创始人。",
                  "他因开创知识跨年演讲模式被大众熟知，每年年底的时间的朋友跨年演讲是其标志性活动。"
                ].join("\n\n")
              }
            ],
            content: JSON.stringify({
              text: [
                "找到 3 张图片参考",
                "图中人物是**罗振宇**，他是知名自媒体《罗辑思维》的主讲人，也是得到App的创始人。"
              ].join("\n\n")
            })
          }
        ]
      }
    }
  };

  const messages = helpers.parseSingleChainMessages(payload);
  assert.equal(messages.length, 1);
  assert.equal((messages[0].text.match(/图中人物是\*\*罗振宇\*\*，他是知名自媒体《罗辑思维》的主讲人，也是得到App的创始人。/g) || []).length, 1);
  assert.equal((messages[0].text.match(/他因开创知识跨年演讲模式被大众熟知，每年年底的时间的朋友跨年演讲是其标志性活动。/g) || []).length, 1);
  assert.equal((messages[0].text.match(/找到 3 张图片参考/g) || []).length, 1);
}

async function testSplitConversationZipBuildsIndexAndParts() {
  const { helpers, context } = loadHelpers();

  class FakeZip {
    constructor() {
      this.files = [];
      this.options = null;
      context.__zipInstances.push(this);
    }

    file(name, content) {
      this.files.push({ name, content });
    }

    async generateAsync(options) {
      this.options = options;
      return { type: "fake-zip-blob", files: this.files, options };
    }
  }

  context.window.JSZip = FakeZip;

  const conversation = {
    id: "conversation-long",
    title: "长对话测试",
    messages: Array.from({ length: 1001 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      parts: [
        { type: "text", text: `消息 ${index + 1}` }
      ]
    }))
  };

  const result = await helpers.buildSplitConversationZip(conversation, "md", {
    timestampMode: "hide"
  });

  assert.equal(context.__zipInstances.length, 1);
  assert.equal(result.options.type, "blob");
  assert.equal(result.options.compression, "DEFLATE");

  const fileNames = context.__zipInstances[0].files.map((entry) => entry.name);
  assert.deepEqual(
    fileNames,
    ["part-001.md", "part-002.md", "part-003.md", "manifest.json", "index.md"],
    "Split export must include three parts plus manifest and index"
  );

  const indexEntry = context.__zipInstances[0].files.find((entry) => entry.name === "index.md");
  assert.ok(indexEntry, "Split export must write an index markdown file");
  assert.match(indexEntry.content, /# 长对话测试 · 分片索引/);
  assert.match(indexEntry.content, /- 分片数：3/);
  assert.match(indexEntry.content, /\[Part 1（消息 #1-#500，共 500 条）\]\(part-001\.md\)/);

  const manifestEntry = context.__zipInstances[0].files.find((entry) => entry.name === "manifest.json");
  assert.ok(manifestEntry, "Split export must write a manifest file");
  const manifest = JSON.parse(manifestEntry.content);
  assert.equal(manifest.totalMessages, 1001);
  assert.equal(manifest.totalParts, 3);
  assert.equal(manifest.messagesPerPart, 500);

  const partThreeEntry = context.__zipInstances[0].files.find((entry) => entry.name === "part-003.md");
  assert.ok(partThreeEntry, "Split export must write the final part file");
  assert.match(partThreeEntry.content, /# 长对话测试 · Part 3\/3/);
  assert.match(partThreeEntry.content, /消息 1001/);
}

async function testSplitConversationManifestCountsOnlyExportedMarkdownMessages() {
  const { helpers, context } = loadHelpers();

  class FakeZip {
    constructor() {
      this.files = [];
      this.options = null;
      context.__zipInstances.push(this);
    }

    file(name, content) {
      this.files.push({ name, content });
    }

    async generateAsync(options) {
      this.options = options;
      return { type: "fake-zip-blob", files: this.files, options };
    }
  }

  context.window.JSZip = FakeZip;

  await helpers.buildSplitConversationZip(
    {
      id: "conversation-images",
      title: "图片过滤测试",
      source: "api",
      messages: [
        {
          role: "user",
          attachments: [
            { name: "image-only.png", url: "https://example.com/image-only.png", type: "image" }
          ]
        },
        {
          role: "user",
          parts: [{ type: "text", text: "保留这条文字" }]
        },
        {
          role: "assistant",
          parts: [{ type: "text", text: "这条也保留" }],
          attachments: [
            { name: "answer.png", url: "https://example.com/answer.png", type: "image" }
          ]
        }
      ]
    },
    "md",
    {
      imageMode: "strip",
      timestampMode: "hide"
    }
  );

  const files = context.__zipInstances[0].files;
  const manifest = JSON.parse(files.find((entry) => entry.name === "manifest.json").content);
  const part = files.find((entry) => entry.name === "part-001.md");
  assert.equal(manifest.totalMessages, 2);
  assert.equal(manifest.parts[0].count, 2);
  assert.equal((part.content.match(/^## /gm) || []).length, 2);
  assert.doesNotMatch(part.content, /image-only\.png|answer\.png/);
}

async function testTextSplitConversationZipUsesTxtParts() {
  const { helpers, context } = loadHelpers();

  class FakeZip {
    constructor() {
      this.files = [];
      this.options = null;
      context.__zipInstances.push(this);
    }

    file(name, content) {
      this.files.push({ name, content });
    }

    async generateAsync(options) {
      this.options = options;
      return { type: "fake-zip-blob", files: this.files, options };
    }
  }

  context.window.JSZip = FakeZip;

  await helpers.buildSplitConversationZip(
    {
      id: "conversation-txt-long",
      title: "TXT 长对话",
      source: "api",
      messages: [
        {
          role: "user",
          attachments: [
            { name: "image-only.png", url: "https://example.com/image-only.png", type: "image" }
          ]
        },
        ...Array.from({ length: 601 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          parts: [
            { type: "text", text: `纯文本消息 ${index + 1}` }
          ]
        }))
      ]
    },
    "txt",
    {
      imageMode: "embed",
      timestampMode: "hide"
    }
  );

  const files = context.__zipInstances[0].files;
  const names = files.map((entry) => entry.name);
  assert.deepEqual(names, ["part-001.txt", "part-002.txt", "manifest.json", "index.txt"]);
  const manifest = JSON.parse(files.find((entry) => entry.name === "manifest.json").content);
  assert.equal(manifest.format, "txt");
  assert.equal(manifest.totalMessages, 601);
  assert.equal(manifest.totalParts, 2);
  const part = files.find((entry) => entry.name === "part-001.txt");
  assert.match(part.content, /纯文本消息 1/);
  assert.doesNotMatch(part.content, /!\[|image-only\.png|https:\/\/example\.com/);
}

function testConversationWithEmbeddedAssetsRewritesWorkerPayloadUrls() {
  const { helpers } = loadHelpers();
  const rewritten = helpers.conversationWithEmbeddedAssets({
    messages: [
      {
        attachments: [
          { url: "https://example.com/image.png", type: "image" }
        ],
        parts: [
          { type: "image", url: "https://example.com/image.png" }
        ]
      }
    ]
  }, new Map([
    ["https://example.com/image.png", "data:image/png;base64,ZmFrZQ=="]
  ]));

  assert.equal(rewritten.messages[0].attachments[0].url, "data:image/png;base64,ZmFrZQ==");
  assert.equal(rewritten.messages[0].parts[0].url, "data:image/png;base64,ZmFrZQ==");
  assert.equal(rewritten.messages[0].attachments[0].sourceUrl, "https://example.com/image.png");
  assert.equal(rewritten.messages[0].parts[0].sourceUrl, "https://example.com/image.png");
}

function testEmbeddedDoubaoImageVariantsKeepDedupeKeys() {
  const { helpers } = loadHelpers();
  const previewUrl = "https://p9-flow-imagex-sign.byteimg.com/ocean-cloud-tos/83a27a22e56b46eebee3dc7815104f54preview.jpeg~tplv-a9rns2rl98-downsize.png?x-signature=preview";
  const originalUrl = "https://p3-flow-imagex-sign.byteimg.com/ocean-cloud-tos/83a27a22e56b46eebee3dc7815104f54.jpeg~tplv-a9rns2rl98-image.png?x-signature=original";
  const rewritten = helpers.conversationWithEmbeddedAssets({
    messages: [
      {
        role: "assistant",
        attachments: [
          { name: "generated-preview.png", url: previewUrl, type: "image" },
          { name: "generated-original.png", url: originalUrl, type: "image" }
        ]
      }
    ]
  }, new Map([
    [previewUrl, "data:image/jpeg;base64,cHJldmlldw=="],
    [originalUrl, "data:image/jpeg;base64,b3JpZ2luYWw="]
  ]));
  const markdown = helpers.renderMarkdown(rewritten, { imageMode: "embed" });

  assert.equal(rewritten.messages[0].attachments[0].sourceUrl, previewUrl);
  assert.equal(rewritten.messages[0].attachments[1].sourceUrl, originalUrl);
  assert.equal((markdown.match(/!\[/g) || []).length, 1);
  assert.match(markdown, /generated-original\.png/);
  assert.match(markdown, /data:image\/jpeg;base64,b3JpZ2luYWw=/);
  assert.doesNotMatch(markdown, /generated-preview\.png/);
  assert.doesNotMatch(markdown, /data:image\/jpeg;base64,cHJldmlldw==/);
}

function testSplitConversationUsesMediaComplexityThresholds() {
  const { helpers } = loadHelpers();
  const messages = Array.from({ length: 90 }, (_, index) => ({
    role: "assistant",
    parts: [
      { type: "text", text: `Message ${index + 1}` },
      { type: "image", url: `https://example.com/image-${index + 1}.png` }
    ]
  }));

  assert.deepEqual({ ...helpers.conversationSplitMetrics(messages) }, {
    messages: 90,
    images: 90,
    files: 0,
    embeddedImageChars: 0
  });
  assert.equal(helpers.shouldSplitConversation(messages), true, "Image-heavy exports must auto-split before the message threshold");

  const parts = helpers.splitPartsForConversation(messages);
  assert.equal(parts.length, 2);
  assert.ok(Array.isArray(parts[0].messages), "split parts must keep message arrays");
  assert.equal(parts[0].messages.length, 80);
  assert.equal(parts[0].images, 80);
  assert.equal(parts[1].messages.length, 10);

  const files = Array.from({ length: 130 }, (_, index) => ({
    role: "user",
    attachments: [
      { type: "file", url: `https://example.com/file-${index + 1}.pdf` }
    ]
  }));
  assert.equal(helpers.shouldSplitConversation(files), true, "Attachment-heavy exports must auto-split before the message threshold");
  assert.equal(helpers.splitPartsForConversation(files).length, 2);
}

function testLargeCurrentConversationForcesSplitSwitch() {
  const { helpers } = loadHelpers();
  const messages = Array.from({ length: 700 }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 ? "assistant" : "user",
    text: `Message ${index + 1}`
  }));
  helpers.state.splitMode = "off";
  helpers.state.cache.conversations["100"] = {
    id: "100",
    title: "Large conversation",
    full: true,
    messages
  };

  assert.equal(helpers.shouldForceSplitConversation(helpers.state.cache.conversations["100"]), true);
  assert.equal(helpers.shouldForceSplitForCurrentConversation(), true);

  const html = helpers.panelHtml();
  assert.match(html, /当前对话过大，已强制分片避免浏览器下载失败/);
  assert.match(html, /data-split-mode-toggle="true"[\s\S]*aria-checked="true"[\s\S]*disabled/);
}

function testSplitConversationHandlesAttachmentsWithoutReferenceErrors() {
  const { helpers } = loadHelpers();
  assert.doesNotThrow(() => helpers.conversationSplitMetrics([
    {
      attachments: [
        { type: "image", url: "https://example.com/image.png" },
        { type: "file", url: "https://example.com/file.pdf" }
      ]
    }
  ]));
  assert.deepEqual({ ...helpers.conversationSplitMetrics([
    {
      attachments: [
        { type: "image", url: "https://example.com/image.png" },
        { type: "file", url: "https://example.com/file.pdf" }
      ]
    }
  ]) }, {
    messages: 1,
    images: 1,
    files: 1,
    embeddedImageChars: 0
  });
}

function testHtmlSearchDefersHighlightingUntilEnter() {
  const source = readProjectFile(path.join("src", "content.js"));

  assert.match(source, /function countMatches\(q\)/);
  assert.match(source, /按 Enter 高亮/);
  assert.match(source, /e\.key==='Enter'.*highlightMatches/s);
  assert.doesNotMatch(source, /setTimeout\(function\(\)\{applyQuery/);
}

async function testDownloadBlobUsesObjectUrlWithoutCopyingBytes() {
  const { helpers, context } = loadHelpers();
  const clicks = [];
  const revoked = [];
  context.URL = {
    createObjectURL(blob) {
      assert.ok(blob instanceof Blob);
      return "blob:test-download";
    },
    revokeObjectURL(url) {
      revoked.push(url);
    }
  };
  context.document.body = {
    appendChild(anchor) {
      clicks.push(anchor);
    }
  };
  context.document.createElement = (tagName) => {
    assert.equal(tagName, "a");
    return {
      style: {},
      click() {
        this.clicked = true;
      },
      remove() {
        this.removed = true;
      }
    };
  };
  context.window.setTimeout = (callback, delay) => {
    assert.equal(delay, 10000);
    callback();
    return 42;
  };
  context.window.postMessage = () => {
    throw new Error("download must not copy bytes through page bridge");
  };

  await helpers.downloadBlob("conversation.html", new Blob(["ok"], { type: "text/html" }), "text/html;charset=utf-8");

  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].href, "blob:test-download");
  assert.equal(clicks[0].download, "conversation.html");
  assert.equal(clicks[0].clicked, true);
  assert.equal(clicks[0].removed, true);
  assert.deepEqual(revoked, ["blob:test-download"]);
}

function createLargeExportConversation(id, messageCount) {
  return {
    id,
    title: `Large conversation ${id}`,
    messages: Array.from({ length: messageCount }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      parts: [
        { type: "text", text: `Message ${index + 1}` }
      ]
    }))
  };
}

function testLargeExportWorkerStartProtocol() {
  const harness = createLargeExportContractHarness();
  const conversation = createLargeExportConversation("large-1", 700);

  harness.postCommand({
    type: "start",
    jobId: "job-worker-start",
    createdAt: "2026-05-10T00:00:00.000Z",
    payload: {
      scope: "current",
      format: "md",
      imageMode: "strip",
      timestampMode: "hide",
      splitMode: "on",
      conversation
    }
  });

  const snapshot = harness.snapshot();
  assert.equal(snapshot.jobs["job-worker-start"].status, "queued");
  assert.equal(snapshot.jobs["job-worker-start"].scope, "current");
  assert.equal(snapshot.jobs["job-worker-start"].format, "md");
  assert.equal(snapshot.jobs["job-worker-start"].conversationTotal, 1);
  assert.equal(snapshot.jobs["job-worker-start"].total, 700);
  assert.throws(
    () => harness.postCommand({
      type: "start",
      jobId: "job-invalid",
      payload: {
        scope: "current",
        format: "md",
        conversation: { id: "empty", messages: [] }
      }
    }),
    /must not be empty/
  );
}

function testLargeExportWorkerCancellationProtocol() {
  const harness = createLargeExportContractHarness();
  harness.postCommand({
    type: "start",
    jobId: "job-cancel",
    createdAt: "2026-05-10T00:00:00.000Z",
    payload: {
      scope: "current",
      format: "md",
      conversation: createLargeExportConversation("large-current", 900)
    }
  });
  harness.receiveEvent({
    type: "progress",
    jobId: "job-cancel",
    phase: "serialize",
    percent: 32,
    loaded: 288,
    total: 900
  });
  harness.postCommand({
    type: "cancel",
    jobId: "job-cancel",
    reason: "User requested cancellation",
    createdAt: "2026-05-10T00:01:00.000Z"
  });
  harness.receiveEvent({
    type: "log",
    jobId: "job-cancel",
    level: "info",
    message: "Worker acknowledged cancellation",
    at: "2026-05-10T00:01:01.000Z"
  });

  const snapshot = harness.snapshot();
  assert.equal(snapshot.jobs["job-cancel"].status, "cancelled");
  assert.equal(snapshot.jobs["job-cancel"].cancelled, true);
  assert.equal(snapshot.jobs["job-cancel"].cancelReason, "User requested cancellation");
  assert.match(snapshot.logs[0].message, /acknowledged cancellation/);
  assert.throws(
    () => harness.receiveEvent({
      type: "progress",
      jobId: "job-cancel",
      phase: "zip",
      percent: 40,
      loaded: 360,
      total: 900
    }),
    /terminal jobs/
  );
}

function testLargeExportLogAndStatusRecoveryContract() {
  let persisted = null;
  const storage = {
    get() {
      return persisted;
    },
    set(value) {
      persisted = value;
    }
  };
  const harness = createLargeExportContractHarness({ storage });
  harness.postCommand({
    type: "start",
    jobId: "job-recover",
    payload: {
      scope: "current",
      format: "json",
      conversation: createLargeExportConversation("large-recover", 1000)
    }
  });
  harness.receiveEvent({
    type: "status",
    jobId: "job-recover",
    status: "running",
    message: "Worker started"
  });
  harness.receiveEvent({
    type: "progress",
    jobId: "job-recover",
    phase: "serialize",
    percent: 55,
    loaded: 550,
    total: 1000
  });
  harness.receiveEvent({
    type: "log",
    jobId: "job-recover",
    level: "info",
    message: "Serialized 550 messages",
    at: "2026-05-10T00:02:00.000Z",
    details: {
      loaded: 550,
      total: 1000
    }
  });

  const recovered = createLargeExportContractHarness({ storage });
  const snapshot = recovered.snapshot();
  assert.equal(snapshot.jobs["job-recover"].status, "running");
  assert.equal(snapshot.jobs["job-recover"].percent, 55);
  assert.equal(snapshot.checkpoints["job-recover"].loaded, 550);
  assert.match(snapshot.logs[0].message, /Serialized 550 messages/);
}

function createMemoryContractStorage() {
  let persisted = null;
  return {
    get() {
      return persisted;
    },
    set(value) {
      persisted = value;
    }
  };
}

function testExportWorkerVerificationScriptIsCovered() {
  const projectRoot = path.resolve(__dirname, "..");
  execFileSync(process.execPath, [path.join(projectRoot, "scripts", "verify-export-worker.js")], {
    cwd: projectRoot,
    stdio: "inherit"
  });
}

function testMockPreviewMatchesLatestUiContract() {
  const mockHtml = readProjectFile(path.join("preview", "mock-ui.html"));
  const mockJs = readProjectFile(path.join("preview", "mock-ui.js"));
  const contentSource = readProjectFile(path.join("src", "content.js"));
  const workerSource = readProjectFile(path.join("src", "export-worker.js"));
  const dialogStyles = readProjectFile(path.join("src", "styles", "dialog.css"));
  const shellStyles = readProjectFile(path.join("src", "styles", "ui-shell.css"));
  const manifest = JSON.parse(readProjectFile(path.join("src", "manifest.json")));

  assertWindowControlsContract(mockHtml, "preview/mock-ui.html");
  assertWindowControlsContract(contentSource, "src/content.js");
  assertMinimalShellContract(mockHtml, "preview/mock-ui.html");
  assertCurrentPanelContract(mockHtml, "preview/mock-ui.html");
  assertCompactCurrentLayoutContract(mockHtml, "preview/mock-ui.html");
  assertAboutDrawerContract(mockHtml, "preview/mock-ui.html");
  assertFooterFeedbackContract(mockHtml, "preview/mock-ui.html");
  assertFreeAccessContract(contentSource, "src/content.js");
  assertExportRefreshAvoidGlobalToastContract(contentSource, "src/content.js");

  assert.match(mockJs, /\[data-window-action="close"\]/, "preview/mock-ui.js must handle the close control");
  assert.match(mockJs, /\[data-window-action="drag"\]/, "preview/mock-ui.js must handle the drag control");
  assert.match(mockJs, /\[data-window-action="reset"\]/, "preview/mock-ui.js must handle the reset control");
  assert.doesNotMatch(mockJs, /\[data-window-action="minimize"\]/, "preview/mock-ui.js must drop the old minimize handler");
  assert.doesNotMatch(mockJs, /\[data-window-action="expand"\]/, "preview/mock-ui.js must drop the old expand handler");
  assert.match(mockJs, /aboutOpen/, "preview/mock-ui.js must manage the about drawer state");
  assert.match(mockJs, /aboutAction\?\.addEventListener\("click"/, "preview/mock-ui.js must handle the about drawer toggle");
  assert.match(mockJs, /close-about/, "preview/mock-ui.js must handle the about drawer close action");
  assert.doesNotMatch(mockJs, /dbx-nav-item/, "preview/mock-ui.js must not keep old sidebar navigation handling");
  assert.match(mockHtml, /导出消息时间/, "preview/mock-ui.html must expose the message timestamp toggle");
  assert.match(mockJs, /\[data-timestamp-mode-toggle\]/, "preview/mock-ui.js must handle the message timestamp toggle");
  assert.match(contentSource, /导出消息时间/, "src/content.js must expose the message timestamp toggle");
  assert.match(contentSource, /data-timestamp-mode-toggle/, "src/content.js must keep the message timestamp toggle contract");
  assert.match(mockHtml, /大对话自动分片/, "preview/mock-ui.html must expose the real split export label");
  assert.match(mockJs, /大对话自动分片/, "preview/mock-ui.js must render the real split export label");
  assert.match(mockJs, /\[data-split-mode-toggle\]/, "preview/mock-ui.js must handle the split export toggle");
  assert.match(contentSource, /const splitLabel = "大对话自动分片"/, "src/content.js must keep the split export label concise");
  assert.match(contentSource, /splitMode:\s*"on"/, "src/content.js must enable split export by default");
  assert.match(mockJs, /splitMode:\s*"on"/, "preview/mock-ui.js must enable split export by default");
  assert.match(mockHtml, /data-split-mode-toggle="true" role="switch" aria-checked="true"/, "preview/mock-ui.html must show split export enabled by default");
  assert.match(contentSource, /data-split-mode-toggle/, "src/content.js must keep the split export toggle contract");
  assert.match(contentSource, /closest\(".*\[data-split-mode-toggle\].*"\)/, "src/content.js must include the split toggle in click delegation");
  assert.match(dialogStyles, /\.dbx-bottom-option\s*\{[\s\S]*?box-sizing:\s*border-box;/, "dialog styles must keep padded bottom options inside their grid columns");
  assert.match(dialogStyles, /\.dbx-bottom-option-copy\s*\{[\s\S]*?flex:\s*1 1 auto;/, "dialog styles must reserve label space before switches");
  assert.match(dialogStyles, /\.dbx-date-range-fields\[hidden\]\s*\{[\s\S]*?display:\s*none\s*!important;/, "dialog styles must keep inactive date fields hidden");
  assert.match(dialogStyles, /@media \(max-width:\s*720px\)[\s\S]*?\.dbx-bottom-option-wrap\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\);/, "dialog styles must stack bottom options on narrow viewports");
  assert.match(mockHtml, /按日期范围导出/, "preview/mock-ui.html must expose the date range export toggle");
  assert.match(mockHtml, /data-date-range-start/, "preview/mock-ui.html must expose the start date input");
  assert.match(mockHtml, /data-date-range-end/, "preview/mock-ui.html must expose the end date input");
  assert.match(mockJs, /\[data-date-range-toggle\]/, "preview/mock-ui.js must handle the date range toggle");
  assert.match(mockJs, /\[data-date-range-start\]/, "preview/mock-ui.js must handle the start date input");
  assert.match(contentSource, /按日期范围导出/, "src/content.js must expose the date range export toggle");
  assert.match(contentSource, /data-date-range-toggle/, "src/content.js must keep the date range toggle contract");
  assert.match(contentSource, /data-date-range-start/, "src/content.js must keep the start date input contract");
  assert.match(contentSource, /data-date-range-end/, "src/content.js must keep the end date input contract");
  assert.match(mockHtml, /data-format="txt"/, "preview/mock-ui.html must expose TXT export format");
  assert.match(contentSource, /value:\s*"txt"/, "src/content.js must expose TXT export format");
  assert.match(workerSource, /format === "txt"|normalized === "txt"/, "src/export-worker.js must support TXT export format");
  assert.match(workerSource, /text\/plain;charset=utf-8/, "src/export-worker.js must emit TXT as text/plain");
  assert.match(contentSource, /action === "refresh-current"[\s\S]*?requireLicenseForAccess\("current", "refresh"\)/, "src/content.js must keep the shared refresh access hook");
  assert.doesNotMatch(contentSource, /查看更新说明|extensionResourceUrl\("changelog\.html"\)/, "src/content.js must not expose the changelog entry in the about panel");
  assert.doesNotMatch(mockHtml, /查看更新说明|src\/changelog\.html/, "preview/mock-ui.html must not expose the changelog entry");
  assert.doesNotMatch(contentSource, /windowAction === "minimize"|windowAction === "expand"/, "src/content.js must drop the old yellow/green button semantics");
  assert.match(shellStyles, /width:\s*min\(440px,\s*calc\(100vw - 40px\)\);/, "dialog shell styles must keep the square 440px default width");
  assert.match(shellStyles, /height:\s*min\(440px,\s*calc\(100vh - 40px\)\);/, "dialog shell styles must keep the square 440px default height");
  assert.match(mockJs, /DEFAULT_DIALOG_WIDTH = 440/, "preview/mock-ui.js must match the square dialog width");
  assert.match(mockJs, /DEFAULT_DIALOG_HEIGHT = 440/, "preview/mock-ui.js must match the square dialog height");
  assertProgressCopyContract(mockHtml + mockJs, "preview mock");
  assertProgressCopyContract(contentSource, "src/content.js");
  assert.ok(
    manifest.content_scripts.every((entry) => entry.run_at === "document_start"),
    "content script must run at document_start to capture early Doubao request templates"
  );
}

function testMarkdownRenderKeepsStructuredOnlyMessages() {
  const { helpers } = loadHelpers();
  const markdown = helpers.renderMarkdown({
    id: "conversation-structured",
    title: "智能体会话",
    source: "api",
    messages: [
      {
        role: "assistant",
        parts: [
          {
            type: "structured",
            label: "agent card",
            preview: "{\"title\":\"任务结果\",\"content\":\"智能体返回内容\"}"
          }
        ]
      }
    ]
  });

  assert.match(markdown, /agent card/);
  assert.match(markdown, /智能体返回内容/);
}

function testMessageNormalizationTreatsAttachmentBlocksAsAttachmentsOnly() {
  const { helpers } = loadHelpers();
  const payload = {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            message_id: "msg-attachment-only",
            user_type: 1,
            index_in_conv: 1,
            content_block: [
              {
                block_type: 10052,
                content: {
                  attachment_block: {
                    attachments: [
                      {
                        name: "upload.png",
                        url: "https://example.com/upload.png",
                        mime_type: "image/png"
                      }
                    ]
                  }
                }
              }
            ]
          }
        ]
      }
    }
  };

  const messages = helpers.parseSingleChainMessages(payload);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "");
  assert.equal(messages[0].attachments.length, 1);
  assert.equal(messages[0].parts.length, 0);

  const markdown = helpers.renderMarkdown({ id: "conversation-1", title: "测试", source: "api", messages });
  assert.doesNotMatch(markdown, /## 用户/);
  assert.doesNotMatch(markdown, /10052|attachment_block|```json/);
}

async function main() {
  testCurrentConversationIdSupportsAgentUrls();
  testAgentConversationIdAvoidsBotFallbacks();
  testMessageNormalization();
  testMessageNormalizationBoundsStructuredPreviewMemory();
  testMessageNormalizationReadsAlternateTimestampFields();
  testMessageNormalizationReadsOfficialMessageListShape();
  testMessageNormalizationUsesVisibleRegeneratedReply();
  testMessageNormalizationReplacesSelfRootRegeneratedReply();
  testMessageNormalizationSkipsDuplicateVisibleRegeneratedReply();
  testMessageNormalizationKeepsVisibleRegeneratedChildWithoutRoot();
  testMessageNormalizationUsesStatusTenRegeneratedReplyWithoutVisibleList();
  testMessageNormalizationUsesRegeneratedReplyWhenRootStatusIsNotEight();
  testMessageNormalizationUsesVisibleDomRegeneratedReplyWithoutSwitcher();
  testMessageNormalizationCollapsesImageVariantsByCreation();
  testMessageNormalizationDedupesRepeatedParagraphs();
  testConversationMergeRule();
  testRequestCandidateOrder();
  testSingleChainAdaptiveDelay();
  await testFetchAllConversationMessagesIgnoresStaleExpectedCount();
  await testFetchAllConversationMessagesUsesIndexAnchorForOfficialShape();
  await testFetchAllConversationMessagesLoadsHundredsOfAgentMessages();
  await testFetchAllConversationMessagesReportsProgress();
  await testFetchAllConversationMessagesStopsAtKnownCache();
  await testCurrentRefreshKeepsPartialCacheWhenApiFails();
  await testCurrentRefreshDoesNotMergeDomRowsAfterApiFailure();
  await testDomFallbackDoesNotShrinkLargeCacheToVisibleRows();
  await testCurrentRefreshKeepsStaleFullCacheWhenApiFails();
  await testSaveCacheCompactsOldConversationsAfterQuotaError();
  await testSaveCacheTrimsHugeConversationOnlyInStorage();
  await testExecuteJsonRequestTimesOut();
  testSidebarSummaryFiltering();
  testRemoteCountAndProgressIgnoreIndexLikeCounts();
  testPanelHtmlMatchesLatestUiContract();
  await testRuntimeLogCopyButtonCopiesDiagnostics();
  testSplitToggleClickUpdatesState();
  testMarkdownRenderStripsImagesAndFiltersStructuredBlocksByDefault();
  testMarkdownRenderKeepsStructuredOnlyMessages();
  testMessageNormalizationTreatsAttachmentBlocksAsAttachmentsOnly();
  testMarkdownRenderSkipsImageOnlyUserMessageWhenStrippingImages();
  testMarkdownRenderEmbedsImagesWhenAssetsProvided();
  testMarkdownRenderCollapsesImageVariantsLikeWorker();
  testMarkdownRenderCollapsesLegacyImageVariantsByResourcePath();
  testMarkdownRenderCollapsesDoubaoPreviewAndOriginalImageUrls();
  testMarkdownRenderAppendsMessageTimestampsWhenEnabled();
  testDateRangeFilterIncludesStartAndWholeEndDate();
  testDateRangeFilterSkipsMessagesWithoutTimestamps();
  testCurrentExportCanReuseFullCache();
  await testFreeReleaseAllowsExportWithoutActivation();
  await testBuildMarkdownExportTextEmbedsImages();
  await testBuildMarkdownExportTextEmbedsSignedByteimgImageWithoutCredentials();
  await testBuildTextExportTextStripsImages();
  testConversationWithEmbeddedAssetsRewritesWorkerPayloadUrls();
  testEmbeddedDoubaoImageVariantsKeepDedupeKeys();
  testMarkdownRenderDedupesRepeatedAssistantText();
  testMarkdownRenderNormalizesIndentedMathInsideLists();
  await testSplitConversationZipBuildsIndexAndParts();
  await testSplitConversationManifestCountsOnlyExportedMarkdownMessages();
  await testTextSplitConversationZipUsesTxtParts();
  testSplitConversationUsesMediaComplexityThresholds();
  testLargeCurrentConversationForcesSplitSwitch();
  testSplitConversationHandlesAttachmentsWithoutReferenceErrors();
  testHtmlSearchDefersHighlightingUntilEnter();
  await testDownloadBlobUsesObjectUrlWithoutCopyingBytes();
  testLargeExportWorkerStartProtocol();
  testLargeExportWorkerCancellationProtocol();
  testLargeExportLogAndStatusRecoveryContract();
  testMockPreviewMatchesLatestUiContract();
  testExportWorkerVerificationScriptIsCovered();
  console.log("All tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
