(function () {
  "use strict";

  const APP_ID = "doubao-export-shell";
  const BRIDGE_EVENT = "__DOUBAO_EXPORT_BRIDGE_V3__";
  const STORAGE_KEY = "doubao-export-shell-v3";
  const RUNTIME_STORAGE_KEY = "doubao-export-shell-runtime-v1";
  const MAX_RUNTIME_LOGS = 400;
  const CACHE_STORAGE_COMPACT_LIMITS = [240, 160, 100, 60, 30, 12, 4, 1];
  const MAX_CACHE_CONVERSATIONS = 240;
  const MAX_SCAN_CONVERSATIONS = 200;
  const MAX_SCAN_LIST_PAGES = 12;
  const MAX_SCAN_MESSAGE_PAGES = 6000;
  const CURRENT_FETCH_FRESH_MS = 15_000;
  const SINGLE_CHAIN_DEFAULT_LIMIT = 100;
  const SINGLE_CHAIN_PAGE_SLEEP_MS = 80;
  const SINGLE_CHAIN_PAGE_JITTER_MS = 20;
  const SINGLE_CHAIN_FAST_SLEEP_MS = 8;
  const SINGLE_CHAIN_FAST_JITTER_MS = 4;
  const SINGLE_CHAIN_BACKOFF_SLEEP_MS = 3000;
  const SINGLE_CHAIN_BACKOFF_JITTER_MS = 2000;
  const SINGLE_CHAIN_FAST_AFTER_SUCCESS = 1;
  const SINGLE_CHAIN_SLOW_RESPONSE_MS = 1500;
  const IMAGE_EMBED_CONCURRENCY = 8;
  const REQUEST_TIMEOUT_MS = 45_000;
  const SPLIT_EXPORT_MESSAGES_PER_PART = 500;
  const SPLIT_EXPORT_MIN_MESSAGES = 600;
  const SPLIT_EXPORT_IMAGES_PER_PART = 80;
  const SPLIT_EXPORT_FILES_PER_PART = 120;
  const SPLIT_EXPORT_EMBEDDED_IMAGE_CHARS_PER_PART = 8_000_000;
  const RECENT_CONVERSATION_PAGE_LIMIT = 20;
  const MAX_REASONABLE_REMOTE_MESSAGE_COUNT = 80_000;
  const MAX_REQUEST_ATTEMPTS = 3;
  const HIDDEN_MESSAGE_STATUSES = new Set([1, 3, 5, 7, 19]);
  const DEFAULT_DIALOG_WIDTH = 440;
  const DEFAULT_DIALOG_HEIGHT = 440;
  const DIALOG_EDGE_MARGIN = 16;
  const UIFramework = window.DoubaoUIFramework || {};

  function createEmptyRequestSlot() {
    return {
      captured: null,
      success: null,
      failure: null
    };
  }

  function createEmptyRequestCache() {
    return {
      single: createEmptyRequestSlot(),
      recent: createEmptyRequestSlot(),
      title: createEmptyRequestSlot()
    };
  }

  function createInitialRuntimeState() {
    return {
      lastRequestSuccess: null,
      lastRequestError: null,
      logs: []
    };
  }

  function createInitialExportFeedback() {
    return {
      state: "idle",
      message: "",
      progress: 0,
      scope: null,
      type: "export"
    };
  }

  const state = {
    open: false,
    tab: "current",
    aboutOpen: false,
    format: "md",
    timestampMode: "hide",
    imageMode: "strip",
    splitMode: "on",
    dateRange: {
      enabled: false,
      startDate: "",
      endDate: ""
    },
    diagnostics: {
      current: false
    },
    windowPosition: {
      left: null,
      top: null
    },
    runtime: createInitialRuntimeState(),
    exportFeedback: createInitialExportFeedback(),
    cache: {
      conversations: {},
      summaries: {},
      requests: createEmptyRequestCache(),
      webTabId: "",
      lastScanAt: null
    }
  };

  let activeDragSession = null;
  let activeExportTask = null;
  const pendingDownloadRequests = new Map();

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function nowMs() {
    return Date.now();
  }

  function createSingleChainPagePace() {
    return {
      mode: "probe",
      consecutiveSuccess: 0,
      lastLatencyMs: 0,
      lastDelayMs: 0
    };
  }

  function updateSingleChainPagePace(pace, result = {}) {
    if (!pace) return createSingleChainPagePace();
    const latencyMs = Math.max(0, Math.round(Number(result.latencyMs || 0) || 0));
    const pageMessages = Number(result.pageMessages || 0);
    const unstable = Boolean(result.error || result.duplicatePage || pageMessages <= 0);
    if (unstable) {
      pace.mode = "backoff";
      pace.consecutiveSuccess = 0;
    } else if (latencyMs > SINGLE_CHAIN_SLOW_RESPONSE_MS) {
      pace.mode = "probe";
      pace.consecutiveSuccess = 0;
    } else {
      pace.consecutiveSuccess += 1;
      pace.mode = pace.consecutiveSuccess >= SINGLE_CHAIN_FAST_AFTER_SUCCESS ? "fast" : "probe";
    }
    pace.lastLatencyMs = latencyMs;
    return pace;
  }

  function singleChainPageSleepMs(page, pace = null) {
    const safePage = Math.max(1, Number(page || 1) || 1);
    const mode = pace?.mode || "probe";
    const base = mode === "fast"
      ? SINGLE_CHAIN_FAST_SLEEP_MS
      : mode === "backoff"
        ? SINGLE_CHAIN_BACKOFF_SLEEP_MS
        : SINGLE_CHAIN_PAGE_SLEEP_MS;
    const jitterMax = mode === "fast"
      ? SINGLE_CHAIN_FAST_JITTER_MS
      : mode === "backoff"
        ? SINGLE_CHAIN_BACKOFF_JITTER_MS
        : SINGLE_CHAIN_PAGE_JITTER_MS;
    const delay = base + Math.floor(Math.random() * jitterMax);
    if (pace) pace.lastDelayMs = delay;
    return delay;
  }

  function safeParseJson(value) {
    if (!value) return null;
    if (typeof value === "object") return value;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      return null;
    }
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeCompareText(value) {
    return String(value || "")
      .replace(/\r?\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function uniqueTextParts(values) {
    const seen = new Set();
    const output = [];
    values.forEach((value) => {
      const text = String(value || "").trim();
      if (!text) return;
      const key = normalizeCompareText(text);
      if (!key || seen.has(key)) return;
      seen.add(key);
      output.push(text);
    });
    return output;
  }

  function dedupeRepeatedParagraphs(value) {
    const text = String(value || "").replace(/\r\n?/g, "\n").trim();
    if (!text) return "";

    const paragraphs = text
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

    if (paragraphs.length < 2) return text;

    const seen = new Set();
    const output = [];
    paragraphs.forEach((paragraph) => {
      const key = normalizeCompareText(paragraph);
      if (!key) return;
      if (seen.has(key)) return;
      seen.add(key);
      output.push(paragraph);
    });

    return output.join("\n\n").trim();
  }

  function looksLikeStyleNoise(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    if (text.length < 80) return false;
    const styleHints = [
      "[stylesheet-group=",
      "body{margin:0;}",
      "display:flex;",
      "font-family:",
      ".r-",
      ".css-"
    ];
    const matched = styleHints.filter((hint) => text.includes(hint)).length;
    return matched >= 2;
  }

  function stripStyleNoise(value) {
    const text = String(value || "").trim();
    if (!looksLikeStyleNoise(text)) return text;
    const candidates = text
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !looksLikeStyleNoise(part) && !isNoiseText(part));
    return candidates.at(-1) || "";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function extensionResourceUrl(path) {
    return typeof chrome !== "undefined" && chrome?.runtime?.getURL ? chrome.runtime.getURL(path) : path;
  }

  function sanitizeFileName(name) {
    return (name || "doubao-chat")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "doubao-chat";
  }

  function timestampLabel() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join("-") + "_" + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("-");
  }

  function randomId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `dbx-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function normalizedUrl(url) {
    if (url == null || url === "") return "";
    try {
      const parsed = new URL(url, location.origin);
      parsed.hash = "";
      return parsed.toString();
    } catch (error) {
      return "";
    }
  }

  function readPathname(url) {
    if (url == null || url === "") return "";
    try {
      return new URL(url, location.origin).pathname.toLowerCase();
    } catch (error) {
      return "";
    }
  }

  function conversationRouteKind(url = location.href) {
    const path = readPathname(url);
    if (/\/chat\/bot\/chat\/[^/?#]+/i.test(path)) return "agent_chat";
    if (/\/chat\/bot(?:\/|$)/i.test(path)) return "agent_home";
    if (/\/chat\/\d+(?:\/|$)/i.test(path)) return "normal_chat";
    if (/\/chat(?:\/|$)/i.test(path)) return "chat";
    return "unknown";
  }

  function sidebarConversationIdFromAnchor(anchor) {
    const direct = String(anchor?.id || anchor?.getAttribute?.("id") || "").trim();
    const match = direct.match(/^conversation_(\d+)$/i);
    return match?.[1] || "";
  }

  function sidebarConversationAnchors() {
    try {
      return Array.from(document.querySelectorAll("a[id^='conversation_'][href*='/chat/']"))
        .filter((anchor) => isSidebarElement(anchor));
    } catch (error) {
      return [];
    }
  }

  function sidebarConversationUrl(anchor) {
    const href = anchor?.getAttribute?.("href") || anchor?.href || "";
    if (!href) return "";
    try {
      return normalizedUrl(new URL(href, location.origin).toString());
    } catch (error) {
      return "";
    }
  }

  function sidebarConversationIdForUrl(url = location.href) {
    const targetUrl = normalizedUrl(url);
    if (!targetUrl) return "";
    const match = sidebarConversationAnchors().find((anchor) => sidebarConversationUrl(anchor) === targetUrl);
    return sidebarConversationIdFromAnchor(match);
  }

  function activeSidebarConversationId() {
    const anchors = sidebarConversationAnchors();
    const currentUrl = normalizedUrl(location.href);
    const active = anchors.find((anchor) => {
      const className = String(anchor?.className || "");
      return /\b(active-link|e2e-test-active|is-active)\b/i.test(className)
        || anchor?.getAttribute?.("aria-current") === "page"
        || (currentUrl && sidebarConversationUrl(anchor) === currentUrl);
    });
    return sidebarConversationIdFromAnchor(active);
  }

  function sidebarConversationUrlForId(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) return "";
    const match = sidebarConversationAnchors().find((anchor) => sidebarConversationIdFromAnchor(anchor) === id);
    return sidebarConversationUrl(match);
  }

  function cleanConversationTitle(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isGenericConversationTitle(value) {
    const title = cleanConversationTitle(value);
    return !title || /^(豆包|doubao|doubao conversation|豆包会话)$/i.test(title);
  }

  function preferSpecificTitle(primary, fallback = "") {
    const next = cleanConversationTitle(primary);
    const previous = cleanConversationTitle(fallback);
    if (isGenericConversationTitle(next) && !isGenericConversationTitle(previous)) return previous;
    return next || previous;
  }

  function sidebarConversationTitleForId(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) return "";
    const match = sidebarConversationAnchors().find((anchor) => sidebarConversationIdFromAnchor(anchor) === id);
    return cleanConversationTitle(match?.textContent || match?.innerText || "");
  }

  function normalizedAgentBotUrl(url = location.href) {
    try {
      const parsed = new URL(url, location.origin);
      const match = parsed.pathname.match(/\/chat\/bot\/chat\/([^/?#]+)/i);
      if (!match?.[1]) return "";
      parsed.pathname = `/chat/bot/chat/${match[1]}`;
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch (error) {
      return "";
    }
  }

  function agentRouteBotId(url = location.href) {
    try {
      const match = new URL(url, location.origin).pathname.match(/\/chat\/bot\/chat\/([^/?#]+)/i);
      return String(match?.[1] || "").trim();
    } catch (error) {
      return "";
    }
  }

  function isAgentRouteBotId(value, url = location.href) {
    const candidate = String(value || "").trim();
    return Boolean(candidate && candidate === agentRouteBotId(url));
  }

  function templatePageMatchesUrl(template, url = location.href) {
    const targetUrl = normalizedAgentBotUrl(url) || normalizedUrl(url);
    const templateUrl = normalizedAgentBotUrl(template?.pageUrl) || normalizedUrl(template?.pageUrl);
    return Boolean(targetUrl && templateUrl && targetUrl === templateUrl);
  }

  function requestTemplateConversationId(kind = "single", url = location.href) {
    const slot = state.cache.requests?.[kind];
    const templates = [slot?.captured, slot?.success, slot?.failure].filter(Boolean);
    for (const template of templates) {
      if (!templatePageMatchesUrl(template, url)) continue;
      const body = safeParseJson(template?.bodyText || "");
      const id = extractConversationIdFromPayload(body);
      if (isLoadableConversationId(id) && !isAgentRouteBotId(id, url)) return id;
    }
    return "";
  }

  function cachedConversationIdForUrl(url = location.href) {
    const targetUrl = normalizedAgentBotUrl(url) || normalizedUrl(url);
    if (!targetUrl) return "";
    const entries = [
      ...Object.entries(state.cache.summaries || {}),
      ...Object.entries(state.cache.conversations || {})
    ];
    for (const [id, item] of entries) {
      if (!isLoadableConversationId(id)) continue;
      if (isAgentRouteBotId(id, url)) continue;
      const itemUrl = normalizedAgentBotUrl(item?.url) || normalizedUrl(item?.url);
      if (itemUrl && itemUrl === targetUrl) return id;
    }
    return "";
  }

  function routeConversationId(url = location.href) {
    try {
      const parsed = new URL(url, location.origin);
      const numericChatMatch = parsed.pathname.match(/\/chat\/(\d+)(?:\/|$)/i);
      if (numericChatMatch?.[1]) return numericChatMatch[1];
      const queryId = parsed.searchParams.get("conversation_id") || parsed.searchParams.get("conversationId");
      if (queryId) return queryId;
      if (/\/chat\/bot(?:\/|$)/i.test(parsed.pathname)) return "";
      const botChatMatch = parsed.pathname.match(/\/chat\/bot\/chat\/([^/?#]+)/i);
      if (botChatMatch?.[1]) return botChatMatch[1];
      const match = parsed.pathname.match(/\/chat\/([^/?#]+)/i);
      const pathId = String(match?.[1] || "").trim();
      return pathId && pathId !== "bot" ? pathId : "";
    } catch (error) {
      return "";
    }
  }

  function currentConversationId(url = location.href) {
    if (conversationRouteKind(url) === "agent_chat") {
      const sidebarId = sidebarConversationIdForUrl(url)
        || (normalizedUrl(url) === normalizedUrl(location.href) ? activeSidebarConversationId() : "")
        || cachedConversationIdForUrl(url)
        || (normalizedUrl(url) === normalizedUrl(location.href) ? requestTemplateConversationId("single", url) : "");
      if (sidebarId) return sidebarId;
      return "";
    }
    return routeConversationId(url);
  }

  function isLoadableConversationId(value) {
    return /^\d+$/.test(String(value || "").trim());
  }

  function currentConversationUrl(conversationId) {
    if (!conversationId) return location.href;
    const sidebarUrl = sidebarConversationUrlForId(conversationId);
    if (sidebarUrl) return sidebarUrl;
    if (conversationRouteKind() === "agent_chat" && currentConversationId() === String(conversationId || "").trim()) {
      return normalizedUrl(location.href) || location.href;
    }
    return new URL(`/chat/${conversationId}`, location.origin).toString();
  }

  function documentConversationTitle() {
    const title = cleanConversationTitle(document.title.replace(/\s*[-|].*$/, ""));
    if (!isGenericConversationTitle(title)) return title;
    const sidebarTitle = sidebarConversationTitleForId(currentConversationId());
    if (!isGenericConversationTitle(sidebarTitle)) return sidebarTitle;
    const heading = document.querySelector("h1, h2, [role='heading']");
    const headingTitle = cleanConversationTitle(heading?.textContent || "");
    if (!isGenericConversationTitle(headingTitle)) return headingTitle;
    return title || headingTitle || "Doubao conversation";
  }

  function isNoiseText(text) {
    const value = String(text || "").trim();
    if (!value) return true;
    if (value === "{}" || value === "[]") return true;
    if (/^https?:\/\/.+$/i.test(value) && /(byteimg|flow-imagex-sign|flow-sign|tos-cn-)/i.test(value)) return true;
    if (/^[0-9]{14,}$/.test(value)) return true;
    if (/^[A-Za-z0-9_-]{24,}$/.test(value) && !/\s/.test(value)) return true;
    return false;
  }

  function loadStoredWebTabId() {
    try {
      return sessionStorage.getItem("doubao-export-web-tab-id") || "";
    } catch (error) {
      return "";
    }
  }

  function rememberWebTabId(id) {
    const value = String(id || "").trim();
    if (!value) return "";
    state.cache.webTabId = value;
    try {
      sessionStorage.setItem("doubao-export-web-tab-id", value);
    } catch (error) {
      console.debug(`[${APP_ID}] save webTabId failed`, error);
    }
    return value;
  }

  function rememberWebTabIdFromUrl(url) {
    try {
      const value = new URL(url, location.origin).searchParams.get("web_tab_id") || "";
      if (value) rememberWebTabId(value);
    } catch (error) {
      console.debug(`[${APP_ID}] parse webTabId failed`, error);
    }
  }

  function requestKindFromUrl(url) {
    if (isSingleChainUrl(url)) return "single";
    if (isRecentConversationUrl(url)) return "recent";
    if (isConversationInfoUrl(url)) return "title";
    return "";
  }

  function normalizeTemplateRecord(record) {
    if (!record || typeof record !== "object") return null;
    const url = normalizedUrl(record.url);
    if (!url) return null;
    return {
      url,
      pageUrl: normalizedUrl(record.pageUrl) || "",
      method: String(record.method || "GET").toUpperCase(),
      headers: sanitizeRequestHeaders(record.headers || {}),
      bodyText: typeof record.bodyText === "string" ? record.bodyText : record.bodyText != null ? String(record.bodyText) : "",
      capturedAt: record.capturedAt || null,
      source: record.source || ""
    };
  }

  function normalizeRequestSlot(slot) {
    if (!slot || typeof slot !== "object") {
      return createEmptyRequestSlot();
    }
    if ("captured" in slot || "success" in slot || "failure" in slot) {
      return {
        captured: normalizeTemplateRecord(slot.captured),
        success: normalizeTemplateRecord(slot.success),
        failure: normalizeTemplateRecord(slot.failure)
      };
    }
    return {
      captured: null,
      success: normalizeTemplateRecord(slot),
      failure: null
    };
  }

  function normalizeRequestCache(requests) {
    return {
      single: normalizeRequestSlot(requests?.single),
      recent: normalizeRequestSlot(requests?.recent),
      title: normalizeRequestSlot(requests?.title)
    };
  }

  function estimateJsonBytes(value) {
    try {
      return new Blob([JSON.stringify(value)]).size;
    } catch (_error) {
      return String(JSON.stringify(value) || "").length;
    }
  }

  function isQuotaStorageError(error) {
    return /quota|kquotabytes|quota_bytes/i.test(String(error?.message || error || ""));
  }

  function cacheEntriesByRecency(entries, preserveId = "") {
    const keepId = String(preserveId || "").trim();
    return entries.slice().sort((left, right) => {
      if (keepId && left[0] === keepId) return -1;
      if (keepId && right[0] === keepId) return 1;
      return new Date(right[1]?.updatedAt || 0).getTime() - new Date(left[1]?.updatedAt || 0).getTime();
    });
  }

  function compactRequestTemplate(template) {
    if (!template) return null;
    const bodyText = String(template.bodyText || "");
    return {
      ...template,
      bodyText: bodyText.length > 12000 ? bodyText.slice(0, 12000) : bodyText
    };
  }

  function compactRequestSlotForStorage(slot) {
    return {
      captured: compactRequestTemplate(slot?.captured),
      success: compactRequestTemplate(slot?.success),
      failure: compactRequestTemplate(slot?.failure)
    };
  }

  function requestCacheForStorage(requests) {
    const normalized = normalizeRequestCache(requests);
    return {
      single: compactRequestSlotForStorage(normalized.single),
      recent: compactRequestSlotForStorage(normalized.recent),
      title: compactRequestSlotForStorage(normalized.title)
    };
  }

  function storageConversation(conversation) {
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    if (messages.length <= 1200) return conversation;
    // ponytail: full chat stays in RAM for immediate export; persisted cache keeps only a compact preview.
    return {
      ...conversation,
      messages: messages.slice(-1200),
      messageCount: messages.length,
      full: false,
      captureState: "partial",
      storageTrimmed: true
    };
  }

  function cacheSnapshotForStorage(conversationLimit = MAX_CACHE_CONVERSATIONS) {
    const preserveId = currentConversationId() || "";
    const safeLimit = Math.max(1, Number(conversationLimit || MAX_CACHE_CONVERSATIONS) || MAX_CACHE_CONVERSATIONS);
    const conversationEntries = cacheEntriesByRecency(Object.entries(state.cache.conversations || {}), preserveId).slice(0, safeLimit);
    const storedPairs = conversationEntries.map(([id, conversation]) => [id, storageConversation(conversation)]);
    const conversations = Object.fromEntries(storedPairs);
    const trimmedIds = new Set(storedPairs.filter(([, conversation]) => conversation?.storageTrimmed).map(([id]) => id));
    const storedConversationIds = new Set(conversationEntries.map(([id]) => id));
    const summaryLimit = Math.max(MAX_CACHE_CONVERSATIONS, safeLimit * 3);
    const summaryEntries = cacheEntriesByRecency(Object.entries(state.cache.summaries || {}), preserveId)
      .filter(([id], index) => storedConversationIds.has(id) || index < summaryLimit)
      .slice(0, Math.max(summaryLimit, storedConversationIds.size));
    const summaries = Object.fromEntries(summaryEntries.map(([id, summary]) => {
      if (!trimmedIds.has(id)) return [id, summary];
      return [id, {
        ...summary,
        captureState: "partial",
        messageCountSource: "loaded_partial"
      }];
    }));
    return {
      conversations,
      summaries,
      requests: requestCacheForStorage(state.cache.requests),
      webTabId: state.cache.webTabId || "",
      lastScanAt: state.cache.lastScanAt || null
    };
  }

  function cacheStorageVariants() {
    const limits = Array.from(new Set([
      MAX_CACHE_CONVERSATIONS,
      ...CACHE_STORAGE_COMPACT_LIMITS
    ].filter((value) => Number(value) > 0)));
    return limits.map((conversationLimit) => {
      const cache = cacheSnapshotForStorage(conversationLimit);
      return {
        conversationLimit,
        cache,
        bytes: estimateJsonBytes(cache),
        conversations: Object.keys(cache.conversations || {}).length,
        summaries: Object.keys(cache.summaries || {}).length
      };
    });
  }

  async function loadCache() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const stored = result?.[STORAGE_KEY];
      if (!stored || typeof stored !== "object") {
        state.cache.webTabId = loadStoredWebTabId();
        return;
      }
      state.cache = {
        conversations: Object.fromEntries(
          Object.entries(stored.conversations || {})
            .map(([id, conversation]) => [id, compactConversationForRuntime(conversation)])
        ),
        summaries: stored.summaries || {},
        requests: normalizeRequestCache(stored.requests),
        webTabId: stored.webTabId || loadStoredWebTabId(),
        lastScanAt: stored.lastScanAt || null
      };
    } catch (error) {
      console.debug(`[${APP_ID}] load cache failed`, error);
      state.cache.webTabId = loadStoredWebTabId();
    }
  }

  async function saveCache() {
    let lastError = null;
    const variants = cacheStorageVariants();
    for (let index = 0; index < variants.length; index += 1) {
      const variant = variants[index];
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: variant.cache });
        if (index > 0 || variant.conversationLimit < MAX_CACHE_CONVERSATIONS) {
          addRuntimeLog("cache_storage_compacted", "缓存过大，已压缩旧会话后保存", {
            conversationLimit: variant.conversationLimit,
            conversations: variant.conversations,
            summaries: variant.summaries,
            bytes: variant.bytes
          });
        }
        return true;
      } catch (error) {
        lastError = error;
        if (!isQuotaStorageError(error)) break;
      }
    }
    try {
      addRuntimeLog("cache_storage_failed", "缓存保存失败，可能已达到浏览器存储配额", {
        category: isQuotaStorageError(lastError) ? "quota_exceeded" : "storage_error",
        message: lastError?.message || String(lastError || ""),
        variants: variants.length,
        smallestBytes: variants.at(-1)?.bytes || 0,
        smallestConversations: variants.at(-1)?.conversations || 0
      });
    } catch (_logError) {
      // Avoid surfacing a secondary logging failure while handling storage errors.
    }
    console.debug(`[${APP_ID}] save cache failed`, lastError);
    return false;
  }

  async function loadRuntimeState() {
    try {
      const result = await chrome.storage.local.get(RUNTIME_STORAGE_KEY);
      const stored = result?.[RUNTIME_STORAGE_KEY];
      if (!stored || typeof stored !== "object") return;
      state.runtime = {
        ...createInitialRuntimeState(),
        ...stored,
        logs: Array.isArray(stored.logs) ? stored.logs.slice(0, 60) : []
      };
    } catch (error) {
      console.debug(`[${APP_ID}] load runtime state failed`, error);
    }
  }

  async function saveRuntimeState() {
    try {
      await chrome.storage.local.set({ [RUNTIME_STORAGE_KEY]: state.runtime });
    } catch (error) {
      console.debug(`[${APP_ID}] save runtime state failed`, error);
    }
  }

  async function requireLicenseForAccess() {
    return true;
  }

  async function requireLicenseForExport(scope = "current") {
    return requireLicenseForAccess(scope, "export");
  }

  function pruneConversations() {
    const entries = Object.entries(state.cache.conversations)
      .sort((a, b) => new Date(b[1].updatedAt || 0).getTime() - new Date(a[1].updatedAt || 0).getTime());
    state.cache.conversations = Object.fromEntries(entries.slice(0, MAX_CACHE_CONVERSATIONS));
  }

  function refreshUiIfOpen() {
    if (state.open) renderPanel();
  }

  function syncFooterIfOpen() {
    const overlay = document.getElementById(`${APP_ID}-overlay`);
    if (overlay?.querySelector(".dbx-dialog")) {
      syncFooterControls(overlay);
    }
  }

  function scheduleExportFeedbackReset(delay = 1800) {
    window.clearTimeout(scheduleExportFeedbackReset.timerId);
    scheduleExportFeedbackReset.timerId = window.setTimeout(() => {
      state.exportFeedback = createInitialExportFeedback();
      syncFooterIfOpen();
    }, delay);
  }

  function setExportFeedback(nextState, message, progress = 0, scope = state.tab, type = "export") {
    const normalizedState = String(nextState || "idle").trim() || "idle";
    state.exportFeedback = {
      scope: String(scope || state.tab || "").trim(),
      state: normalizedState,
      message: String(message || "").trim(),
      progress: Math.max(0, Math.min(100, Number(progress) || 0)),
      type: String(type || "export").trim()
    };
    if (normalizedState === "working") {
      window.clearTimeout(scheduleExportFeedbackReset.timerId);
    } else {
      stopFeedbackDrift();
    }
    syncFooterIfOpen();
  }

  function stopFeedbackDrift() {
    window.clearInterval(stopFeedbackDrift.timerId);
    stopFeedbackDrift.timerId = 0;
  }

  function startFeedbackDrift({
    scope = state.tab,
    type = "export",
    message = state.exportFeedback.message || "处理中…",
    progress = 0,
    ceiling = 88,
    interval = 320
  } = {}) {
    stopFeedbackDrift();
    setExportFeedback("working", message, progress, scope, type);
    stopFeedbackDrift.timerId = window.setInterval(() => {
      const current = state.exportFeedback;
      if (!current || current.state !== "working" || current.scope !== scope || current.type !== type) {
        stopFeedbackDrift();
        return;
      }
      if (current.progress >= ceiling) return;
      const remaining = ceiling - current.progress;
      const nextProgress = Math.min(ceiling, current.progress + Math.max(1, Math.ceil(remaining * 0.18)));
      if (nextProgress === current.progress) return;
      state.exportFeedback = {
        ...current,
        progress: nextProgress
      };
      syncFooterIfOpen();
    }, interval);
  }

  function exportFeedbackVisible() {
    return Boolean(state.exportFeedback.scope) && state.exportFeedback.state !== "idle";
  }

  function progressMessage(error) {
    const text = String(error?.message || error || "").trim();
    if (!text) return "导出失败，请重试。";
    if (/Failed to construct 'Worker'|cannot be accessed from origin|后台导出 Worker/i.test(text)) {
      return "后台导出线程启动失败，请刷新页面后重试。";
    }
    if (text === "No conversation messages available") return "当前对话还没有可导出的消息。";
    if (text === "No messages in selected date range") return "所选时间段没有可导出的消息。";
    if (text === "No date range selected") return "请先选择开始日期或结束日期。";
    if (text === "Invalid date range") return "结束日期不能早于开始日期。";
    return text;
  }

  function clampDialogPosition(left, top, width, height) {
    const maxLeft = Math.max(DIALOG_EDGE_MARGIN, window.innerWidth - width - DIALOG_EDGE_MARGIN);
    const maxTop = Math.max(DIALOG_EDGE_MARGIN, window.innerHeight - height - DIALOG_EDGE_MARGIN);
    return {
      left: Math.min(Math.max(left, DIALOG_EDGE_MARGIN), maxLeft),
      top: Math.min(Math.max(top, DIALOG_EDGE_MARGIN), maxTop)
    };
  }

  function dialogStyleText() {
    const styles = [
      `width:min(${DEFAULT_DIALOG_WIDTH}px, calc(100vw - 32px))`,
      `height:min(${DEFAULT_DIALOG_HEIGHT}px, calc(100vh - 32px))`
    ];
    if (Number.isFinite(state.windowPosition.left) && Number.isFinite(state.windowPosition.top)) {
      styles.push("position:absolute");
      styles.push(`left:${state.windowPosition.left}px`);
      styles.push(`top:${state.windowPosition.top}px`);
    }
    return styles.join("; ");
  }

  function syncDialogFrame(overlay) {
    const dialog = overlay?.querySelector(".dbx-dialog");
    if (!dialog) return;
    dialog.style.cssText = dialogStyleText();
  }

  function resetDialogPosition() {
    state.windowPosition = {
      left: null,
      top: null
    };
    const overlay = document.getElementById(`${APP_ID}-overlay`);
    if (overlay) syncDialogFrame(overlay);
  }

  function beginDialogDrag(overlay, event) {
    if (!overlay || event.button !== 0) return;
    const dialog = overlay.querySelector(".dbx-dialog");
    if (!dialog) return;
    const rect = dialog.getBoundingClientRect();
    state.windowPosition = {
      left: rect.left,
      top: rect.top
    };
    syncDialogFrame(overlay);
    activeDragSession = {
      pointerId: event.pointerId,
      width: rect.width,
      height: rect.height,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function updateDialogDrag(overlay, event) {
    if (!activeDragSession || event.pointerId !== activeDragSession.pointerId) return;
    const next = clampDialogPosition(
      event.clientX - activeDragSession.offsetX,
      event.clientY - activeDragSession.offsetY,
      activeDragSession.width,
      activeDragSession.height
    );
    state.windowPosition = next;
    syncDialogFrame(overlay);
  }

  function endDialogDrag(event) {
    if (!activeDragSession || event.pointerId !== activeDragSession.pointerId) return;
    event.currentTarget?.releasePointerCapture?.(event.pointerId);
    activeDragSession = null;
  }

  function normalizeCaptureState(value, messageCount = 0, isFull = false) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "full" || normalized === "partial" || normalized === "summary_only" || normalized === "failed") {
      return normalized;
    }
    if (isFull) return "full";
    if (Number(messageCount || 0) > 0) return "partial";
    return "summary_only";
  }

  function mergeCaptureState(existingState, nextState) {
    const normalizedExisting = normalizeCaptureState(existingState);
    const normalizedNext = normalizeCaptureState(nextState);
    if (normalizedExisting === "full" || normalizedNext === "full") return "full";
    if (normalizedExisting === "partial" || normalizedNext === "partial") return "partial";
    if (normalizedExisting === "failed" || normalizedNext === "failed") return "failed";
    return "summary_only";
  }

  function captureStateOfConversation(conversation) {
    const messageCount = Array.isArray(conversation?.messages)
      ? conversation.messages.length
      : Number(conversation?.messageCount || 0);
    return normalizeCaptureState(conversation?.captureState, messageCount, Boolean(conversation?.full));
  }

  function updateSummary(summary) {
    if (!summary?.id) return;
    const existing = state.cache.summaries[summary.id] || {};
    const messageCount = Number(
      summary.messageCount != null
        ? summary.messageCount
        : existing.messageCount || 0
    ) || 0;
    const inferredCaptureState = normalizeCaptureState(
      summary.captureState,
      messageCount,
      summary.full === true || existing.full === true
    );
    const captureState = mergeCaptureState(existing.captureState, inferredCaptureState);
    const messageCountSource = summary.messageCountSource || existing.messageCountSource || "";
    const title = preferSpecificTitle(summary.title, existing.title);
    state.cache.summaries[summary.id] = {
      ...existing,
      ...summary,
      id: summary.id,
      title,
      url: summary.url || existing.url || currentConversationUrl(summary.id),
      messageCount,
      messageCountSource,
      captureState,
      updatedAt: new Date().toISOString()
    };
  }

  function shouldReplaceConversation(existing, incoming) {
    if (!existing) return true;
    const existingCount = Array.isArray(existing.messages) ? existing.messages.length : 0;
    const incomingCount = Array.isArray(incoming.messages) ? incoming.messages.length : 0;
    if (incoming.full && !existing.full) return true;
    if (existing.full && !incoming.full && existingCount >= incomingCount) return false;
    if (incomingCount > existingCount) return true;
    if (incoming.full && existing.full && incomingCount === existingCount) return true;
    if (!existing.updatedAt) return true;
    if (incoming.updatedAt && new Date(incoming.updatedAt).getTime() > new Date(existing.updatedAt).getTime() && incomingCount >= existingCount) {
      return true;
    }
    return false;
  }

  function upsertConversation(conversation) {
    if (!conversation?.id) return;
    const normalizedConversation = maybePromoteConversationToFull(compactConversationForRuntime(conversation));
    const existing = state.cache.conversations[normalizedConversation.id];
    const existingSummary = state.cache.summaries[normalizedConversation.id] || {};
    const captureState = captureStateOfConversation({
      ...existing,
      ...normalizedConversation
    });
    const title = preferSpecificTitle(normalizedConversation.title, existing?.title || existingSummary.title);
    const candidate = {
      ...existing,
      ...normalizedConversation,
      title,
      captureState,
      full: captureState === "full",
      updatedAt: new Date().toISOString()
    };
    if (!shouldReplaceConversation(existing, candidate)) return;
    state.cache.conversations[normalizedConversation.id] = candidate;
    const loadedMessageCount = Array.isArray(normalizedConversation.messages)
      ? normalizedConversation.messages.length
      : Number(existingSummary.messageCount || 0) || 0;
    const hasLargerRemoteCount = existingSummary.messageCountSource === "remote"
      && Number(existingSummary.messageCount || 0) > loadedMessageCount
      && candidate.captureState !== "full";
    if (hasLargerRemoteCount) {
      addRuntimeLog("summary_count_preserved", "保留远端会话消息总数，避免把部分加载误判为完整", {
        conversationId: normalizedConversation.id,
        remoteMessageCount: Number(existingSummary.messageCount || 0),
        loadedMessageCount,
        captureState: candidate.captureState
      });
    }
    updateSummary({
      id: normalizedConversation.id,
      title: candidate.title || existingSummary.title || "未命名会话",
      url: normalizedConversation.url || existingSummary.url || currentConversationUrl(normalizedConversation.id),
      messageCount: candidate.captureState === "full"
        ? loadedMessageCount
        : hasLargerRemoteCount ? Number(existingSummary.messageCount || 0) : loadedMessageCount,
      messageCountSource: hasLargerRemoteCount
        ? "remote"
        : candidate.captureState === "full"
          ? "loaded_full"
          : "loaded_partial",
      messageCountRaw: candidate.captureState === "full"
        ? 0
        : Number(existingSummary.messageCountRaw || 0) || 0,
      source: normalizedConversation.source || existingSummary.source || "doubao",
      captureState: candidate.captureState,
      lastError: "",
      lastErrorCategory: ""
    });
    pruneConversations();
    saveCache();
    refreshUiIfOpen();
  }

  function markConversationFailure(conversationId, error, summary = {}) {
    if (!conversationId) return;
    const existingConversation = state.cache.conversations[conversationId];
    const existingSummary = state.cache.summaries[conversationId];
    updateSummary({
      id: conversationId,
      title: summary.title || existingConversation?.title || existingSummary?.title || `Conversation ${conversationId}`,
      url: summary.url || existingConversation?.url || existingSummary?.url || currentConversationUrl(conversationId),
      source: summary.source || existingConversation?.source || existingSummary?.source || "doubao",
      messageCount: Array.isArray(existingConversation?.messages)
        ? existingConversation.messages.length
        : existingSummary?.messageCount || 0,
      captureState: existingConversation ? captureStateOfConversation(existingConversation) : "failed",
      lastError: error?.message || String(error || ""),
      lastErrorCategory: error?.category || ""
    });
    saveCache();
    refreshUiIfOpen();
  }

  function isSingleChainUrl(url) {
    const pathname = readPathname(url);
    return pathname.endsWith("/im/chain/single") || pathname.endsWith("/api/im/chain/single");
  }

  function isRecentConversationUrl(url) {
    const pathname = readPathname(url);
    return pathname.endsWith("/im/chain/recent_conv") || pathname.endsWith("/api/im/chain/recent_conv");
  }

  function isConversationInfoUrl(url) {
    const pathname = readPathname(url);
    return pathname.endsWith("/im/conversation/info") || pathname.endsWith("/api/im/conversation/info");
  }

  function sanitizeRequestHeaders(inputHeaders) {
    const blocked = new Set([
      "cookie",
      "host",
      "origin",
      "referer",
      "content-length",
      "connection",
      "accept-encoding",
      "sec-fetch-site",
      "sec-fetch-mode",
      "sec-fetch-dest",
      "sec-ch-ua",
      "sec-ch-ua-mobile",
      "sec-ch-ua-platform"
    ]);
    const headers = {};
    Object.entries(inputHeaders || {}).forEach(([name, value]) => {
      const key = String(name || "").toLowerCase().trim();
      if (!key || blocked.has(key)) return;
      if (value == null || value === "") return;
      headers[key] = String(value);
    });
    if (!headers.accept) headers.accept = "application/json, text/plain, */*";
    if (!headers["content-type"]) headers["content-type"] = "application/json; encoding=utf-8";
    if (!headers["agw-js-conv"]) headers["agw-js-conv"] = "str";
    return headers;
  }

  function createRequestTemplate(url, method, headers, bodyText, source = "") {
    const normalized = normalizedUrl(url);
    if (!normalized) return null;
    return {
      url: normalized,
      pageUrl: normalizedUrl(location.href) || location.href,
      method: String(method || "GET").toUpperCase(),
      headers: sanitizeRequestHeaders(headers),
      bodyText: typeof bodyText === "string" ? bodyText : bodyText != null ? String(bodyText) : "",
      capturedAt: new Date().toISOString(),
      source
    };
  }

  function requestSlot(kind) {
    if (!kind) return null;
    if (!state.cache.requests[kind]) {
      state.cache.requests[kind] = createEmptyRequestSlot();
    }
    return state.cache.requests[kind];
  }

  function selectRequestTemplate(kind) {
    const slot = requestSlot(kind);
    if (slot?.captured) return { template: slot.captured, templateSource: "captured" };
    if (slot?.success) return { template: slot.success, templateSource: "success" };
    return { template: null, templateSource: "synthetic" };
  }

  function rememberCapturedRequestTemplate(url, method, headers, bodyText) {
    const kind = requestKindFromUrl(url);
    if (!kind) return;
    const slot = requestSlot(kind);
    const template = createRequestTemplate(url, method, headers, bodyText, "captured");
    if (!slot || !template) return;
    rememberWebTabIdFromUrl(template.url);
    slot.captured = template;
    saveCache();
  }

  function rememberRequestOutcome(request, outcome, error = null) {
    const kind = request?.kind || requestKindFromUrl(request?.url);
    if (!kind) return;
    const slot = requestSlot(kind);
    const template = createRequestTemplate(
      request.url,
      request.method,
      request.headers,
      request.bodyText || "",
      outcome
    );
    if (!slot || !template) return;
    if (outcome === "success") {
      rememberWebTabIdFromUrl(template.url);
      slot.success = template;
    } else if (outcome === "failure") {
      slot.failure = {
        ...template,
        errorCategory: error?.category || "",
        errorMessage: error?.message || ""
      };
    } else {
      return;
    }
    saveCache();
  }

  function injectBridge() {
    if (document.getElementById(`${APP_ID}-bridge`)) return;
    const script = document.createElement("script");
    script.id = `${APP_ID}-bridge`;
    script.src = chrome.runtime.getURL("bridge.js");
    script.dataset.appId = APP_ID;
    script.dataset.eventName = BRIDGE_EVENT;
    (document.head || document.documentElement).appendChild(script);
  }

  function parsePrimitiveText(value) {
    if (value == null) return "";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value !== "string") return "";
    const text = stripStyleNoise(value.trim());
    if (!text) return "";
    const json = safeParseJson(text);
    if (json && json !== text) {
      return parseDoubaoContentPayload(json);
    }
    return isNoiseText(text) ? "" : text;
  }

  function parseDoubaoContentPayload(value, depth = 0, keyHint = "") {
    if (depth > 8 || value == null) return "";
    if (typeof value === "string") return parsePrimitiveText(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      return uniqueTextParts(value.map((item) => parseDoubaoContentPayload(item, depth + 1, keyHint)))
        .join("\n\n")
        .trim();
    }
    if (!isPlainObject(value)) return "";
    const preferredKeys = [
      "text",
      "content",
      "content_text",
      "text_content",
      "markdown",
      "plain_text",
      "message",
      "output",
      "value",
      "answer",
      "question",
      "prompt",
      "summary",
      "reasoning_content",
      "reasoning",
      "description",
      "desc",
      "caption",
      "quote",
      "selected_content",
      "display_text",
      "displayText",
      "artifact_text"
    ];
    const ignoredKeys = new Set([
      "id",
      "conversation_id",
      "message_id",
      "msg_id",
      "user_type",
      "create_time",
      "update_time",
      "ctime",
      "mtime",
      "url",
      "src",
      "download_url",
      "resource_id",
      "resource_version",
      "sequence_id",
      "trace_id",
      "token",
      "metadata",
      "meta",
      "ext",
      "extra",
      "header",
      "footer"
    ]);
    const parts = [];
    preferredKeys.forEach((key) => {
      if (value[key] == null) return;
      parts.push(parseDoubaoContentPayload(value[key], depth + 1, key));
    });
    Object.entries(value).forEach(([key, child]) => {
      if (preferredKeys.includes(key) || ignoredKeys.has(key)) return;
      if (typeof child === "string" && ["title", "subtitle", "label", "name"].includes(key)) {
        if (keyHint === "requirement_items" || keyHint === "content_block") {
          parts.push(parsePrimitiveText(child));
        }
        return;
      }
      if (child && typeof child === "object") {
        parts.push(parseDoubaoContentPayload(child, depth + 1, key));
      }
    });
    return uniqueTextParts(parts).join("\n\n").trim();
  }

  function previewJsonValue(value, state, depth = 0) {
    if (state.remaining <= 0) return "...";
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") {
      const text = value.length > 160 ? `${value.slice(0, 160)}...` : value;
      state.remaining -= text.length;
      return text;
    }
    if (typeof value !== "object") return String(value);
    if (state.seen.has(value)) return "[Circular]";
    if (depth >= 4) return "...";
    state.seen.add(value);
    if (Array.isArray(value)) {
      const items = value.slice(0, 8).map((item) => previewJsonValue(item, state, depth + 1));
      if (value.length > items.length) items.push(`... ${value.length - items.length} more items`);
      return items;
    }
    const entries = Object.entries(value);
    const output = {};
    entries.slice(0, 16).forEach(([key, child]) => {
      output[key] = previewJsonValue(child, state, depth + 1);
    });
    if (entries.length > 16) output.__truncated = `... ${entries.length - 16} more keys`;
    return output;
  }

  function previewJson(value, limit = 800) {
    const state = {
      remaining: Math.max(200, Number(limit || 800) * 2),
      seen: new WeakSet()
    };
    const text = (() => {
      try {
        return JSON.stringify(previewJsonValue(value, state), null, 2);
      } catch (error) {
        return String(value ?? "");
      }
    })();
    if (text.length <= limit) return text;
    return `${text.slice(0, limit).trimEnd()}\n...`;
  }

  function createTextPart(text, source = "") {
    return {
      type: "text",
      source,
      text: String(text || "").trim()
    };
  }

  function createAttachmentPart(attachment, source = "") {
    return {
      type: attachment.type === "image" ? "image" : "attachment",
      source,
      id: attachment.id || attachment.url || randomId(),
      name: attachment.name || "attachment",
      url: attachment.url || "",
      attachmentType: attachment.type || "file",
      imageVariant: attachment.imageVariant || "",
      imageGroupKey: attachment.imageGroupKey || "",
      imageReference: attachment.imageReference || "",
      sourceUrl: attachment.sourceUrl || ""
    };
  }

  function createStructuredPart(label, raw, source = "") {
    return {
      type: "structured",
      source,
      label: String(label || "structured").trim().replace(/[_\s]+/g, " "),
      preview: previewJson(raw)
    };
  }

  function partDedupKey(part) {
    if (!part || typeof part !== "object") return "";
    if (part.type === "text") return `text:${normalizeCompareText(part.text)}`;
    if (part.type === "image" || part.type === "attachment") {
      return `attachment:${part.url || part.name || part.id || ""}`;
    }
    if (part.type === "structured") {
      return `structured:${String(part.label || "").toLowerCase()}:${part.preview || ""}`;
    }
    return "";
  }

  function pushMessagePart(output, seen, part) {
    if (!part || typeof part !== "object") return;
    if (part.type === "text" && !String(part.text || "").trim()) return;
    if ((part.type === "image" || part.type === "attachment") && !String(part.url || "").trim()) return;
    if (part.type === "structured" && !String(part.preview || "").trim()) return;
    const key = partDedupKey(part);
    if (!key || seen.has(key)) return;
    seen.add(key);
    output.push(part);
  }

  function imageReferenceFromHint(value) {
    return /(^|[._#-])ref(?:erence)?_?(?:content|images?)(?:$|[._#-])/i.test(String(value || ""))
      ? "reference"
      : "";
  }

  function attachmentFromValue(value, keyHint = "", inheritedImageReference = "") {
    if (!isPlainObject(value)) return null;
    const url = value.url || value.src || value.download_url || value.downloadUrl || value.image_url || value.imageUrl || value.resize_url || value.resizeUrl;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
    const normalized = url.trim();
    const urlName = normalized.split(/[?#]/, 1)[0].split("/").pop();
    const name = value.name || value.file_name || value.filename || value.title || urlName || "attachment";
    const typeHint = `${keyHint} ${value.type || value.mime_type || value.mimeType || name}`.toLowerCase();
    return {
      id: value.id || value.file_id || normalized,
      name: String(name).trim() || "attachment",
      url: normalized,
      type: /image|png|jpg|jpeg|gif|webp|bmp|svg/.test(typeHint) ? "image" : "file",
      imageVariant: imageVariantFromHint(keyHint) || imageVariantFromUrl(normalized),
      imageReference: inheritedImageReference || imageReferenceFromHint(keyHint)
    };
  }

  function imageVariantFromHint(value) {
    const hint = String(value || "").trim().toLowerCase();
    if (hint.includes("image_ori")) return "image_ori";
    if (hint.includes("image_preview")) return "image_preview";
    if (hint.includes("image_thumb")) return "image_thumb";
    return "";
  }

  function imageVariantFromUrl(value) {
    const url = String(value || "").trim().toLowerCase();
    if (!url) return "";
    if (/(preview\.(png|jpe?g|webp|bmp|gif|svg|image)|~tplv-[^/?#]*-downsize\.|[/?&._~-]downsize[/?&._~-])/i.test(url)) return "image_preview";
    if (/~tplv-[^/?#]*-image-qvalue\./i.test(url)) return "image_preview";
    if (/~tplv-[^/?#]*-image_pre_watermark[^/?#]*\.heic([?#]|$)/i.test(url)) return "image_preview";
    if (/(^|[/?&._~-])(image_thumb|thumb|thumbnail)([/?&._~-]|$)/i.test(url)) return "image_thumb";
    if (/(^|[/?&._~-])image_preview([/?&._~-]|$)/i.test(url)) return "image_preview";
    if (/(^|[/?&._~-])image_ori([/?&._~-]|$)/i.test(url)) return "image_ori";
    if (/~tplv-[^/?#]*-image_raw\.(png|jpe?g|webp|bmp|gif|svg|image)([?#]|$)/i.test(url)) return "image_ori";
    if (/~tplv-[^/?#]*-image_dld_watermark[^/?#]*\.(png|jpe?g|webp|bmp|gif|svg|image)([?#]|$)/i.test(url)) return "image_ori";
    if (/~tplv-[^/?#]*-image\.(png|jpe?g|webp|bmp|gif|svg|image)([?#]|$)/i.test(url)) return "image_ori";
    if (/~tplv-[^/?#]*-image\.heic([?#]|$)/i.test(url)) return "image_ori";
    return "";
  }

  function imageVariantPriority(value) {
    return {
      image_ori: 3,
      image_preview: 2,
      image_thumb: 1
    }[String(value || "").trim().toLowerCase()] || 0;
  }

  function imageAttachmentPriority(attachment) {
    const url = String(attachment?.url || "");
    const sourceUrl = String(attachment?.sourceUrl || "");
    const hintUrl = sourceUrl || url;
    let priority = imageVariantPriority(attachment?.imageVariant || imageVariantFromUrl(hintUrl)) * 1000;
    if (!isExpiredSignedImageUrl(hintUrl)) priority += 60;
    if (typoraFriendlyImageUrl(url) || typoraFriendlyImageUrl(hintUrl) || /^data:image\//i.test(url)) priority += 120;
    if (/~tplv-[^/?#]*-image_raw\./i.test(hintUrl)) priority += 20;
    if (/~tplv-[^/?#]*-(?:heic|private)\.heic/i.test(hintUrl)) priority -= 25;
    return priority;
  }

  function stableAttachmentIdentity(value) {
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number") return String(value).trim();
    if (!isPlainObject(value)) return "";
    const directId = value.id || value.creation_id || value.creationId || value.uuid || value.key;
    if (directId != null && String(directId).trim()) return String(directId).trim();
    return "";
  }

  function imageGroupKeyFromValue(value, inheritedGroupKey = "") {
    if (!isPlainObject(value)) return inheritedGroupKey;
    const creationId = stableAttachmentIdentity(
      value.creation
      || value.creation_id
      || value.creationId
      || value.image_creation
      || value.imageCreation
    );
    return creationId ? `creation:${creationId}` : inheritedGroupKey;
  }

  function tryParseNestedJsonString(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || !/^[{[]/.test(trimmed)) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function shouldTraverseNestedJsonString(value, keyHint = "") {
    const hint = String(keyHint || "").toLowerCase();
    if (/(content|creation|instruction|template|attachment|media|image|ref)/i.test(hint)) return true;
    return typeof value === "string" && value.length < 1_000_000 && value.includes("https://");
  }

  function normalizeAttachments(attachments) {
    const output = [];
    const groupedImages = new Map();
    const seenUrls = new Set();

    (Array.isArray(attachments) ? attachments : []).filter(Boolean).forEach((attachment) => {
      const url = String(attachment?.url || "").trim();
      if (!url || seenUrls.has(url)) return;
      seenUrls.add(url);

      const groupKey = attachment.type === "image"
        ? String(attachment.imageGroupKey || imageResourceGroupKey(attachment) || "").trim()
        : "";
      if (!groupKey) {
        output.push(attachment);
        return;
      }

      const existingIndex = groupedImages.get(groupKey);
      if (existingIndex == null) {
        groupedImages.set(groupKey, output.length);
        output.push(attachment);
        return;
      }

      const existing = output[existingIndex];
      if (imageAttachmentPriority(attachment) > imageAttachmentPriority(existing)) {
        output[existingIndex] = attachment;
      }
    });

    return output;
  }

  function normalizedImageResourcePath(value) {
    const url = String(value || "").trim();
    if (!url) return "";
    try {
      const parsed = new URL(url);
      return normalizeDoubaoImageResourcePath(parsed.pathname, parsed.hostname);
    } catch (_error) {
      return normalizeDoubaoImageResourcePath(url
        .split(/[?#]/, 1)[0]
        .replace(/^https?:\/\/[^/]+/i, ""));
    }
  }

  function normalizeDoubaoImageResourcePath(pathname, hostname = "") {
    const withoutVariantSuffix = String(pathname || "").replace(/~tplv-[^/]+$/i, "").replace(/^\/+/, "");
    const shouldCollapsePreview = /(byteimg|imagex-sign|tos-cn-|ocean-cloud-tos|a9rns2rl98)/i.test(`${hostname} ${withoutVariantSuffix}`);
    return shouldCollapsePreview
      ? withoutVariantSuffix.replace(/([a-f0-9]{16,})preview(?=\.(png|jpe?g|webp|bmp|gif|svg|image)$)/i, "$1")
      : withoutVariantSuffix;
  }

  function imageResourceGroupKey(attachment) {
    const resourcePath = normalizedImageResourcePath(attachment?.sourceUrl || attachment?.url);
    return resourcePath ? `resource:${resourcePath}` : "";
  }

  function imageResourceGroupKeyFromStructuredValue(value) {
    if (!isPlainObject(value)) return "";
    const raw = value.uri || value.key || value.img_uri || value.image_uri || value.resource_uri || value.resource_key;
    const resourcePath = normalizedImageResourcePath(raw);
    return resourcePath ? `resource:${resourcePath}` : "";
  }

  function collectAttachments(value, output, seen, depth = 0, keyHint = "", inheritedGroupKey = "", inheritedImageReference = "") {
    if (depth > 8 || value == null) return;
    const imageReference = inheritedImageReference || imageReferenceFromHint(keyHint);
    if (Array.isArray(value)) {
      value.forEach((item) => collectAttachments(item, output, seen, depth + 1, keyHint, inheritedGroupKey, imageReference));
      return;
    }
    if (typeof value === "string") {
      if (!shouldTraverseNestedJsonString(value, keyHint)) return;
      const parsed = tryParseNestedJsonString(value);
      if (parsed) collectAttachments(parsed, output, seen, depth + 1, `${keyHint}#json`, inheritedGroupKey, imageReference);
      return;
    }
    if (!isPlainObject(value)) return;
    const imageGroupKey = imageResourceGroupKeyFromStructuredValue(value) || imageGroupKeyFromValue(value, inheritedGroupKey);

    const attachment = attachmentFromValue(value, keyHint, imageReference);
    if (attachment) {
      const key = attachment.url;
      if (!seen.has(key)) {
        seen.add(key);
        output.push({
          ...attachment,
          imageGroupKey: attachment.type === "image" ? imageGroupKey : ""
        });
      }
    }

    Object.entries(value).forEach(([key, child]) => {
      if (!child || (typeof child !== "object" && typeof child !== "string")) return;
      collectAttachments(child, output, seen, depth + 1, key, imageGroupKey, imageReference);
    });
  }

  function extractAttachments(message) {
    const attachments = [];
    const seen = new Set();
    [
      message?.attachments,
      message?.files,
      message?.images,
      message?.content_block,
      safeParseJson(message?.content),
      message?.ext
    ].forEach((value) => collectAttachments(value, attachments, seen, 0, ""));
    return normalizeAttachments(attachments);
  }

  function structuredPartLabel(value, keyHint = "") {
    if (value?.text_block || value?.content?.text_block) return "text block";
    if (value?.attachment_block || value?.content?.attachment_block) return "attachment";
    if (value?.rich_media_block || value?.content?.rich_media_block || value?.creations || value?.creation) return "image";
    const explicit = String(
      value?.type
      || value?.block_type
      || value?.content_type
      || value?.card_type
      || value?.tool_type
      || ""
    ).trim().toLowerCase();
    if (explicit) return explicit;
    const specialKeys = [
      "artifact",
      "cells",
      "tool_call",
      "tool_calls",
      "reference",
      "references",
      "quote",
      "citation",
      "card",
      "cards",
      "content_block"
    ];
    const matchedKey = specialKeys.find((key) => value?.[key] != null);
    if (matchedKey) return matchedKey;
    const normalizedHint = String(keyHint || "").trim().toLowerCase();
    if (specialKeys.includes(normalizedHint)) return normalizedHint;
    if (normalizedHint === "content") return "";
    return "";
  }

  function shouldCaptureStructuredPart(value, keyHint = "") {
    if (!isPlainObject(value)) return false;
    if (attachmentFromValue(value, keyHint)) return false;
    if ((value?.text_block || value?.content?.text_block) && !value?.artifact && !value?.cells && !value?.tool_call && !value?.tool_calls && !value?.card && !value?.cards) {
      return false;
    }
    const label = structuredPartLabel(value, keyHint);
    if (!label && String(keyHint || "").trim().toLowerCase() !== "content_block") return false;
    const normalized = String(label || keyHint || "").trim().toLowerCase().replace(/[_\s]+/g, " ");
    if (["text", "markdown", "plain text", "rich text", "image", "attachment", "file"].includes(normalized)) {
      return false;
    }
    const preview = parseDoubaoContentPayload(value, 0, keyHint);
    return Boolean(preview || Object.keys(value).length);
  }

  function collectStructuredParts(value, output, seen, depth = 0, keyHint = "", source = "") {
    if (depth > 8 || value == null) return;
    if (Array.isArray(value)) {
      value.forEach((item) => collectStructuredParts(item, output, seen, depth + 1, keyHint, source));
      return;
    }
    if (!isPlainObject(value)) return;

    if (shouldCaptureStructuredPart(value, keyHint)) {
      pushMessagePart(output, seen, createStructuredPart(structuredPartLabel(value, keyHint) || keyHint || "structured", value, source || keyHint || "structured"));
    }

    Object.entries(value).forEach(([key, child]) => {
      if (!child || typeof child !== "object") return;
      collectStructuredParts(child, output, seen, depth + 1, key, source || keyHint || key);
    });
  }

  function messageTextFromParts(parts) {
    return dedupeRepeatedParagraphs(
      uniqueTextParts(
        (Array.isArray(parts) ? parts : [])
          .filter((part) => part?.type === "text")
          .map((part) => part.text)
      ).join("\n\n")
    );
  }

  function attachmentsFromParts(parts) {
    return normalizeAttachments((Array.isArray(parts) ? parts : [])
      .filter((part) => part?.type === "image" || part?.type === "attachment")
      .map((part) => ({
        id: part.id,
        name: part.name,
        url: part.url,
        type: part.attachmentType || (part.type === "image" ? "image" : "file"),
        imageVariant: part.imageVariant,
        imageGroupKey: part.imageGroupKey,
        imageReference: part.imageReference,
        sourceUrl: part.sourceUrl
      })));
  }

  function compactStructuredPartForRuntime(part) {
    if (!part || part.type !== "structured") return null;
    const preview = String(part.preview || "").trim() || previewJson(part.raw ?? part);
    if (!preview) return null;
    return {
      type: "structured",
      source: String(part.source || "").trim(),
      label: String(part.label || "structured").trim().replace(/[_\s]+/g, " ") || "structured",
      preview
    };
  }

  function messageNeedsRuntimeCompaction(message) {
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    return parts.some((part) => {
      if (!part || typeof part !== "object") return false;
      if (Object.prototype.hasOwnProperty.call(part, "raw")) return true;
      return part.type === "text" || part.type === "image" || part.type === "attachment";
    });
  }

  function compactMessageForRuntime(message) {
    if (!message || typeof message !== "object") return message;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const text = String(message.text || messageTextFromParts(parts) || "").trim();
    const attachments = Array.isArray(message.attachments) && message.attachments.length
      ? normalizeAttachments(message.attachments)
      : attachmentsFromParts(parts);
    const structuredParts = parts
      .map((part) => compactStructuredPartForRuntime(part))
      .filter(Boolean);
    return {
      ...message,
      text,
      parts: structuredParts,
      attachments
    };
  }

  function compactConversationForRuntime(conversation) {
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    if (!messages.length || !messages.some(messageNeedsRuntimeCompaction)) return conversation;
    return {
      ...conversation,
      messages: messages.map((message) => compactMessageForRuntime(message))
    };
  }

  function messageIndexValue(message, fallback = 0) {
    const candidates = [
      message?.index_in_conv,
      message?.indexInConv,
      message?.message_index,
      message?.messageIndex,
      message?.msg_index,
      message?.msgIndex,
      message?.turn_index,
      message?.turnIndex,
      message?.index,
      message?.order,
      message?.seq,
      message?.seq_id
    ];
    for (const candidate of candidates) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
    return Number(fallback || 0) || 0;
  }

  function deriveStableMessageId(message, index, role = "assistant") {
    const directId = [
      message?.message_id,
      message?.msg_id,
      message?.id,
      message?.message_uuid,
      message?.uuid,
      message?.client_message_id,
      message?.local_message_id
    ].find((value) => String(value || "").trim());
    if (directId) return String(directId).trim();
    const messageIndex = messageIndexValue(message, index + 1);
    const createTime = messageTimestampValue(message);
    const conversationId = String(message?.conversation_id || message?.conv_id || message?.section_id || "").trim() || "unknown";
    return ["fallback", role, conversationId, messageIndex || 0, createTime || 0].join("_");
  }

  function buildMessageParts(message, role) {
    const output = [];
    const seen = new Set();
    const orderedSources = [
      { value: message?.content_block, keyHint: "content_block", source: "content_block" },
      { value: safeParseJson(message?.content) ?? message?.content, keyHint: "content", source: "content" },
      { value: message?.tts_content, keyHint: "tts", source: "tts" }
    ];

    orderedSources.forEach(({ value, keyHint, source }) => {
      const text = parseDoubaoContentPayload(value, 0, keyHint);
      if (text) {
        pushMessagePart(output, seen, createTextPart(text, source));
      }
      collectStructuredParts(value, output, seen, 0, keyHint, source);
    });

    extractAttachments(message).forEach((attachment) => {
      pushMessagePart(output, seen, createAttachmentPart(attachment, "attachment"));
    });

    return output;
  }

  function looksLikeSingleChainMessage(value) {
    if (!isPlainObject(value)) return false;
    return Boolean(
      value.message_id
      || value.msg_id
      || value.id
      || value.message_uuid
      || value.uuid
      || value.role
      || value.author_role
      || value.sender_type
      || value.user_type != null
      || value.content_block
      || value.content
      || value.index_in_conv
      || value.index
    );
  }

  function singleChainMessageArrayFromPayload(payload) {
    return singleChainMessageArrayInfo(payload).messages;
  }

  function singleChainRegenMessagesFromPayload(payload) {
    const directCandidates = [
      payload?.downlink_body?.pull_singe_chain_downlink_body?.regen_messages,
      payload?.downlink_body?.pull_singe_chain_downlink_body?.regenMessages,
      payload?.data?.regen_messages,
      payload?.data?.regenMessages,
      payload?.regen_messages,
      payload?.regenMessages
    ];
    const direct = directCandidates.find((candidate) => Array.isArray(candidate) || isPlainObject(candidate));
    if (direct) return Object.values(direct).filter(looksLikeSingleChainMessage);

    const queue = [payload];
    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== "object") continue;
      const candidate = current.regen_messages || current.regenMessages;
      if (Array.isArray(candidate) || isPlainObject(candidate)) {
        return Object.values(candidate).filter(looksLikeSingleChainMessage);
      }
      Object.values(current).forEach((child) => {
        if (child && typeof child === "object") queue.push(child);
      });
    }
    return [];
  }

  function singleChainMessageArrayInfo(payload) {
    const directCandidates = [
      { location: "downlink.messages", value: payload?.downlink_body?.pull_singe_chain_downlink_body?.messages },
      { location: "downlink.message_list", value: payload?.downlink_body?.pull_singe_chain_downlink_body?.message_list },
      { location: "downlink.messageList", value: payload?.downlink_body?.pull_singe_chain_downlink_body?.messageList },
      { location: "data.messages", value: payload?.data?.messages },
      { location: "data.message_list", value: payload?.data?.message_list },
      { location: "data.messageList", value: payload?.data?.messageList },
      { location: "messages", value: payload?.messages },
      { location: "message_list", value: payload?.message_list },
      { location: "messageList", value: payload?.messageList }
    ];
    const direct = directCandidates.find((candidate) => Array.isArray(candidate.value));
    if (direct) return { location: direct.location, messages: direct.value };

    const queue = [payload];
    const messageKeys = ["messages", "message_list", "messageList"];
    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== "object") continue;
      for (const key of messageKeys) {
        const candidate = current[key];
        if (Array.isArray(candidate) && (!candidate.length || candidate.some(looksLikeSingleChainMessage))) {
          return { location: `nested.${key}`, messages: candidate };
        }
      }
      Object.values(current).forEach((child) => {
        if (child && typeof child === "object") queue.push(child);
      });
    }
    return { location: "missing", messages: [] };
  }

  function rawMessageId(message) {
    return String(
      message?.message_id
      || message?.msg_id
      || message?.id
      || message?.message_uuid
      || message?.uuid
      || ""
    ).trim();
  }

  function messageStatusValue(message) {
    const candidates = [
      message?.status,
      message?.status_v2,
      message?.statusV2,
      message?.message_status,
      message?.messageStatus
    ];
    for (const candidate of candidates) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric)) return numeric;
    }
    return 0;
  }

  function visibleRegenMessageIds(message) {
    const output = new Set();
    const list = Array.isArray(message?.regen_msg_list)
      ? message.regen_msg_list
      : Array.isArray(message?.regenMsgList) ? message.regenMsgList : [];
    list.forEach((item) => {
      if (!parseBooleanLike(item?.is_visible ?? item?.isVisible ?? item?.visible)) return;
      const ids = item?.msg_id_list
        || item?.msgIdList
        || item?.message_id_list
        || item?.messageIdList
        || item?.message_ids
        || item?.messageIds
        || [];
      (Array.isArray(ids) ? ids : [ids]).forEach((id) => {
        const text = String(id || "").trim();
        if (text) output.add(text);
      });
    });
    return output;
  }

  function regenRootId(message) {
    return String(
      message?.regen_root_id
      || message?.regenRootId
      || message?.root_message_id
      || message?.rootMessageId
      || ""
    ).trim();
  }

  function preferredRegenCandidate(candidates) {
    const list = Array.isArray(candidates) ? candidates : [];
    return list.find((candidate) => messageStatusValue(candidate) === 10)
      || list.find((candidate) => messageStatusValue(candidate) === 0)
      || list.find((candidate) => !HIDDEN_MESSAGE_STATUSES.has(messageStatusValue(candidate)))
      || null;
  }

  function compactLogId(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return text.length > 10 ? `...${text.slice(-10)}` : text;
  }

  function currentVisibleDomMessageIdSet() {
    try {
      return new Set(visibleDomMessageIds());
    } catch (error) {
      return new Set();
    }
  }

  function selectedRegenMessageFor(message, regenMessages, visibleDomIds = new Set()) {
    const rootId = rawMessageId(message);
    if (!rootId) return { message: null, reason: "" };
    const candidates = (Array.isArray(regenMessages) ? regenMessages : [])
      .filter((candidate) => regenRootId(candidate) === rootId);
    if (!candidates.length) return { message: null, reason: "" };

    const visibleIds = visibleRegenMessageIds(message);
    const result = (selected, reason) => ({
      message: selected,
      reason,
      candidateCount: candidates.length,
      visibleCount: visibleIds.size,
      domVisibleCount: visibleDomIds.size,
      statuses: candidates.map((candidate) => messageStatusValue(candidate)).join(",")
    });
    if (visibleDomIds.size) {
      const selected = candidates.find((candidate) => visibleDomIds.has(rawMessageId(candidate)));
      if (selected) return result(selected, "dom_visible");
    }
    if (visibleIds.size) {
      const selected = candidates.find((candidate) => visibleIds.has(rawMessageId(candidate)));
      if (selected) return result(selected, "visible_id");
    }

    const selected = preferredRegenCandidate(candidates);
    if (!selected) return { message: null, reason: "" };
    return result(selected, `status_${messageStatusValue(selected)}`);
  }

  function visibleRegenMessageFor(message, regenMessages) {
    return selectedRegenMessageFor(message, regenMessages).message;
  }

  function isHiddenSingleChainMessage(message) {
    if (regenRootId(message)) return false;
    return HIDDEN_MESSAGE_STATUSES.has(messageStatusValue(message));
  }

  function currentBranchRawMessages(rawMessages, payload) {
    const messages = Array.isArray(rawMessages) ? rawMessages : [];
    const regenMessages = [
      ...singleChainRegenMessagesFromPayload(payload),
      ...messages.filter((message) => regenRootId(message))
    ];
    const replacementRootIds = new Set();
    const replacements = new Map();
    const visibleDomIds = currentVisibleDomMessageIdSet();
    const regenStats = { selected: 0, dom_visible: 0, visible_id: 0, status_10: 0, status_0: 0, other: 0 };
    const regenSamples = [];
    messages.forEach((message) => {
      const selection = selectedRegenMessageFor(message, regenMessages, visibleDomIds);
      const selected = selection.message;
      if (!selected) return;
      const rootId = rawMessageId(message);
      replacementRootIds.add(rootId);
      replacements.set(rootId, { ...selected, status: 0 });
      regenStats.selected += 1;
      if (selection.reason === "dom_visible") regenStats.dom_visible += 1;
      else if (selection.reason === "visible_id") regenStats.visible_id += 1;
      else if (selection.reason === "status_10") regenStats.status_10 += 1;
      else if (selection.reason === "status_0") regenStats.status_0 += 1;
      else regenStats.other += 1;
      if (regenSamples.length < 8) {
        regenSamples.push({
          root: compactLogId(rootId),
          selected: compactLogId(rawMessageId(selected)),
          reason: selection.reason,
          candidateCount: selection.candidateCount || 0,
          visibleCount: selection.visibleCount || 0,
          domVisibleCount: selection.domVisibleCount || 0,
          statuses: selection.statuses || ""
        });
      }
    });
    if (regenStats.selected > 0) {
      addRuntimeLog("regen_branch_select", "已选择当前再生成分支", {
        ...regenStats,
        samples: regenSamples
      });
    }

    return messages
      .map((message) => {
        const replacement = replacements.get(rawMessageId(message));
        if (replacement) return replacement;
        const childRootId = regenRootId(message);
        if (childRootId && replacementRootIds.has(childRootId)) return null;
        return message;
      })
      .filter(Boolean)
      .filter((message) => !isHiddenSingleChainMessage(message));
  }

  function parseSingleChainMessages(payload) {
    const rawMessages = singleChainMessageArrayFromPayload(payload);
    if (!Array.isArray(rawMessages)) return [];

    const branchMessages = currentBranchRawMessages(rawMessages, payload);
    const built = branchMessages.map((message, index) => {
      const roleValue = String(message?.role || message?.author_role || message?.sender_type || message?.type || "").toLowerCase();
      const role = Number(message?.user_type) === 1
        ? "user"
        : roleValue.includes("user")
          ? "user"
          : roleValue.includes("system")
            ? "system"
            : "assistant";
      const parts = buildMessageParts(message, role);
      const text = messageTextFromParts(parts);
      const attachments = attachmentsFromParts(parts);
      const structuredParts = parts.filter((part) => part?.type === "structured");

      return {
        id: deriveStableMessageId(message, index, role),
        role,
        text,
        parts: structuredParts,
        attachments,
        metadata: {
          source: "network",
          index: messageIndexValue(message),
          createTime: messageTimestampValue(message)
        }
      };
    }).filter((message) => message.text || message.parts.length || message.attachments.length);

    return built.sort((a, b) => {
      const ai = Number(a.metadata?.index || 0);
      const bi = Number(b.metadata?.index || 0);
      if (ai !== bi) return ai - bi;
      const at = Number(a.metadata?.createTime || 0);
      const bt = Number(b.metadata?.createTime || 0);
      return at - bt;
    });
  }

  function findNestedScalar(value, keys, depth = 0) {
    if (depth > 7 || value == null) return "";
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findNestedScalar(item, keys, depth + 1);
        if (found) return found;
      }
      return "";
    }
    if (!isPlainObject(value)) return "";
    for (const key of keys) {
      const candidate = value[key];
      if (candidate == null) continue;
      const text = String(candidate).trim();
      if (text) return text;
    }
    for (const child of Object.values(value)) {
      if (!child || typeof child !== "object") continue;
      const found = findNestedScalar(child, keys, depth + 1);
      if (found) return found;
    }
    return "";
  }

  function findNestedNumber(value, keys, depth = 0) {
    const result = Number(findNestedScalar(value, keys, depth));
    return Number.isFinite(result) ? result : 0;
  }

  function directNumber(value, keys) {
    if (!isPlainObject(value)) return 0;
    for (const key of keys) {
      const result = Number(value[key]);
      if (Number.isFinite(result) && result > 0) return result;
    }
    return 0;
  }

  function rawRemoteMessageCountFromConversationItem(item) {
    return directNumber(item, ["message_count", "msg_count", "messageCount"]);
  }

  function remoteMessageCountFromConversationItem(item) {
    const count = rawRemoteMessageCountFromConversationItem(item);
    return count > 0 && count <= MAX_REASONABLE_REMOTE_MESSAGE_COUNT ? count : 0;
  }

  function objectKeysBrief(value, limit = 8) {
    if (!isPlainObject(value)) return "";
    const keys = Object.keys(value).slice(0, limit);
    return keys.length ? keys.join(",") : "";
  }

  function singleChainPayloadFromResponse(json) {
    return json?.downlink_body?.pull_singe_chain_downlink_body
      || json?.data
      || json
      || {};
  }

  function responseShapeLabel(json) {
    if (json?.downlink_body?.pull_singe_chain_downlink_body) return "downlink.pull_singe_chain_downlink_body";
    if (json?.data?.message_list) return "data.message_list";
    if (json?.data?.messages) return "data.messages";
    if (json?.message_list) return "message_list";
    if (json?.messages) return "messages";
    if (json?.downlink_body) return "downlink_body";
    if (json?.data) return "data";
    return "unknown";
  }

  function resolveConversationTitle(value, fallbackId = "") {
    const title = findNestedScalar(value, [
      "name",
      "title",
      "conversation_title",
      "conv_title",
      "chat_title",
      "session_title",
      "session_name",
      "topic",
      "summary",
      "display_title"
    ]);
    return title || (fallbackId ? `Conversation ${fallbackId}` : "");
  }

  function extractConversationInfo(payload) {
    const info = payload?.downlink_body?.get_conv_info_downlink_body?.conversation_info
      || payload?.data?.conversation_info
      || payload?.conversation_info
      || payload?.data?.conversation
      || null;
    if (!info || typeof info !== "object") return null;
    const id = String(info.conversation_id || info.conv_id || info.id || currentConversationId()).trim();
    if (!id) return null;
    return {
      id,
      title: resolveConversationTitle(info, id),
      url: currentConversationUrl(id),
      source: "doubao",
      captureState: "summary_only"
    };
  }

  function parseBooleanLike(value) {
    if (value === true || value === 1 || value === "1") return true;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      return normalized === "true" || normalized === "yes";
    }
    return false;
  }

  function extractConversationIdFromPayload(value, depth = 0) {
    if (depth > 6 || value == null) return "";
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = extractConversationIdFromPayload(item, depth + 1);
        if (found) return found;
      }
      return "";
    }
    if (!isPlainObject(value)) return "";
    const keys = ["conversation_id", "conv_id", "conversationId", "chat_id", "section_id"];
    for (const key of keys) {
      const candidate = String(value[key] || "").trim();
      if (candidate) return candidate;
    }
    for (const child of Object.values(value)) {
      if (!child || typeof child !== "object") continue;
      const found = extractConversationIdFromPayload(child, depth + 1);
      if (found) return found;
    }
    return "";
  }

  function extractRecentConversations(payload) {
    const direct = payload?.downlink_body?.pull_recent_conv_chain_downlink_body
      || payload?.downlink_body?.pull_recent_conv_downlink_body
      || payload?.data
      || {};
    const arrays = [
      direct.conversation_list,
      direct.conversations,
      payload?.data?.conversation_list,
      payload?.data?.conversations
    ].filter(Array.isArray);

    const output = [];
    const seen = new Set();
    const pushConversation = (item) => {
      if (!item || typeof item !== "object") return;
      const id = String(item.conversation_id || item.conv_id || item.conversationId || item.id || "").trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      const createdAt = findNestedNumber(item, ["create_time", "created_at", "createdAt", "create_timestamp"]);
      const updatedAt = findNestedNumber(item, ["update_time", "updated_at", "updatedAt", "update_timestamp", "sort_time"]);
      const rawMessageCount = rawRemoteMessageCountFromConversationItem(item);
      const messageCount = rawMessageCount > 0 && rawMessageCount <= MAX_REASONABLE_REMOTE_MESSAGE_COUNT
        ? rawMessageCount
        : 0;
      output.push({
        id,
        title: resolveConversationTitle(item, id) || `Conversation ${id}`,
        url: currentConversationUrl(id),
        source: "doubao",
        captureState: "summary_only",
        messageCount: messageCount > 0 ? messageCount : 0,
        messageCountRaw: messageCount > 0 ? 0 : rawMessageCount,
        messageCountSource: messageCount > 0 ? "remote" : rawMessageCount > 0 ? "remote_index_like" : "",
        createdAt: createdAt > 0 ? createdAt : 0,
        updatedAt: updatedAt > 0 ? updatedAt : createdAt > 0 ? createdAt : 0
      });
    };

    arrays.forEach((items) => items.forEach(pushConversation));

    if (!output.length) {
      const queue = [payload];
      while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== "object") continue;
        if (Array.isArray(current)) {
          current.forEach((item) => {
            if (item && typeof item === "object") queue.push(item);
          });
          continue;
        }
        pushConversation(current);
        Object.values(current).forEach((child) => {
          if (child && typeof child === "object") queue.push(child);
        });
      }
    }

    return output.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  function resolveRecentCursor(payload, pageConversations) {
    const directCursor = String(
      payload?.next_conv_version
      || payload?.nextConvVersion
      || payload?.next_cursor
      || payload?.nextCursor
      || payload?.cursor
      || payload?.conv_version
      || payload?.conversation_version
      || ""
    ).trim();
    if (directCursor) return directCursor;

    const oldestUpdated = [...(Array.isArray(pageConversations) ? pageConversations : [])]
      .map((item) => Number(item?.updatedAt || item?.createdAt || 0))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b)[0];
    if (Number.isFinite(oldestUpdated) && oldestUpdated > 0) {
      return String(oldestUpdated);
    }
    return "";
  }

  function normalizeConvVersion(cursor) {
    const text = String(cursor == null ? "" : cursor).trim();
    if (!text) return 0;
    if (/^\d+$/.test(text)) {
      const numeric = Number(text);
      return Number.isSafeInteger(numeric) ? numeric : text;
    }
    return text;
  }

  function deepReplaceConversationId(value, conversationId, parentKey = "") {
    if (value == null) return value;
    if (typeof value === "string" || typeof value === "number") {
      return /^(conversation_id|conv_id|conversationId|chat_id|section_id)$/i.test(parentKey)
        ? conversationId
        : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => deepReplaceConversationId(item, conversationId, parentKey));
    }
    if (!isPlainObject(value)) return value;
    const output = {};
    Object.entries(value).forEach(([key, child]) => {
      output[key] = deepReplaceConversationId(child, conversationId, key);
    });
    return output;
  }

  function recentResourceUrl(matcher) {
    try {
      const entries = performance.getEntriesByType("resource") || [];
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const name = normalizedUrl(entries[index]?.name || "");
        if (name && matcher(name)) return name;
      }
    } catch (error) {
      console.debug(`[${APP_ID}] read performance entries failed`, error);
    }
    return "";
  }

  function recentTrackedDoubaoUrl() {
    try {
      const entries = performance.getEntriesByType("resource") || [];
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const name = normalizedUrl(entries[index]?.name || "");
        if (!name) continue;
        if (isSingleChainUrl(name) || isRecentConversationUrl(name) || isConversationInfoUrl(name)) {
          return name;
        }
      }
    } catch (error) {
      console.debug(`[${APP_ID}] read tracked request url failed`, error);
    }
    return "";
  }

  function isUsableWebTabId(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    if (/^\d+$/.test(text)) return false;
    return true;
  }

  function extractWebTabId(url) {
    try {
      return new URL(url, location.origin).searchParams.get("web_tab_id") || "";
    } catch (error) {
      return "";
    }
  }

  function buildWebTabIdCandidates(seedUrl = "", preferredWebTabId = "") {
    const candidates = [];
    const seen = new Set();
    const push = (value, source) => {
      const text = String(value || "").trim();
      if (!isUsableWebTabId(text) || seen.has(text)) return;
      seen.add(text);
      candidates.push({ value: text, source });
    };

    push(preferredWebTabId, "retry");
    push(extractWebTabId(seedUrl), "template");
    push(extractWebTabId(location.href), "page");
    push(extractWebTabId(state.cache.requests.single?.success?.url), "single_success");
    push(extractWebTabId(state.cache.requests.recent?.success?.url), "recent_success");
    push(extractWebTabId(state.cache.requests.title?.success?.url), "title_success");
    push(state.cache.webTabId, "cache");
    push(loadStoredWebTabId(), "session");
    return candidates;
  }

  function withWebTabId(url, webTabId) {
    const parsed = new URL(url, location.origin);
    if (webTabId) {
      parsed.searchParams.set("web_tab_id", String(webTabId).trim());
    } else {
      parsed.searchParams.delete("web_tab_id");
    }
    return parsed.toString();
  }

  function ensureRequestUrl(rawUrl, fallbackPath, matcher, preferredWebTabId = "") {
    const safeFallbackPath = typeof fallbackPath === "string" && fallbackPath.trim()
      ? fallbackPath.trim()
      : matcher === isRecentConversationUrl
        ? "/im/chain/recent_conv"
        : matcher === isConversationInfoUrl
          ? "/im/conversation/info"
          : "/im/chain/single";
    let baseUrl = normalizedUrl(rawUrl) || recentResourceUrl(matcher);
    if (!baseUrl) {
      const relatedUrl = recentTrackedDoubaoUrl();
      if (relatedUrl) {
        const parsed = new URL(relatedUrl, location.origin);
        const useApiPrefix = parsed.pathname.startsWith("/api/") && !safeFallbackPath.startsWith("/api/");
        parsed.pathname = useApiPrefix ? `/api${safeFallbackPath}` : safeFallbackPath;
        baseUrl = parsed.toString();
      }
    }
    if (!baseUrl) {
      baseUrl = new URL(safeFallbackPath, location.origin).toString();
    }
    const candidates = buildWebTabIdCandidates(baseUrl, preferredWebTabId);
    const selected = candidates[0] || { value: randomId(), source: "generated" };
    return {
      url: withWebTabId(baseUrl, selected.value),
      webTabId: selected.value,
      webTabIdSource: selected.source,
      webTabIdCandidates: candidates
    };
  }

  function requestEndpointLabel(kind) {
    if (kind === "single") return "当前会话";
    if (kind === "recent") return "最近会话";
    if (kind === "title") return "会话标题";
    return "豆包请求";
  }

  function requestErrorCategoryLabel(category) {
    if (category === "template_missing") return "缺少请求模板";
    if (category === "parameter_missing") return "缺少必要参数";
    if (category === "empty_result") return "返回为空";
    if (category === "response_shape_changed") return "响应结构变化";
    if (category === "auth_or_rejected") return "请求被拒绝";
    if (category === "timeout") return "请求超时";
    if (category === "http_error") return "HTTP 错误";
    return "请求失败";
  }

  function createRequestError(category, request, message, details = {}) {
    const error = new Error(message);
    error.category = category;
    error.details = {
      endpoint: requestEndpointLabel(request?.kind),
      kind: request?.kind || "",
      templateSource: request?.templateSource || "",
      webTabIdSource: request?.webTabIdSource || "",
      ...details
    };
    return error;
  }

  function classifyResponseErrorCategory(request, response, json = null) {
    const status = Number(response?.status || 0);
    const text = String(json?.status_desc || json?.message || "").toLowerCase();
    if (request?.templateSource === "synthetic") return "template_missing";
    if (request?.webTabIdSource === "generated") return "parameter_missing";
    if (
      status === 401
      || status === 403
      || status === 419
      || /(login|auth|denied|forbidden|permission|expired|reject|risk|登录|鉴权|权限|拒绝|失效)/i.test(text)
    ) {
      return "auth_or_rejected";
    }
    if (status > 0) return "http_error";
    return "request_failed";
  }

  function finalizeRequestError(error, request, attempts = []) {
    const category = error?.category || "request_failed";
    const finalError = createRequestError(
      category,
      request,
      error?.message || `${requestEndpointLabel(request?.kind)} failed`,
      {
        ...(error?.details || {}),
        attempts
      }
    );
    return finalError;
  }

  function normalizeRuntimeLogDetail(value) {
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (value && typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch (error) {
        return String(value);
      }
    }
    return String(value);
  }

  function addRuntimeLog(type, message, details = {}) {
    if (!Array.isArray(state.runtime.logs)) state.runtime.logs = [];
    const entry = {
      at: new Date().toISOString(),
      type: String(type || "info"),
      message: String(message || "").trim(),
      details: Object.fromEntries(
        Object.entries(details || {})
          .filter(([, value]) => value != null && value !== "")
          .map(([key, value]) => [key, normalizeRuntimeLogDetail(value)])
      )
    };
    state.runtime.logs = [entry, ...state.runtime.logs].slice(0, MAX_RUNTIME_LOGS);
    state.runtime.lastSavedAt = entry.at;
    saveRuntimeState();
    syncFooterIfOpen();
  }

  function compactCount(value) {
    const count = Math.max(0, Number(value || 0) || 0);
    if (count >= 100000000) return `${(count / 100000000).toFixed(count >= 1000000000 ? 1 : 2).replace(/\.?0+$/g, "")}亿`;
    if (count >= 10000) return `${(count / 10000).toFixed(count >= 100000 ? 1 : 2).replace(/\.?0+$/g, "")}万`;
    return String(count);
  }

  function compactProgressMessage(progress, type = "refresh") {
    const page = Math.max(0, Number(progress?.page || 0) || 0);
    const loaded = Math.max(0, Number(progress?.loaded || 0) || 0);
    const expected = Math.max(0, Number(
      progress && Object.prototype.hasOwnProperty.call(progress, "expected")
        ? progress.expected
        : expectedMessageCountForConversation(currentConversationId())
    ) || 0);
    const prefix = type === "export" ? "导出准备" : "刷新中";
    const pieces = [prefix];
    if (page > 0) pieces.push(`第 ${page} 页`);
    if (loaded > 0) pieces.push(`${compactCount(loaded)} 条`);
    if (expected > 0) pieces.push(`共 ${compactCount(expected)} 条`);
    return pieces.join(" · ");
  }

  function requestBodyDiagnostics(request) {
    const body = safeParseJson(request?.bodyText || "");
    const kind = request?.kind || requestKindFromUrl(request?.url);
    if (!isPlainObject(body)) return {};
    if (kind === "single") {
      const pull = body?.uplink_body?.pull_singe_chain_uplink_body || {};
      return {
        conversationId: pull.conversation_id || "",
        anchorIndex: Number(pull.anchor_index || 0) || 0,
        cursorPresent: Boolean(String(pull.msg_cursor || "").trim()),
        limit: Number(pull.limit || 0) || 0,
        direction: Number(pull.direction || 0) || 0,
        conversationType: Number(pull.conversation_type || 0) || 0,
        requestCmd: Number(body.cmd || 0) || 0
      };
    }
    if (kind === "recent") {
      const pull = body?.uplink_body?.pull_recent_conv_chain_uplink_body || body?.uplink_body?.pull_recent_conv_uplink_body || {};
      return {
        limit: Number(pull.limit || 0) || 0,
        convVersion: Number(pull.conv_version || 0) || 0,
        direction: Number(pull.direction || 0) || 0,
        messageCountPerConv: Number(pull.message_count_per_conv || 0) || 0,
        requestCmd: Number(body.cmd || 0) || 0
      };
    }
    return {
      requestCmd: Number(body.cmd || 0) || 0
    };
  }

  function requestDiagnostics(request) {
    return {
      endpoint: requestEndpointLabel(request?.kind || requestKindFromUrl(request?.url)),
      path: readPathname(request?.url),
      pagePath: readPathname(request?.pageUrl || location.href),
      templateSource: request?.templateSource || "",
      webTabIdSource: request?.webTabIdSource || "",
      method: request?.method || "POST",
      ...requestBodyDiagnostics(request)
    };
  }

  function parseSingleChainPageResult(json, text = "") {
    const payload = singleChainPayloadFromResponse(json);
    const messageInfo = singleChainMessageArrayInfo(json);
    const messages = parseSingleChainMessages(json);
    const indexes = messages
      .map((message) => Number(message?.metadata?.index || 0))
      .filter((value) => Number.isFinite(value) && value > 0);
    const nextIndex = findNestedNumber(payload, [
      "next_index",
      "nextIndex",
      "next_anchor_index",
      "nextAnchorIndex",
      "next_message_index",
      "nextMessageIndex",
      "next_msg_index",
      "nextMsgIndex"
    ]);
    const nextCursor = findNestedScalar(payload, [
      "msg_cursor",
      "message_cursor",
      "messageCursor",
      "next_msg_cursor",
      "nextMsgCursor",
      "next_cursor",
      "nextCursor",
      "cursor"
    ]);
    return {
      messages,
      hasMore: parseBooleanLike(payload.has_more ?? payload.hasMore),
      nextCursor: String(nextCursor || "").trim(),
      nextIndex: Number.isFinite(nextIndex) && nextIndex > 0 ? nextIndex : 0,
      minIndex: indexes.length ? Math.min(...indexes) : 0,
      maxIndex: indexes.length ? Math.max(...indexes) : 0,
      responseShape: responseShapeLabel(json),
      payloadKeys: objectKeysBrief(payload),
      messageList: messageInfo.location,
      rawMessages: messageInfo.messages.length,
      parsedMessages: messages.length,
      responseBytes: String(text || "").length
    };
  }

  function singleChainDiagnosticsFromParsedPage(page) {
    return {
      responseShape: page?.responseShape || "",
      payloadKeys: page?.payloadKeys || "",
      messageList: page?.messageList || "",
      rawMessages: Number(page?.rawMessages || 0) || 0,
      parsedMessages: Number(page?.parsedMessages || 0) || 0,
      hasMore: Boolean(page?.hasMore),
      nextIndex: Number(page?.nextIndex || 0) || 0,
      nextCursorPresent: Boolean(String(page?.nextCursor || "").trim()),
      minIndex: Number(page?.minIndex || 0) || 0,
      maxIndex: Number(page?.maxIndex || 0) || 0,
      responseBytes: Number(page?.responseBytes || 0) || 0
    };
  }

  function singleChainResponseDiagnostics(json, text = "") {
    return singleChainDiagnosticsFromParsedPage(parseSingleChainPageResult(json, text));
  }

  function responseDiagnostics(request, json, text = "") {
    const kind = request?.kind || requestKindFromUrl(request?.url);
    if (kind === "single") return singleChainResponseDiagnostics(json, text);
    if (kind === "recent") {
      const conversations = extractRecentConversations(json);
      const payload = json?.downlink_body?.pull_recent_conv_chain_downlink_body
        || json?.downlink_body?.pull_recent_conv_downlink_body
        || json?.data
        || {};
      return {
        responseShape: responseShapeLabel(json),
        payloadKeys: objectKeysBrief(payload),
        conversations: conversations.length,
        hasMore: parseBooleanLike(payload.has_more ?? payload.hasMore),
        nextCursorPresent: Boolean(String(resolveRecentCursor(payload, conversations) || "").trim()),
        responseBytes: String(text || "").length
      };
    }
    return {
      responseShape: responseShapeLabel(json),
      responseBytes: String(text || "").length
    };
  }

  function setRuntimeRequestSuccess(request, diagnostics = {}) {
    state.runtime.lastRequestSuccess = {
      at: new Date().toISOString(),
      kind: request?.kind || "",
      endpoint: requestEndpointLabel(request?.kind),
      templateSource: request?.templateSource || "",
      webTabIdSource: request?.webTabIdSource || "",
      diagnostics
    };
    state.runtime.lastRequestError = null;
    addRuntimeLog("request_success", `${requestEndpointLabel(request?.kind)} 请求成功`, {
      ...requestDiagnostics(request),
      ...diagnostics
    });
    refreshUiIfOpen();
  }

  function setRuntimeRequestError(error, request, attempts = []) {
    const errorDetails = error?.details || {};
    state.runtime.lastRequestError = {
      at: new Date().toISOString(),
      kind: request?.kind || "",
      endpoint: requestEndpointLabel(request?.kind),
      category: error?.category || "",
      message: error?.message || "未知请求错误",
      attempts,
      templateSource: request?.templateSource || "",
      webTabIdSource: request?.webTabIdSource || ""
    };
    addRuntimeLog("request_error", `${requestEndpointLabel(request?.kind)} ${requestErrorCategoryLabel(error?.category)}`, {
      ...requestDiagnostics(request),
      category: error?.category || "",
      message: error?.message || "",
      attempts: attempts.length,
      lastAttempt: attempts.length ? attempts.at(-1)?.category || "" : "",
      lastAttemptMessage: attempts.length ? attempts.at(-1)?.message || "" : "",
      status: Number(errorDetails.status || 0) || "",
      statusCode: Number(errorDetails.statusCode || 0) || "",
      responseSample: runtimeLogSample(errorDetails.responseText || "", 180)
    });
    refreshUiIfOpen();
  }

  async function executeJsonRequest(request) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutId = controller
      ? window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      : 0;
    let response;
    try {
      response = await fetch(request.url, {
        method: request.method || "POST",
        credentials: "include",
        headers: request.headers || {},
        body: request.bodyText,
        ...(controller ? { signal: controller.signal } : {})
      });
    } catch (error) {
      if (timeoutId) window.clearTimeout(timeoutId);
      if (error?.name === "AbortError") {
        throw createRequestError(
          "timeout",
          request,
          `${requestEndpointLabel(request.kind)} 请求超时，请稍后重试或先导出已加载内容。`,
          {
            ...requestDiagnostics(request),
            timeoutMs: REQUEST_TIMEOUT_MS
          }
        );
      }
      throw error;
    }
    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (error?.name === "AbortError") {
        throw createRequestError(
          "timeout",
          request,
          `${requestEndpointLabel(request.kind)} 响应读取超时，请稍后重试或先导出已加载内容。`,
          {
            ...requestDiagnostics(request),
            timeoutMs: REQUEST_TIMEOUT_MS
          }
        );
      }
      throw error;
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
    }
    const json = safeParseJson(text);
    if (!response.ok) {
      const category = classifyResponseErrorCategory(request, response, json);
      throw createRequestError(
        category,
        request,
        `${requestEndpointLabel(request.kind)} ${requestErrorCategoryLabel(category)}: HTTP ${response.status}`,
        {
          ...requestDiagnostics(request),
          status: response.status,
          responseText: text.slice(0, 320)
        }
      );
    }
    if (!json || typeof json !== "object") {
      throw createRequestError(
        "response_shape_changed",
        request,
        `${requestEndpointLabel(request.kind)} response shape changed: non-JSON response`,
        {
          ...requestDiagnostics(request),
          responseText: text.slice(0, 320)
        }
      );
    }
    if (Number(json.status_code || 0) !== 0) {
      const category = classifyResponseErrorCategory(request, response, json);
      throw createRequestError(
        category,
        request,
        `${requestEndpointLabel(request.kind)} ${requestErrorCategoryLabel(category)}: ${json.status_desc || `status_code=${json.status_code}`}`,
        {
          ...requestDiagnostics(request),
          status: response.status,
          statusCode: json.status_code,
          responseText: text.slice(0, 320)
        }
      );
    }
    const parsedPage = request?.kind === "single" ? parseSingleChainPageResult(json, text) : null;
    const diagnostics = parsedPage
      ? singleChainDiagnosticsFromParsedPage(parsedPage)
      : responseDiagnostics(request, json, text);
    if (!request.skipPayloadCache) {
      handleResponsePayload(request.url, request.method || "POST", json);
    }
    return { json, text, diagnostics, parsedPage };
  }

  function buildSingleChainRequest(conversationId, options = {}) {
    const selected = selectRequestTemplate("single");
    const template = selected.template;
    const requestUrl = ensureRequestUrl(template?.url, "/im/chain/single", isSingleChainUrl, options.webTabId || "");
    const templateBody = safeParseJson(template?.bodyText || "");
    const body = templateBody && isPlainObject(templateBody)
      ? deepReplaceConversationId(templateBody, conversationId)
      : {
          cmd: 3100,
          uplink_body: {
            pull_singe_chain_uplink_body: {
              conversation_id: conversationId,
              anchor_index: Number.MAX_SAFE_INTEGER,
              conversation_type: 3,
              direction: 1,
              limit: SINGLE_CHAIN_DEFAULT_LIMIT,
              ext: {},
              filter: {
                index_list: []
              }
            }
          },
          sequence_id: randomId(),
          channel: 2,
          version: "1"
        };

    if (!isPlainObject(body.uplink_body)) body.uplink_body = {};
    if (!isPlainObject(body.uplink_body.pull_singe_chain_uplink_body)) {
      body.uplink_body.pull_singe_chain_uplink_body = {};
    }

    const pull = body.uplink_body.pull_singe_chain_uplink_body;
    pull.conversation_id = conversationId;
    pull.conversation_type = Number(pull.conversation_type || 3) || 3;
    pull.direction = 1;
    pull.limit = Math.max(1, Math.min(100, Number(options.limit || pull.limit || SINGLE_CHAIN_DEFAULT_LIMIT)));
    pull.anchor_index = Number.isFinite(Number(options.anchorIndex)) && Number(options.anchorIndex) > 0
      ? Number(options.anchorIndex)
      : Number.MAX_SAFE_INTEGER;
    if (options.cursor) {
      pull.msg_cursor = String(options.cursor);
    } else if ("msg_cursor" in pull) {
      delete pull.msg_cursor;
    }
    if (!isPlainObject(pull.ext)) pull.ext = {};
    if (!isPlainObject(pull.filter)) {
      pull.filter = { index_list: [] };
    }

    body.cmd = Number(body.cmd || 3100) || 3100;
    body.sequence_id = randomId();
    if (body.channel == null) body.channel = 2;
    if (body.version == null) body.version = "1";

    return {
      kind: "single",
      templateSource: selected.templateSource,
      pageUrl: normalizedUrl(location.href) || location.href,
      url: requestUrl.url,
      webTabId: requestUrl.webTabId,
      webTabIdSource: requestUrl.webTabIdSource,
      webTabIdCandidates: requestUrl.webTabIdCandidates,
      method: "POST",
      headers: sanitizeRequestHeaders(template?.headers || {}),
      bodyText: JSON.stringify(body)
    };
  }

  function buildRecentConversationsRequest(options = {}) {
    const selected = selectRequestTemplate("recent");
    const template = selected.template;
    const requestUrl = ensureRequestUrl(template?.url, "/im/chain/recent_conv", isRecentConversationUrl, options.webTabId || "");
    const templateBody = safeParseJson(template?.bodyText || "");
    const limit = Math.max(1, Math.min(100, Number(options.limit || RECENT_CONVERSATION_PAGE_LIMIT)));
    const page = Math.max(0, Number(options.page || 0));
    const cursor = normalizeConvVersion(options.cursor);
    const body = templateBody && isPlainObject(templateBody)
      ? JSON.parse(JSON.stringify(templateBody))
      : {
          cmd: 3200,
          uplink_body: {
            pull_recent_conv_chain_uplink_body: {
              limit,
              message_count_per_conv: 10,
              api_version: 1,
              conv_version: 0,
              direction: 3,
              option: {
                not_need_message: true,
                need_complete_conversation: true,
                need_coco_conversation: true,
                need_coco_bot: true,
                need_pc_pin_chain: true,
                pc_pin_query_type: 0
              }
            }
          },
          sequence_id: randomId(),
          channel: 2,
          version: "1"
        };

    if (!isPlainObject(body.uplink_body)) body.uplink_body = {};
    if (!isPlainObject(body.uplink_body.pull_recent_conv_chain_uplink_body)) {
      body.uplink_body.pull_recent_conv_chain_uplink_body = {};
    }

    const pull = body.uplink_body.pull_recent_conv_chain_uplink_body;
    if (!isPlainObject(pull.option)) pull.option = {};
    pull.limit = limit;
    pull.message_count_per_conv = Math.max(1, Math.min(20, Number(pull.message_count_per_conv || 10)));
    pull.api_version = Number(pull.api_version || 1) || 1;
    pull.conv_version = cursor;
    pull.direction = page > 0 ? 1 : Number(pull.direction || 3) || 3;
    pull.option.not_need_message = true;
    pull.option.need_complete_conversation = true;
    pull.option.need_pc_pin_chain = true;
    if (page > 0) {
      pull.option.need_coco_conversation = false;
      pull.option.need_coco_bot = false;
      pull.option.pc_pin_query_type = 1;
    } else {
      if (pull.option.need_coco_conversation == null) pull.option.need_coco_conversation = true;
      if (pull.option.need_coco_bot == null) pull.option.need_coco_bot = true;
      if (pull.option.pc_pin_query_type == null) pull.option.pc_pin_query_type = 0;
    }

    body.cmd = Number(body.cmd || 3200) || 3200;
    body.sequence_id = randomId();
    if (body.channel == null) body.channel = 2;
    if (body.version == null) body.version = "1";

    return {
      kind: "recent",
      templateSource: selected.templateSource,
      pageUrl: normalizedUrl(location.href) || location.href,
      url: requestUrl.url,
      webTabId: requestUrl.webTabId,
      webTabIdSource: requestUrl.webTabIdSource,
      webTabIdCandidates: requestUrl.webTabIdCandidates,
      method: "POST",
      headers: sanitizeRequestHeaders(template?.headers || {}),
      bodyText: JSON.stringify(body)
    };
  }

  async function requestJson(request) {
    let activeRequest = {
      ...request,
      kind: request.kind || requestKindFromUrl(request.url),
      webTabId: request.webTabId || extractWebTabId(request.url),
      webTabIdSource: request.webTabIdSource || (extractWebTabId(request.url) ? "request" : "generated")
    };
    const attempts = [];
    const seenWebTabIds = new Set([activeRequest.webTabId].filter(Boolean));
    const retryCandidates = Array.isArray(activeRequest.webTabIdCandidates)
      ? activeRequest.webTabIdCandidates
      : buildWebTabIdCandidates(activeRequest.url);

    for (let attemptIndex = 0; attemptIndex < MAX_REQUEST_ATTEMPTS; attemptIndex += 1) {
      try {
        const result = await executeJsonRequest(activeRequest);
        rememberRequestOutcome(activeRequest, "success");
        setRuntimeRequestSuccess(activeRequest, result?.diagnostics || {});
        return result;
      } catch (error) {
        const classified = finalizeRequestError(error, activeRequest, attempts);
        const detail = classified?.details || {};
        addRuntimeLog("request_attempt_error", `${requestEndpointLabel(activeRequest.kind)} 第 ${attemptIndex + 1} 次请求失败`, {
          ...requestDiagnostics(activeRequest),
          attempt: attemptIndex + 1,
          maxAttempts: MAX_REQUEST_ATTEMPTS,
          category: classified.category || "",
          message: classified.message || "",
          status: Number(detail.status || 0) || "",
          statusCode: Number(detail.statusCode || 0) || "",
          responseSample: runtimeLogSample(detail.responseText || "", 160)
        });
        attempts.push({
          attempt: attemptIndex + 1,
          webTabId: activeRequest.webTabId || "",
          webTabIdSource: activeRequest.webTabIdSource || "",
          category: classified.category || "",
          message: classified.message || "未知请求错误"
        });
        rememberRequestOutcome(activeRequest, "failure", classified);
        console.debug(`[${APP_ID}] request attempt failed`, {
          endpoint: requestEndpointLabel(activeRequest.kind),
          attempt: attemptIndex + 1,
          category: classified.category,
          message: classified.message,
          url: activeRequest.url
        });

        const retryable = activeRequest.kind === "single" || activeRequest.kind === "recent";
        const nextCandidate = retryCandidates.find((candidate) => candidate?.value && !seenWebTabIds.has(candidate.value));
        if (!retryable || !nextCandidate || attemptIndex + 1 >= MAX_REQUEST_ATTEMPTS) {
          const finalError = finalizeRequestError(classified, activeRequest, attempts);
          setRuntimeRequestError(finalError, activeRequest, attempts);
          throw finalError;
        }

        addRuntimeLog("request_retry", `${requestEndpointLabel(activeRequest.kind)} 更换 web_tab_id 后重试`, {
          ...requestDiagnostics(activeRequest),
          attempt: attemptIndex + 1,
          category: classified.category || "",
          nextWebTabIdSource: nextCandidate.source || "retry"
        });
        seenWebTabIds.add(nextCandidate.value);
        activeRequest = {
          ...activeRequest,
          url: withWebTabId(activeRequest.url, nextCandidate.value),
          webTabId: nextCandidate.value,
          webTabIdSource: nextCandidate.source || "retry"
        };
      }
    }
    const finalError = createRequestError("request_failed", activeRequest, `${requestEndpointLabel(activeRequest.kind)} request failed`);
    setRuntimeRequestError(finalError, activeRequest, attempts);
    throw finalError;
  }

  async function fetchConversationMessagesPage(conversationId, cursor = "", anchorIndex = null) {
    const request = buildSingleChainRequest(conversationId, {
      cursor,
      anchorIndex,
      limit: SINGLE_CHAIN_DEFAULT_LIMIT
    });
    request.skipPayloadCache = true;
    const { json, parsedPage } = await requestJson(request);
    return parsedPage || parseSingleChainPageResult(json);
  }

  function messageDedupKey(message) {
    return String(
      message?.id
      || `message_${message?.role}_${Number(message?.metadata?.index || 0)}_${Number(message?.metadata?.createTime || 0)}`
    );
  }

  function sortConversationMessages(messages) {
    return (Array.isArray(messages) ? messages : []).slice().sort((left, right) => {
      const leftIndex = Number(left?.metadata?.index || 0);
      const rightIndex = Number(right?.metadata?.index || 0);
      if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      const leftTime = Number(left?.metadata?.createTime || 0);
      const rightTime = Number(right?.metadata?.createTime || 0);
      return leftTime - rightTime;
    });
  }

  function mergeConversationMessages(primary, fallback) {
    const seen = new Set();
    const merged = [];
    [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(fallback) ? fallback : [])].forEach((message) => {
      const key = messageDedupKey(message);
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged.push(message);
    });
    return sortConversationMessages(merged);
  }

  function mergeDomMessagesWithCache(existingMessages, domMessages) {
    const existing = Array.isArray(existingMessages) ? existingMessages : [];
    const dom = Array.isArray(domMessages) ? domMessages : [];
    if (!existing.length) return dom.slice();
    if (!dom.length) return existing.slice();

    const output = existing.slice();
    const findOutputIndex = (key) => output.findIndex((message) => messageDedupKey(message) === key);
    dom.forEach((message, index) => {
      const key = messageDedupKey(message);
      if (!key || findOutputIndex(key) >= 0) return;

      let insertAt = -1;
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const previousIndex = findOutputIndex(messageDedupKey(dom[cursor]));
        if (previousIndex >= 0) {
          insertAt = previousIndex + 1;
          break;
        }
      }
      if (insertAt < 0) {
        for (let cursor = index + 1; cursor < dom.length; cursor += 1) {
          const nextIndex = findOutputIndex(messageDedupKey(dom[cursor]));
          if (nextIndex >= 0) {
            insertAt = nextIndex;
            break;
          }
        }
      }
      if (insertAt < 0) insertAt = output.length;
      output.splice(insertAt, 0, message);
    });

    return output.map((message, index) => ({
      ...message,
      metadata: {
        ...(message.metadata || {}),
        index: index + 1
      }
    }));
  }

  function shouldLogMessagePageDiagnostic(page, result, pageMessages, duplicatePage = false) {
    if (page <= 3) return true;
    if (duplicatePage) return true;
    if (!result?.hasMore || !pageMessages?.length) return true;
    return page % 10 === 0;
  }

  async function fetchAllConversationMessages(conversationId, title = "", url = "", options = {}) {
    const collected = [];
    const seen = new Set();
    const stopWhenSeenIds = options?.stopWhenSeenIds instanceof Set ? options.stopWhenSeenIds : null;
    const mergeBase = options?.mergeBase && typeof options.mergeBase === "object" ? options.mergeBase : null;
    const maxPages = Math.max(1, Number(options?.maxPages || MAX_SCAN_MESSAGE_PAGES) || MAX_SCAN_MESSAGE_PAGES);
    let cursor = "";
    let anchorIndex = null;
    let page = 0;
    let lastSignature = "";
    let fetchError = null;
    let reachedEnd = false;
    let stoppedAtKnownCache = false;
    const pagePace = createSingleChainPagePace();

    while (page < maxPages) {
      page += 1;
      let result;
      const pageStartedAt = nowMs();
      try {
        result = await fetchConversationMessagesPage(conversationId, cursor, anchorIndex);
        result.latencyMs = nowMs() - pageStartedAt;
      } catch (error) {
        updateSingleChainPagePace(pagePace, {
          error,
          latencyMs: nowMs() - pageStartedAt,
          pageMessages: 0
        });
        if (!collected.length) throw error;
        fetchError = error;
        addRuntimeLog("refresh_page_error", "当前对话分页请求失败，保留已加载内容", {
          conversationId,
          page,
          loaded: collected.length,
          requestAnchor: anchorIndex || "latest",
          requestCursorPresent: Boolean(cursor),
          latencyMs: pagePace.lastLatencyMs,
          speedMode: pagePace.mode,
          category: error?.category || "",
          message: error?.message || String(error || "")
        });
        console.debug(`[${APP_ID}] fetch page ${page} failed, keeping partial`, error);
        break;
      }
      const pageMessages = Array.isArray(result.messages) ? result.messages : [];
      const hasKnownCachedMessage = stopWhenSeenIds
        ? pageMessages.some((message) => stopWhenSeenIds.has(messageDedupKey(message)))
        : false;

      let added = 0;
      pageMessages.forEach((message) => {
        const key = messageDedupKey(message);
        if (seen.has(key)) return;
        seen.add(key);
        collected.push(message);
        added += 1;
      });
      if (typeof options?.onProgress === "function") {
        options.onProgress({
          page,
          maxPages,
          loaded: collected.length,
          pageMessages: pageMessages.length,
          hasMore: Boolean(result.hasMore)
        });
      }

      const pageSignature = `${pageMessages[0]?.id || ""}|${pageMessages.at(-1)?.id || ""}|${pageMessages.length}`;
      const duplicatePage = Boolean(pageSignature && pageSignature === lastSignature);
      updateSingleChainPagePace(pagePace, {
        latencyMs: result.latencyMs,
        pageMessages: pageMessages.length,
        duplicatePage
      });
      if (shouldLogMessagePageDiagnostic(page, result, pageMessages, duplicatePage)) {
        addRuntimeLog("refresh_page", "当前对话分页响应", {
          conversationId,
          page,
          loaded: collected.length,
          added,
          pageMessages: pageMessages.length,
          latencyMs: Math.round(Number(result.latencyMs || 0) || 0),
          speedMode: pagePace.mode,
          consecutiveSuccess: pagePace.consecutiveSuccess,
          rawMessages: result.rawMessages || 0,
          hasMore: Boolean(result.hasMore),
          requestAnchor: anchorIndex || "latest",
          requestCursorPresent: Boolean(cursor),
          responseShape: result.responseShape || "",
          messageList: result.messageList || "",
          minIndex: result.minIndex || 0,
          maxIndex: result.maxIndex || 0,
          nextIndex: result.nextIndex || 0,
          nextCursorPresent: Boolean(result.nextCursor),
          duplicatePage
        });
      }

      if (hasKnownCachedMessage && mergeBase?.full) {
        stoppedAtKnownCache = true;
        reachedEnd = true;
        addRuntimeLog("refresh_stop", "已命中本地完整缓存，停止增量刷新", {
          conversationId,
          page,
          loaded: collected.length,
          cacheMessages: Array.isArray(mergeBase?.messages) ? mergeBase.messages.length : 0
        });
        break;
      }
      if (!result.hasMore || !pageMessages.length) {
        reachedEnd = !result.hasMore && pageMessages.length > 0;
        addRuntimeLog("refresh_stop", pageMessages.length ? "接口报告没有更多消息" : "分页返回空消息，停止刷新", {
          conversationId,
          page,
          loaded: collected.length,
          pageMessages: pageMessages.length,
          hasMore: Boolean(result.hasMore),
          responseShape: result.responseShape || "",
          messageList: result.messageList || ""
        });
        break;
      }

      const nextCursor = String(result.nextCursor || "").trim();
      const computedAnchor = result.minIndex > 1 ? result.minIndex - 1 : 0;
      const anchorCandidates = [result.nextIndex, computedAnchor]
        .filter((value) => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) !== Number(anchorIndex || 0));
      const nextAnchorIndex = anchorCandidates.length ? Number(anchorCandidates[0]) : 0;
      if (nextAnchorIndex > 0) {
        const anchorSource = Number(result.nextIndex || 0) === nextAnchorIndex ? "response_next_index" : "computed_min_index";
        const delayMs = singleChainPageSleepMs(page, pagePace);
        if (page <= 3 || page % 10 === 0) {
          addRuntimeLog("refresh_next", "下一页使用消息索引锚点", {
            conversationId,
            page,
            nextAnchorIndex,
            anchorSource,
            delayMs,
            latencyMs: pagePace.lastLatencyMs,
            speedMode: pagePace.mode,
            consecutiveSuccess: pagePace.consecutiveSuccess,
            cursorCleared: true
          });
        }
        cursor = "";
        anchorIndex = nextAnchorIndex;
        lastSignature = pageSignature;
        await sleep(delayMs);
        continue;
      }

      if (!duplicatePage && nextCursor && nextCursor !== cursor) {
        const delayMs = singleChainPageSleepMs(page, pagePace);
        if (page <= 3 || page % 10 === 0) {
          addRuntimeLog("refresh_next", "下一页使用接口游标", {
            conversationId,
            page,
            nextCursorPresent: true,
            delayMs,
            latencyMs: pagePace.lastLatencyMs,
            speedMode: pagePace.mode,
            consecutiveSuccess: pagePace.consecutiveSuccess
          });
        }
        cursor = nextCursor;
        lastSignature = pageSignature;
        await sleep(delayMs);
        continue;
      }
      fetchError = createRequestError(
        "request_failed",
        { kind: "single", templateSource: selectRequestTemplate("single").templateSource },
        `当前对话仍有更多消息，但接口未返回可用的下一页位置，已保留前 ${collected.length} 条消息。`
      );
      addRuntimeLog("refresh_warning", "当前对话分页提前停止", {
        page,
        loaded: collected.length,
        pageMessages: pageMessages.length,
        hasMore: Boolean(result.hasMore),
        duplicatePage,
        nextCursor: nextCursor ? "present" : "missing",
        nextIndex: result.nextIndex || 0,
        minIndex: result.minIndex || 0,
        maxIndex: result.maxIndex || 0,
        responseShape: result.responseShape || "",
        messageList: result.messageList || ""
      });
      break;
    }
    if (page >= maxPages && !reachedEnd) {
      fetchError = createRequestError(
        "request_failed",
        { kind: "single", templateSource: selectRequestTemplate("single").templateSource },
        `当前对话超过单次刷新上限，已保留前 ${collected.length} 条消息。`
      );
    }

    const messages = stoppedAtKnownCache
      ? mergeConversationMessages(collected, mergeBase?.messages)
      : sortConversationMessages(collected);

    if (!messages.length) {
      throw createRequestError(
        "empty_result",
        { kind: "single", templateSource: selectRequestTemplate("single").templateSource },
        `${requestEndpointLabel("single")} returned no messages for conversation ${conversationId}`,
        {
          conversationId
        }
      );
    }

    const isFull = (!fetchError && reachedEnd) || Boolean(stoppedAtKnownCache && mergeBase?.full);
    addRuntimeLog(isFull ? "refresh_finish" : "refresh_partial", isFull ? "当前对话分页加载完成" : "当前对话仅加载到部分内容", {
      conversationId,
      pages: page,
      messages: messages.length,
      full: isFull,
      completeness: isFull ? "api_full" : "api_partial",
      reachedEnd,
      stoppedAtKnownCache,
      fetchErrorCategory: fetchError?.category || "",
      fetchErrorMessage: fetchError?.message || ""
    });
    return {
      id: conversationId,
      title: title || state.cache.summaries[conversationId]?.title || `Conversation ${conversationId}`,
      url: url || state.cache.summaries[conversationId]?.url || currentConversationUrl(conversationId),
      source: "api",
      full: isFull,
      captureState: isFull ? "full" : "partial",
      messages,
      refreshedIncrementally: stoppedAtKnownCache
    };
  }

  async function ensureConversationLoaded(conversationId, title = "", url = "", forceRefresh = false, options = {}) {
    if (!conversationId) return null;
    const existing = state.cache.conversations[conversationId];
    if (!forceRefresh && existing?.full && Array.isArray(existing.messages) && existing.messages.length) {
      addRuntimeLog("conversation_cache_hit", "使用本地完整缓存", {
        conversationId,
        messages: existing.messages.length,
        completeness: refreshCompletenessReason(existing),
        captureState: captureStateOfConversation(existing)
      });
      return existing;
    }

    addRuntimeLog("conversation_load_start", "开始加载会话详情", {
      conversationId,
      forceRefresh: Boolean(forceRefresh),
      existingMessages: Array.isArray(existing?.messages) ? existing.messages.length : 0,
      existingFull: Boolean(existing?.full),
      expectedMessageCount: expectedMessageCountForConversation(conversationId),
      expectedSource: state.cache.summaries?.[conversationId]?.messageCountSource || ""
    });
    updateSummary({
      id: conversationId,
      title: title || existing?.title || state.cache.summaries[conversationId]?.title || `Conversation ${conversationId}`,
      url: url || existing?.url || state.cache.summaries[conversationId]?.url || currentConversationUrl(conversationId)
    });

    try {
      const existingSeenIds = existing?.full && Array.isArray(existing.messages)
        ? new Set(existing.messages.map((message) => messageDedupKey(message)).filter(Boolean))
        : null;
      const conversation = await fetchAllConversationMessages(
        conversationId,
        title || existing?.title || state.cache.summaries[conversationId]?.title || "",
        url || existing?.url || state.cache.summaries[conversationId]?.url || "",
        {
          ...options,
          mergeBase: existing?.full ? existing : null,
          stopWhenSeenIds: existingSeenIds
        }
      );
      upsertConversation(conversation);
      addRuntimeLog("conversation_load_saved", "会话详情已写入缓存", {
        conversationId,
        messages: Array.isArray(conversation.messages) ? conversation.messages.length : 0,
        full: Boolean(conversation.full),
        completeness: refreshCompletenessReason(conversation),
        captureState: conversation.captureState || captureStateOfConversation(conversation)
      });
      return state.cache.conversations[conversationId] || conversation;
    } catch (error) {
      const expectedMessageCount = expectedMessageCountForConversation(conversationId);
      if (existing?.messages?.length && expectedMessageCount > 0 && existing.messages.length >= expectedMessageCount) {
        if (forceRefresh && !conversationHasVisibleDomMessages(existing)) {
          addRuntimeLog("conversation_load_recover_skip_stale", "本地缓存满足旧条数但缺少当前页面可见消息，跳过完整缓存恢复", {
            conversationId,
            existingMessages: existing.messages.length,
            expectedMessageCount,
            ...domMessageDiagnostics()
          });
        } else {
          addRuntimeLog("conversation_load_recover_full", "请求失败后使用已满足远端总数的本地缓存", {
            conversationId,
            existingMessages: existing.messages.length,
            expectedMessageCount,
            category: error?.category || "",
            message: error?.message || String(error || "")
          });
          upsertConversation({
            ...existing,
            id: conversationId,
            title: existing.title || title || state.cache.summaries[conversationId]?.title || `Conversation ${conversationId}`,
            url: existing.url || url || state.cache.summaries[conversationId]?.url || currentConversationUrl(conversationId),
            source: existing.source || "api",
            full: true,
            captureState: "full"
          });
          return state.cache.conversations[conversationId] || existing;
        }
      }
      markConversationFailure(conversationId, error, {
        title: title || existing?.title || state.cache.summaries[conversationId]?.title || `Conversation ${conversationId}`,
        url: url || existing?.url || state.cache.summaries[conversationId]?.url || currentConversationUrl(conversationId)
      });
      if (existing?.messages?.length) {
        const existingCaptureState = captureStateOfConversation(existing);
        const visibleDomCount = visibleDomMessageIds().length;
        const canReturnExisting = !forceRefresh
          || (visibleDomCount > 0 && existing.messages.length > visibleDomCount)
          || (!visibleDomCount && (existing.full || existingCaptureState === "full"));
        addRuntimeLog(canReturnExisting ? "conversation_load_fallback_cache" : "conversation_load_defer_dom", canReturnExisting ? "请求失败后返回本地已有缓存" : "请求失败且缓存不多于页面可见消息，交给页面 DOM 回退", {
          conversationId,
          existingMessages: existing.messages.length,
          existingFull: Boolean(existing.full),
          existingCaptureState,
          visibleDomMessages: visibleDomCount,
          forceRefresh: Boolean(forceRefresh),
          category: error?.category || "",
          message: error?.message || String(error || ""),
          ...domMessageDiagnostics()
        });
        if (canReturnExisting) return existing;
      }
      throw error;
    }
  }

  function handleResponsePayload(url, method, payload) {
    if (!payload || typeof payload !== "object") return;

    if (isRecentConversationUrl(url)) {
      extractRecentConversations(payload).forEach((summary) => updateSummary(summary));
      return;
    }

    if (isConversationInfoUrl(url)) {
      const info = extractConversationInfo(payload);
      if (info) updateSummary(info);
      return;
    }

    if (!isSingleChainUrl(url)) return;

    const payloadConversationId = extractConversationIdFromPayload(payload) || currentConversationId(url) || currentConversationId();
    if (!payloadConversationId) return;

    const messages = parseSingleChainMessages(payload);
    if (!messages.length) return;

    const downlink = singleChainPayloadFromResponse(payload);
    const existingSummary = state.cache.summaries[payloadConversationId];
    upsertConversation({
      id: payloadConversationId,
      title: existingSummary?.title || (payloadConversationId === currentConversationId() ? documentConversationTitle() : resolveConversationTitle(payload, payloadConversationId)),
      url: existingSummary?.url || currentConversationUrl(payloadConversationId),
      source: "network",
      full: !parseBooleanLike(downlink.has_more ?? downlink.hasMore),
      messages
    });
  }

  function handleBridgeMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== APP_ID || data.type !== BRIDGE_EVENT) return;
    const payload = data.payload;
    if (!payload || typeof payload !== "object") return;

    if (payload.kind === "request") {
      rememberCapturedRequestTemplate(payload.url, payload.method, payload.headers, payload.bodyText);
      return;
    }

    if (payload.kind === "download_result") {
      const requestId = String(payload.requestId || "");
      const pending = pendingDownloadRequests.get(requestId);
      if (!pending) return;
      pendingDownloadRequests.delete(requestId);
      window.clearTimeout(pending.timeoutId);
      if (payload.ok) {
        pending.resolve();
      } else {
        pending.reject(new Error(payload.message || "页面下载失败"));
      }
      return;
    }

    if (payload.kind === "response") {
      handleResponsePayload(payload.url, payload.method, payload.data);
    }
  }

  function isSidebarElement(element) {
    return Boolean(
      element?.closest?.(
        "nav[data-testid='chat_route_layout_leftside_nav'], aside, [data-testid*='leftside'], [data-testid*='sidebar'], [class*='left-side'], [class*='sidebar'], [class*='sider']"
      )
    );
  }

  function elementTextLength(element) {
    return normalizeCompareText(element?.innerText || element?.textContent || "").length;
  }

  function elementDescriptor(element) {
    if (!element) return "";
    const parts = [String(element.tagName || "").toLowerCase()].filter(Boolean);
    const id = String(element.id || element.getAttribute?.("id") || "").trim();
    const testId = String(element.getAttribute?.("data-testid") || "").trim();
    const targetId = String(element.getAttribute?.("data-target-id") || "").trim();
    const className = String(element.className || "").replace(/\s+/g, " ").trim();
    if (id) parts.push(`#${id}`);
    if (testId) parts.push(`[testid=${testId}]`);
    if (targetId) parts.push(`[target=${targetId}]`);
    if (className) parts.push(`.${className.slice(0, 48)}`);
    return parts.join("");
  }

  function safeElementRect(element) {
    try {
      const rect = element?.getBoundingClientRect?.();
      if (!rect) return null;
      return {
        left: Number(rect.left || 0),
        top: Number(rect.top || 0),
        right: Number(rect.right || 0),
        bottom: Number(rect.bottom || 0),
        width: Number(rect.width || 0),
        height: Number(rect.height || 0)
      };
    } catch (_error) {
      return null;
    }
  }

  function rectsOverlap(a, b) {
    if (!a || !b) return false;
    if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function computedOverflowY(element) {
    try {
      return window.getComputedStyle?.(element)?.overflowY || element?.style?.overflowY || "";
    } catch (_error) {
      return element?.style?.overflowY || "";
    }
  }

  function computedStyleValue(element, property, fallback = "") {
    try {
      return window.getComputedStyle?.(element)?.getPropertyValue?.(property) || fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function scrollElementInfo(element) {
    if (!element) return null;
    const scrollTop = Number(element.scrollTop || 0) || 0;
    const scrollHeight = Number(element.scrollHeight || 0) || 0;
    const clientHeight = Number(element.clientHeight || 0) || 0;
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    const canScroll = maxScrollTop > 2;
    return {
      element,
      descriptor: elementDescriptor(element),
      scrollTop,
      scrollHeight,
      clientHeight,
      maxScrollTop,
      canScroll,
      canScrollUp: canScroll && scrollTop > 2,
      canScrollDown: canScroll && scrollTop < maxScrollTop - 2,
      atTop: canScroll ? scrollTop <= 2 : true,
      atBottom: canScroll ? scrollTop >= maxScrollTop - 2 : true,
      overflowY: computedOverflowY(element)
    };
  }

  function findMessageScrollInfo(bestRootElement, rowSelector) {
    const candidates = [];
    const seen = new Set();
    const push = (element) => {
      if (!element || seen.has(element)) return;
      seen.add(element);
      candidates.push(element);
    };

    push(bestRootElement);
    let parent = bestRootElement?.parentElement || null;
    while (parent && parent !== document) {
      push(parent);
      parent = parent.parentElement;
    }
    push(document.scrollingElement || document.documentElement);
    push(document.body);

    const infos = candidates
      .map((element) => {
        const info = scrollElementInfo(element);
        if (!info) return null;
        const rowCount = element?.querySelectorAll ? element.querySelectorAll(rowSelector).length : 0;
        const overflowLooksScrollable = /(auto|scroll|overlay)/i.test(info.overflowY || "");
        return {
          ...info,
          rowCount,
          score: (rowCount * 1000) + (info.canScroll ? 100 : 0) + (overflowLooksScrollable ? 25 : 0) + Math.min(99, info.maxScrollTop)
        };
      })
      .filter(Boolean);

    return infos.sort((left, right) => right.score - left.score)[0] || null;
  }

  function pluginOverlayDiagnostics(messageRootElement) {
    const overlay = document.getElementById(`${APP_ID}-overlay`);
    const dialog = overlay?.querySelector?.(".dbx-dialog") || null;
    const trigger = document.getElementById(`${APP_ID}-trigger`);
    const rootRect = safeElementRect(messageRootElement);
    const dialogRect = safeElementRect(dialog);
    const triggerRect = safeElementRect(trigger);
    return {
      pluginPanelOpen: Boolean(dialog),
      pluginOverlayPointerEvents: overlay ? computedStyleValue(overlay, "pointer-events", String(overlay.style?.pointerEvents || "")) : "",
      pluginDialogOverlapsMessages: rectsOverlap(dialogRect, rootRect),
      pluginTriggerOverlapsMessages: rectsOverlap(triggerRect, rootRect)
    };
  }

  function domMessageDiagnostics() {
    try {
      const rootSelector = "[data-target-id='message-box-target-id'], [data-testid='message-list'], [data-testid='message-block-container'], [class*='message-list-']";
      const rowSelector = "[data-testid='send_message'], [data-testid='receive_message'], [data-message-id]";
      const roots = Array.from(document.querySelectorAll(rootSelector)).filter((element) => !isSidebarElement(element));
      const allRows = Array.from(document.querySelectorAll(rowSelector)).filter((row) => !isSidebarElement(row));
      const bestRoot = roots.reduce((best, element) => {
        const count = element.querySelectorAll(rowSelector).length;
        if (!best || count > best.count) return { element, count };
        return best;
      }, null);
      const bestRows = bestRoot ? Array.from(bestRoot.element.querySelectorAll(rowSelector)).filter((row) => !isSidebarElement(row)) : [];
      const messageScroll = findMessageScrollInfo(bestRoot?.element || null, rowSelector);
      const rootInfo = scrollElementInfo(bestRoot?.element || null);
      return {
        routeKind: conversationRouteKind(),
        rootCandidates: roots.length,
        bestRootRows: bestRows.length,
        bestRoot: elementDescriptor(bestRoot?.element),
        bestRootScrollTop: rootInfo?.scrollTop || 0,
        bestRootScrollHeight: rootInfo?.scrollHeight || 0,
        bestRootClientHeight: rootInfo?.clientHeight || 0,
        bestRootCanScroll: Boolean(rootInfo?.canScroll),
        messageScrollElement: messageScroll?.descriptor || "",
        messageScrollRows: Number(messageScroll?.rowCount || 0) || 0,
        messageScrollTop: Number(messageScroll?.scrollTop || 0) || 0,
        messageScrollHeight: Number(messageScroll?.scrollHeight || 0) || 0,
        messageScrollClientHeight: Number(messageScroll?.clientHeight || 0) || 0,
        messageScrollCanScroll: Boolean(messageScroll?.canScroll),
        messageScrollCanScrollUp: Boolean(messageScroll?.canScrollUp),
        messageScrollCanScrollDown: Boolean(messageScroll?.canScrollDown),
        messageScrollAtTop: Boolean(messageScroll?.atTop),
        messageScrollAtBottom: Boolean(messageScroll?.atBottom),
        messageScrollOverflowY: messageScroll?.overflowY || "",
        messageRows: allRows.length,
        nonEmptyRows: allRows.filter((row) => elementTextLength(row) > 0).length,
        sendRows: allRows.filter((row) => String(row?.getAttribute?.("data-testid") || "").toLowerCase() === "send_message").length,
        receiveRows: allRows.filter((row) => String(row?.getAttribute?.("data-testid") || "").toLowerCase() === "receive_message").length,
        dataMessageRows: allRows.filter((row) => row?.getAttribute?.("data-message-id")).length,
        ...pluginOverlayDiagnostics(bestRoot?.element || null)
      };
    } catch (error) {
      return {
        routeKind: conversationRouteKind(),
        domDiagnosticError: runtimeLogSample(error?.message || String(error || ""), 120)
      };
    }
  }

  function deriveRoleFromElement(row) {
    const testId = String(row?.getAttribute?.("data-testid") || "").toLowerCase();
    if (testId === "send_message") return "user";
    if (testId === "receive_message") return "assistant";
    if (row?.querySelector?.("[data-plugin-identifier*='receive']")) return "assistant";
    if (row?.querySelector?.("[data-plugin-identifier*='send']")) return "user";
    if (row?.querySelector?.("[data-foundation-type='receive-message-action-bar']")) return "assistant";
    const className = String(row?.className || "").toLowerCase();
    if (className.includes("justify-end")) return "user";
    if (/(assistant|bot|reply|answer)/i.test(className)) return "assistant";
    if (/(user|question|send)/i.test(className)) return "user";
    return "assistant";
  }

  function messageElementsFromDom() {
    const roots = Array.from(document.querySelectorAll("[data-target-id='message-box-target-id'], [data-testid='message-list'], [data-testid='message-block-container'], [class*='message-list-']"))
      .filter((element) => !isSidebarElement(element));
    const bestRoot = roots.reduce((best, element) => {
      const count = element.querySelectorAll("[data-testid='send_message'], [data-testid='receive_message'], [data-message-id]").length;
      if (!best || count > best.count) {
        return { element, count };
      }
      return best;
    }, null)?.element || document;

    let rows = Array.from(bestRoot.querySelectorAll("[data-testid='send_message'], [data-testid='receive_message']"))
      .filter((row) => !isSidebarElement(row));
    if (!rows.length) {
      rows = Array.from(bestRoot.querySelectorAll("[data-message-id]"))
        .filter((row) => !isSidebarElement(row))
        .filter((row) => {
          const parentRow = row.closest("[data-testid='send_message'], [data-testid='receive_message']");
          return !parentRow || parentRow === row;
        });
    }

    rows.sort((left, right) => {
      if (left === right) return 0;
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    return rows;
  }

  function visibleDomMessageIds() {
    return messageElementsFromDom()
      .map((row) => row.getAttribute("data-message-id") || row.querySelector("[data-message-id]")?.getAttribute("data-message-id") || "")
      .map((id) => String(id || "").trim())
      .filter(Boolean);
  }

  function conversationHasVisibleDomMessages(conversation) {
    const ids = visibleDomMessageIds();
    if (!ids.length) return true;
    const cachedIds = new Set((Array.isArray(conversation?.messages) ? conversation.messages : [])
      .map((message) => String(message?.id || "").trim())
      .filter(Boolean));
    return ids.every((id) => cachedIds.has(id));
  }

  function collectDomParts(row) {
    const output = [];
    const seen = new Set();
    const ignoredLine = /^(查看|复制|重试|分享|进入\s*AI\s*阅读|收起|展开|重新生成|点赞|点踩|继续|编辑|朗读|有帮助|没帮助)$/i;

    const pushText = (raw) => {
      const text = String(raw || "").trim();
      if (!text) return;
      const normalized = text
        .split(/\r?\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !ignoredLine.test(line) && !isNoiseText(line))
        .join("\n");
      const finalText = normalized.trim();
      if (!finalText) return;
      const key = normalizeCompareText(finalText);
      if (!key || seen.has(key)) return;
      seen.add(key);
      output.push(finalText);
    };

    const selectors = [
      "[data-testid='ref-content']",
      "[data-testid='message_text_content']",
      "[data-testid='message_content']",
      "[data-message-id]",
      ".flow-markdown-body",
      ".markdown",
      ".prose",
      ".whitespace-pre-wrap"
    ];
    selectors.forEach((selector) => {
      row.querySelectorAll(selector).forEach((element) => {
        pushText(element.innerText || element.textContent || "");
      });
    });

    if (!output.length) {
      pushText(row.innerText || row.textContent || "");
    }
    return output;
  }

  function buildDomConversation(options = {}) {
    const shouldLog = Boolean(options?.log);
    const reason = String(options?.reason || "current_view");
    if (shouldLog) {
      addRuntimeLog("dom_capture_start", "开始从页面 DOM 读取消息", {
        reason,
        conversationId: currentConversationId() || "",
        pagePath: readPathname(location.href),
        ...domMessageDiagnostics()
      });
    }
    const rows = messageElementsFromDom();
    if (!rows.length) {
      if (shouldLog) {
        addRuntimeLog("dom_capture_empty", "页面 DOM 没有找到消息行", {
          reason,
          conversationId: currentConversationId() || "",
          ...domMessageDiagnostics()
        });
      }
      return null;
    }
    const conversationId = currentConversationId() || `dom-${Date.now()}`;
    const messages = rows.map((row, index) => {
      const textParts = collectDomParts(row);
      const parts = textParts.map((text) => createTextPart(text, "dom"));
      return {
        id: row.getAttribute("data-message-id")
          || row.querySelector("[data-message-id]")?.getAttribute("data-message-id")
          || `dom-${conversationId}-${index + 1}`,
        role: deriveRoleFromElement(row),
        text: messageTextFromParts(parts),
        parts,
        attachments: [],
        metadata: {
          source: "dom",
          index: index + 1,
          createTime: 0
        }
      };
    }).filter((message) => message.text);

    if (!messages.length) {
      if (shouldLog) {
        addRuntimeLog("dom_capture_empty", "页面 DOM 找到消息行但没有可导出的文本", {
          reason,
          conversationId,
          rows: rows.length,
          ...domMessageDiagnostics()
        });
      }
      return null;
    }
    if (shouldLog) {
      addRuntimeLog("dom_capture_success", "页面 DOM 消息读取完成", {
        reason,
        conversationId,
        rows: rows.length,
        messages: messages.length,
        emptyRows: rows.length - messages.length,
        firstMessageId: messages[0]?.id || "",
        lastMessageId: messages.at(-1)?.id || "",
        ...domMessageDiagnostics()
      });
    }
    return {
      id: conversationId,
      title: documentConversationTitle(),
      url: normalizedUrl(location.href) || (currentConversationId() ? currentConversationUrl(conversationId) : location.href),
      source: "dom",
      full: false,
      captureState: "partial",
      messages
    };
  }

  function collectSidebarSummaries() {
    const anchors = Array.from(document.querySelectorAll("a[href*='/chat/']"))
      .filter((element) => isSidebarElement(element));
    const output = [];
    const seen = new Set();

    anchors.forEach((anchor) => {
      const href = anchor.getAttribute("href") || "";
      const url = normalizedUrl(new URL(href, location.origin).toString());
      const id = currentConversationId(url);
      if (!id || seen.has(id)) return;
      if (!isLoadableConversationId(id)) return;
      const title = String(anchor.textContent || "").replace(/\s+/g, " ").trim();
      if (!title || /^new chat$/i.test(title)) return;
      seen.add(id);
      const summary = {
        id,
        title,
        url: currentConversationUrl(id),
        source: "sidebar",
        captureState: "summary_only"
      };
      output.push(summary);
      updateSummary(summary);
    });

    return output;
  }

  function refreshCompletenessReason(conversation, apiError = null) {
    const captureState = captureStateOfConversation(conversation);
    if (captureState === "full" || conversation?.full) {
      if (conversation?.source === "api" || conversation?.source === "network") return "api_full";
      if (conversation?.refreshedIncrementally) return "api_incremental_full";
      return "cache_full";
    }
    if (apiError) return "api_failed_dom_partial";
    if (conversation?.source === "dom" || conversation?.source === "dom_fallback") return "dom_partial";
    return "not_full";
  }

  function isDomPartialConversation(conversation) {
    if (!conversation || conversation.full) return false;
    const source = String(conversation.source || "").trim();
    return source === "dom" || source === "dom_fallback";
  }

  function currentConversationSummaryShell(conversationId) {
    if (!conversationId) return null;
    const summary = state.cache.summaries?.[conversationId] || {};
    const messageCount = Number(summary.messageCount || 0) || 0;
    if (!messageCount && !summary.title && !summary.url) return null;
    return {
      id: conversationId,
      title: summary.title || documentConversationTitle() || `Conversation ${conversationId}`,
      url: summary.url || currentConversationUrl(conversationId),
      source: summary.source || "summary",
      full: summary.full === true,
      captureState: normalizeCaptureState(summary.captureState, messageCount, summary.full === true),
      messageCount,
      messages: []
    };
  }

  async function ensureCurrentConversationFresh(forceRefresh = false, options = {}) {
    collectSidebarSummaries();
    const conversationId = currentConversationId();
    const existing = conversationId ? state.cache.conversations[conversationId] : null;
    const domIdsBeforeRefresh = conversationId ? visibleDomMessageIds() : [];
    const existingCoversVisibleDom = !domIdsBeforeRefresh.length || conversationHasVisibleDomMessages(existing);
    if (conversationId) {
      updateSummary({
        id: conversationId,
        title: documentConversationTitle(),
        url: currentConversationUrl(conversationId),
        source: existing?.source || state.cache.summaries[conversationId]?.source || "doubao",
        messageCount: Array.isArray(existing?.messages) ? existing.messages.length : state.cache.summaries[conversationId]?.messageCount || 0
      });
    }

    if (!forceRefresh && existing?.full && existing.updatedAt) {
      const age = Date.now() - new Date(existing.updatedAt).getTime();
      if (age < CURRENT_FETCH_FRESH_MS && existingCoversVisibleDom) return existing;
      if (!existingCoversVisibleDom) {
        addRuntimeLog("conversation_cache_stale_dom", "完整缓存缺少当前页面可见消息，继续刷新合并", {
          conversationId,
          existingMessages: Array.isArray(existing?.messages) ? existing.messages.length : 0,
          visibleDomMessages: domIdsBeforeRefresh.length,
          missingVisibleDomMessages: domIdsBeforeRefresh.filter((id) => !new Set((existing?.messages || []).map((message) => String(message?.id || ""))).has(id)).length
        });
      }
    }

    let apiError = null;
    if (conversationId) {
      try {
        return await ensureConversationLoaded(
          conversationId,
          documentConversationTitle(),
          currentConversationUrl(conversationId),
          forceRefresh,
          options
        );
      } catch (error) {
        apiError = error;
        addRuntimeLog("current_refresh_api_failed", "接口刷新失败，准备尝试页面 DOM 回退", {
          conversationId,
          forceRefresh: Boolean(forceRefresh),
          existingMessages: Array.isArray(existing?.messages) ? existing.messages.length : 0,
          existingCaptureState: captureStateOfConversation(existing),
          category: error?.category || "",
          message: error?.message || String(error || ""),
          ...domMessageDiagnostics()
        });
        console.debug(`[${APP_ID}] refresh current conversation failed`, error);
      }
    }

    if (apiError && conversationId) {
      if (existing?.messages?.length && !isDomPartialConversation(existing)) {
        addRuntimeLog("current_refresh_api_failed_keep_cache", "接口失败，保留已有会话缓存", {
          conversationId,
          existingMessages: existing.messages.length,
          existingFull: Boolean(existing.full),
          existingCaptureState: captureStateOfConversation(existing),
          category: apiError?.category || "",
          message: apiError?.message || String(apiError || "")
        });
        return existing;
      }
      addRuntimeLog("current_refresh_api_failed_no_cache", "接口失败，未使用页面可见消息覆盖当前会话", {
        conversationId,
        existingMessages: Array.isArray(existing?.messages) ? existing.messages.length : 0,
        existingSource: existing?.source || "",
        category: apiError?.category || "",
        message: apiError?.message || String(apiError || ""),
        ...domMessageDiagnostics()
      });
      throw apiError;
    }

    const domConversation = buildDomConversation({
      log: Boolean(forceRefresh || apiError),
      reason: apiError ? "api_failed" : "current_view"
    });
    if (domConversation) {
      const previous = domConversation.id ? state.cache.conversations?.[domConversation.id] : null;
      const previousMessages = Array.isArray(previous?.messages) ? previous.messages : [];
      if (previousMessages.length > domConversation.messages.length) {
        addRuntimeLog("current_refresh_dom_fallback_skipped", "DOM 回退少于已有缓存，保留已有缓存", {
          conversationId: domConversation.id,
          domMessages: domConversation.messages.length,
          previousMessages: previousMessages.length,
          apiErrorCategory: apiError?.category || "",
          apiErrorMessage: apiError?.message || "",
          ...domMessageDiagnostics()
        });
        return previous;
      }
      const mergedMessages = mergeDomMessagesWithCache(previousMessages, domConversation.messages);
      const candidate = {
        ...previous,
        ...domConversation,
        source: apiError ? "dom_fallback" : domConversation.source,
        captureState: "partial",
        full: false,
        messages: mergedMessages
      };
      upsertConversation(candidate);
      const cached = state.cache.conversations[domConversation.id] || candidate;
      addRuntimeLog(apiError ? "current_refresh_dom_fallback_saved" : "current_refresh_dom_saved", apiError ? "接口失败后已保存 DOM 回退结果" : "已保存页面 DOM 结果", {
        conversationId: domConversation.id,
        domMessages: domConversation.messages.length,
        previousMessages: previousMessages.length,
        overlapMessages: previousMessages.filter((message) => {
          const key = messageDedupKey(message);
          return key && domConversation.messages.some((domMessage) => messageDedupKey(domMessage) === key);
        }).length,
        mergedMessages: Array.isArray(cached?.messages) ? cached.messages.length : mergedMessages.length,
        cacheMessages: Array.isArray(cached?.messages) ? cached.messages.length : 0,
        completeness: refreshCompletenessReason(cached, apiError),
        apiErrorCategory: apiError?.category || "",
        apiErrorMessage: apiError?.message || "",
        ...domMessageDiagnostics()
      });
      return cached;
    }
    if (apiError && existing?.messages?.length) {
      addRuntimeLog("current_refresh_cache_after_dom_empty", "接口失败且 DOM 无可用结果，继续使用旧缓存", {
        conversationId,
        existingMessages: existing.messages.length,
        existingCaptureState: captureStateOfConversation(existing),
        category: apiError?.category || "",
        message: apiError?.message || String(apiError || "")
      });
    }
    return existing || null;
  }

  function currentConversationView() {
    const conversationId = currentConversationId();
    const cached = conversationId ? state.cache.conversations[conversationId] : null;
    if (cached?.messages?.length && !isDomPartialConversation(cached)) return cached;
    if (conversationId) {
      return currentConversationSummaryShell(conversationId);
    }
    return buildDomConversation();
  }

  function cachedCurrentConversationForExport(value = state.dateRange) {
    const bounds = dateRangeBounds(value);
    if (bounds.invalid) return null;
    const conversationId = currentConversationId();
    const cached = conversationId ? state.cache.conversations[conversationId] : null;
    if (
      cached?.full
      && Array.isArray(cached.messages)
      && cached.messages.length
      && (conversationHasVisibleDomMessages(cached) || cached.messages.length > visibleDomMessageIds().length)
    ) {
      return cached;
    }
    return null;
  }

  function withFreshCurrentConversationTitle(conversation) {
    if (!conversation) return conversation;
    const title = preferSpecificTitle(conversation.title, documentConversationTitle());
    return title && title !== conversation.title ? { ...conversation, title } : conversation;
  }

  function expectedMessageCountForConversation(conversationId) {
    const count = Number(state.cache.summaries?.[conversationId]?.messageCount || 0);
    const source = String(state.cache.summaries?.[conversationId]?.messageCountSource || "");
    if (source === "loaded_partial") return 0;
    return Number.isFinite(count) && count > 0 ? count : 0;
  }

  function maybePromoteConversationToFull(conversation) {
    if (!conversation?.id || !Array.isArray(conversation.messages) || !conversation.messages.length) {
      return conversation;
    }
    const expectedMessageCount = expectedMessageCountForConversation(conversation.id);
    if (!conversation.full && expectedMessageCount > 0 && conversation.messages.length >= expectedMessageCount) {
      addRuntimeLog("conversation_promote_full", "已根据远端消息总数确认会话完整", {
        conversationId: conversation.id,
        messages: conversation.messages.length,
        expectedMessageCount
      });
      return {
        ...conversation,
        full: true,
        captureState: "full"
      };
    }
    return conversation;
  }

  function captureStateLabel(value) {
    if (value === "full") return "完整";
    if (value === "partial") return "部分";
    if (value === "summary_only") return "仅摘要";
    if (value === "failed") return "失败";
    return "未知";
  }

  function requestTemplateStatus(kind) {
    const slot = requestSlot(kind);
    if (slot?.captured) return "已捕获模板";
    if (slot?.success) return "已保存成功模板";
    return "合成回退模板";
  }

  function latestRuntimeStatus() {
    if (state.runtime.lastRequestError) return state.runtime.lastRequestError;
    if (state.runtime.lastRequestSuccess) return state.runtime.lastRequestSuccess;
    return null;
  }

  function roleLabel(role) {
    if (role === "user") return "用户";
    if (role === "system") return "系统";
    return "豆包";
  }

  function sanitizeImageMode(value) {
    return String(value || "").trim().toLowerCase() === "embed" ? "embed" : "strip";
  }

  function sanitizeTimestampMode(value) {
    return String(value || "").trim().toLowerCase() === "show" ? "show" : "hide";
  }

  function sanitizeFormat(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "json") return "json";
    if (normalized === "html") return "html";
    if (normalized === "txt" || normalized === "text") return "txt";
    return "md";
  }

  function sanitizeSplitMode(value) {
    return String(value || "").trim().toLowerCase() === "on" ? "on" : "off";
  }

  function sanitizeDateInput(value) {
    const text = String(value || "").trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return "";
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year
      || date.getMonth() !== month - 1
      || date.getDate() !== day
    ) {
      return "";
    }
    return text;
  }

  function normalizeDateRange(value = {}) {
    return {
      enabled: Boolean(value?.enabled),
      startDate: sanitizeDateInput(value?.startDate),
      endDate: sanitizeDateInput(value?.endDate)
    };
  }

  function dateInputToStartMs(value) {
    const text = sanitizeDateInput(value);
    if (!text) return 0;
    const [year, month, day] = text.split("-").map(Number);
    return new Date(year, month - 1, day).getTime();
  }

  function dateInputToExclusiveEndMs(value) {
    const text = sanitizeDateInput(value);
    if (!text) return 0;
    const [year, month, day] = text.split("-").map(Number);
    return new Date(year, month - 1, day + 1).getTime();
  }

  function dateRangeBounds(value = state.dateRange) {
    const range = normalizeDateRange(value);
    const active = range.enabled && Boolean(range.startDate || range.endDate);
    const startMs = range.startDate ? dateInputToStartMs(range.startDate) : 0;
    const endMs = range.endDate ? dateInputToExclusiveEndMs(range.endDate) : 0;
    const invalid = Boolean(active && startMs && endMs && startMs >= endMs);
    return {
      ...range,
      active,
      startMs,
      endMs,
      invalid
    };
  }

  function assertValidDateRange(value = state.dateRange) {
    const bounds = dateRangeBounds(value);
    if (bounds.enabled && !bounds.startDate && !bounds.endDate) {
      throw new Error("No date range selected");
    }
    if (bounds.invalid) {
      throw new Error("Invalid date range");
    }
    return bounds;
  }

  function dateRangeLabel(value = state.dateRange) {
    const bounds = dateRangeBounds(value);
    if (!bounds.active) return "";
    if (bounds.startDate && bounds.endDate) return `${bounds.startDate} 至 ${bounds.endDate}`;
    if (bounds.startDate) return `${bounds.startDate} 之后`;
    return `${bounds.endDate} 之前`;
  }

  function dateRangeFileToken(value = state.dateRange) {
    const bounds = dateRangeBounds(value);
    if (!bounds.active) return "";
    if (bounds.startDate && bounds.endDate) return `${bounds.startDate}_to_${bounds.endDate}`;
    if (bounds.startDate) return `from_${bounds.startDate}`;
    return `to_${bounds.endDate}`;
  }

  function filterMessagesByDateRange(messages, value = state.dateRange) {
    const bounds = dateRangeBounds(value);
    const source = Array.isArray(messages) ? messages : [];
    if (!bounds.active || bounds.invalid) return source.slice();
    return source.filter((message) => {
      const timestampMs = normalizeTimestampMs(messageTimestampValue(message));
      if (!timestampMs) return false;
      if (bounds.startMs && timestampMs < bounds.startMs) return false;
      if (bounds.endMs && timestampMs >= bounds.endMs) return false;
      return true;
    });
  }

  function applyDateRangeToConversation(conversation, value = state.dateRange) {
    if (!conversation || typeof conversation !== "object") return conversation;
    const bounds = dateRangeBounds(value);
    if (!bounds.active) return conversation;
    return {
      ...conversation,
      messages: filterMessagesByDateRange(conversation.messages, bounds)
    };
  }

  function normalizeTimestampMs(value) {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    if (numeric >= 1e17) return Math.round(numeric / 1e6);
    if (numeric >= 1e14) return Math.round(numeric / 1e3);
    if (numeric < 1e11) return Math.round(numeric * 1e3);
    return Math.round(numeric);
  }

  function messageTimestampValue(message) {
    const candidates = [
      message?.metadata?.createTime,
      message?.create_time,
      message?.ctime,
      message?.created_at,
      message?.createdAt,
      message?.create_timestamp,
      message?.timestamp
    ];
    for (const candidate of candidates) {
      const numeric = Number(candidate || 0);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
    return 0;
  }

  function formatMessageTimestamp(value) {
    const timestampMs = normalizeTimestampMs(value);
    if (!timestampMs) return "";
    const date = new Date(timestampMs);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (part) => String(part).padStart(2, "0");
    return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function normalizeMarkdownRenderOptions(options = {}) {
    return {
      imageMode: sanitizeImageMode(options?.imageMode),
      timestampMode: sanitizeTimestampMode(options?.timestampMode),
      embeddedAssets: options?.embeddedAssets instanceof Map ? options.embeddedAssets : null
    };
  }

  function normalizeMarkdownTextForExport(text) {
    const source = dedupeRepeatedParagraphs(text || "");
    if (!source) return "";

    const output = [];
    source.replace(/\r\n?/g, "\n").split("\n").forEach((line) => {
      const inlineMathMatch = line.match(/^\s+\$\$(.+?)\$\$\s*$/);
      if (inlineMathMatch?.[1]) {
        const formula = inlineMathMatch[1].trim();
        if (output.length && String(output[output.length - 1] || "").trim()) {
          output[output.length - 1] = String(output[output.length - 1]).replace(/\s+$/g, "") + " $" + formula + "$";
        } else {
          output.push("$" + formula + "$");
        }
        return;
      }
      output.push(line);
    });

    return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function markdownLinesFromMessageParts(message) {
    const dedupedText = normalizeMarkdownTextForExport(message?.text || "");
    if (dedupedText) return [dedupedText];

    const parts = Array.isArray(message?.parts) ? message.parts : [];
    const textParts = parts
      .filter((part) => part?.type === "text")
      .map((part) => part.text);
    const fallbackText = normalizeMarkdownTextForExport(uniqueTextParts(textParts).join("\n\n"));
    if (fallbackText) return [fallbackText];

    const structuredParts = parts
      .filter((part) => part?.type === "structured")
      .map((part) => {
        const label = String(part.label || "structured").trim() || "structured";
        const preview = normalizeMarkdownTextForExport(part.preview || "");
        return preview ? `> ${label}\n\n\`\`\`json\n${preview}\n\`\`\`` : "";
      })
      .filter(Boolean);
    return structuredParts;
  }

  function escapeMarkdownLinkText(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  }

  function attachmentDisplayName(attachment, fallback = "attachment") {
    const raw = String(attachment?.name || fallback || "attachment").trim();
    if (!raw) return fallback || "attachment";
    const source = /^https?:\/\//i.test(raw)
      ? (() => {
        try {
          return new URL(raw).pathname.split("/").pop() || raw;
        } catch (_error) {
          return raw;
        }
      })()
      : raw;
    const clean = source.split(/[?#]/, 1)[0].split("/").pop();
    return clean || raw || fallback || "attachment";
  }

  function messageAttachments(message) {
    if (Array.isArray(message?.attachments) && message.attachments.length) return normalizeAttachments(message.attachments);
    return attachmentsFromParts(message?.parts);
  }

  function rawMessageAttachments(message) {
    const output = [];
    const seenUrls = new Set();
    const push = (attachment) => {
      if (!attachment || typeof attachment !== "object") return;
      const url = String(attachment.url || "").trim();
      if (!url || seenUrls.has(url)) return;
      seenUrls.add(url);
      output.push({
        id: attachment.id,
        name: attachment.name,
        url,
        type: attachment.type || attachment.attachmentType || "file",
        imageVariant: attachment.imageVariant,
        imageGroupKey: attachment.imageGroupKey,
        imageReference: attachment.imageReference,
        sourceUrl: attachment.sourceUrl
      });
    };

    (Array.isArray(message?.attachments) ? message.attachments : []).forEach(push);
    (Array.isArray(message?.parts) ? message.parts : [])
      .filter((part) => part?.type === "image" || part?.type === "attachment")
      .forEach((part) => push({
        id: part.id,
        name: part.name,
        url: part.url,
        type: part.attachmentType || (part.type === "image" ? "image" : "file"),
        imageVariant: part.imageVariant,
        imageGroupKey: part.imageGroupKey,
        imageReference: part.imageReference,
        sourceUrl: part.sourceUrl
      }));

    return output;
  }

  function attachmentKindForMarkdown(attachment) {
    const explicitType = String(attachment?.type || attachment?.attachmentType || "").trim().toLowerCase();
    if (explicitType === "image") return "image";
    const name = String(attachment?.name || "").trim().toLowerCase();
    const url = String(attachment?.url || "").trim().toLowerCase();
    return /\.(png|jpg|jpeg|gif|webp|bmp|svg|image)(\?|#|$)/i.test(`${name} ${url}`) ? "image" : "file";
  }

  function markdownLinesFromAttachments(message, options = {}) {
    const renderOptions = normalizeMarkdownRenderOptions(options);
    const attachments = messageAttachments(message);

    return attachments
      .map((attachment) => {
        const originalUrl = String(attachment?.url || "").trim();
        if (!originalUrl) return "";
        const type = attachmentKindForMarkdown(attachment);
        if (type === "image" && shouldSkipImageAttachmentInMarkdown(message, attachment)) return "";
        if (type === "image" && renderOptions.imageMode === "strip") return "";
        if (type === "image" && attachment?.unavailable) {
          const label = escapeMarkdownLinkText(attachment?.name || "image");
          return `> 用户上传图片已失效，源站未返回可用文件：${label}`;
        }
        const url = type === "image" && renderOptions.embeddedAssets?.has(originalUrl)
          ? String(renderOptions.embeddedAssets.get(originalUrl) || "").trim()
          : originalUrl;
        if (!url) return "";
        const label = escapeMarkdownLinkText(attachmentDisplayName(attachment, type === "image" ? "image" : "attachment"));
        if (type === "image") return `![${label}](${url})`;
        return `[${label}](${url})`;
      })
      .filter(Boolean);
  }

  function renderMarkdownHeader(conversation) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const messageCount = messages.length || Number(conversation.messageCount || 0) || 0;
    return [
      `# ${conversation.title || "豆包会话"}`,
      "",
      `- 会话 ID：${conversation.id || ""}`,
      `- 消息数：${messageCount}`,
      `- 来源：${conversation.source || "未知"}（${captureStateLabel(captureStateOfConversation(conversation))}）`,
      `- 导出时间：${new Date().toISOString()}`,
      ""
    ];
  }

  function renderMarkdownMessages(messages, options = {}) {
    const renderOptions = normalizeMarkdownRenderOptions(options);
    const lines = [];
    (Array.isArray(messages) ? messages : []).forEach((message) => {
      const textLines = markdownLinesFromMessageParts(message);
      const attachmentLines = markdownLinesFromAttachments(message, renderOptions);
      const contentLines = textLines.length && attachmentLines.length
        ? [...textLines, "", ...attachmentLines]
        : [...textLines, ...attachmentLines];
      if (!contentLines.length) return;
      const messageTimestamp = renderOptions.timestampMode === "show"
        ? formatMessageTimestamp(messageTimestampValue(message))
        : "";
      lines.push(messageTimestamp ? `## ${roleLabel(message.role)} · ${messageTimestamp}` : `## ${roleLabel(message.role)}`);
      lines.push("");
      lines.push(...contentLines);
      lines.push("");
    });
    return lines.join("\n").trim();
  }

  function renderMarkdown(conversation, options = {}) {
    const header = renderMarkdownHeader(conversation);
    const body = renderMarkdownMessages(conversation.messages, options);
    if (body) header.push(body);
    return header.join("\n").trim() + "\n";
  }

  function textLinesFromMessageParts(message) {
    const dedupedText = normalizeMarkdownTextForExport(message?.text || "");
    if (dedupedText) return [dedupedText];

    const parts = Array.isArray(message?.parts) ? message.parts : [];
    const textParts = parts
      .filter((part) => part?.type === "text")
      .map((part) => part.text);
    const fallbackText = normalizeMarkdownTextForExport(uniqueTextParts(textParts).join("\n\n"));
    if (fallbackText) return [fallbackText];

    return parts
      .filter((part) => part?.type === "structured")
      .map((part) => {
        const label = String(part.label || "structured").trim() || "structured";
        const preview = normalizeMarkdownTextForExport(part.preview || "");
        return preview ? `${label}\n${preview}` : "";
      })
      .filter(Boolean);
  }

  function renderTextHeader(conversation) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const messageCount = messages.length || Number(conversation.messageCount || 0) || 0;
    return [
      `标题：${conversation.title || "豆包会话"}`,
      `会话 ID：${conversation.id || ""}`,
      `消息数：${messageCount}`,
      `来源：${conversation.source || "未知"}（${captureStateLabel(captureStateOfConversation(conversation))}）`,
      `导出时间：${new Date().toISOString()}`
    ];
  }

  function renderTextMessages(messages, options = {}) {
    const renderOptions = normalizeMarkdownRenderOptions({
      ...options,
      imageMode: "strip"
    });
    const lines = [];
    (Array.isArray(messages) ? messages : []).forEach((message) => {
      const contentLines = textLinesFromMessageParts(message);
      if (!contentLines.length) return;
      const messageTimestamp = renderOptions.timestampMode === "show"
        ? formatMessageTimestamp(messageTimestampValue(message))
        : "";
      lines.push(messageTimestamp ? `${roleLabel(message.role)} · ${messageTimestamp}` : roleLabel(message.role));
      lines.push(...contentLines);
      lines.push("");
    });
    return lines.join("\n").trim();
  }

  function messageHasTextExportableContent(message) {
    return textLinesFromMessageParts(message).length > 0;
  }

  function conversationForTextExport(conversation) {
    const source = Array.isArray(conversation?.messages) ? conversation.messages : [];
    return {
      ...conversation,
      messages: source.filter((message) => messageHasTextExportableContent(message))
    };
  }

  function renderText(conversation, options = {}) {
    const header = renderTextHeader(conversation);
    const body = renderTextMessages(conversation.messages, options);
    if (body) {
      header.push("", "----------------------------------------", "", body);
    }
    return header.join("\n").trim() + "\n";
  }

  function messageHasExportableContent(message, options = {}) {
    const renderOptions = normalizeMarkdownRenderOptions(options);
    return markdownLinesFromMessageParts(message).length > 0
      || markdownLinesFromAttachments(message, renderOptions).length > 0;
  }

  function conversationForExport(conversation, options = {}) {
    const source = Array.isArray(conversation?.messages) ? conversation.messages : [];
    const messages = source.filter((message) => messageHasExportableContent(message, options));
    return {
      ...conversation,
      messages
    };
  }

  function base64FromBytes(bytes) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let output = "";
    for (let index = 0; index < bytes.length; index += 3) {
      const first = bytes[index];
      const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
      const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
      const chunk = (first << 16) | (second << 8) | third;
      output += alphabet[(chunk >> 18) & 63];
      output += alphabet[(chunk >> 12) & 63];
      output += index + 1 < bytes.length ? alphabet[(chunk >> 6) & 63] : "=";
      output += index + 2 < bytes.length ? alphabet[chunk & 63] : "=";
    }
    return output;
  }

  function inferAttachmentMimeType(attachment, fallback = "") {
    const candidate = String(fallback || "").split(";")[0].trim().toLowerCase();
    if (candidate && candidate !== "application/octet-stream") return candidate;
    const hint = `${attachment?.name || ""} ${attachment?.url || ""}`.toLowerCase();
    if (/\.(png)(\?|#|$)/i.test(hint)) return "image/png";
    if (/\.(jpe?g)(\?|#|$)/i.test(hint)) return "image/jpeg";
    if (/\.(gif)(\?|#|$)/i.test(hint)) return "image/gif";
    if (/\.(webp)(\?|#|$)/i.test(hint)) return "image/webp";
    if (/\.(bmp)(\?|#|$)/i.test(hint)) return "image/bmp";
    if (/\.(svg)(\?|#|$)/i.test(hint)) return "image/svg+xml";
    if (/\.(image)(\?|#|$)/i.test(hint)) return "image/jpeg";
    return "image/png";
  }

  function isPublicSignedImageUrl(url) {
    return /(byteimg|imagex-sign|flow-imagex-sign|flow-sign|tos-cn-|ocean-cloud-tos|a9rns2rl98)/i.test(String(url || ""));
  }

  async function fetchAttachmentImage(url) {
    const credentialModes = isPublicSignedImageUrl(url)
      ? ["omit", "include"]
      : ["include", "omit"];
    let lastError = null;
    for (const credentials of credentialModes) {
      try {
        const response = await fetch(url, { credentials });
        if (response.ok) return response;
        lastError = new Error(`Image request failed: ${response.status}`);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Image request failed");
  }

  async function attachmentDataUrl(attachment) {
    const url = String(attachment?.url || "").trim();
    if (!url) return "";
    const response = await fetchAttachmentImage(url);
    const blob = await response.blob();
    const mimeType = inferAttachmentMimeType(attachment, blob?.type || response.headers?.get?.("content-type") || "");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return `data:${mimeType};base64,${base64FromBytes(bytes)}`;
  }

  function imageAttachmentOrigin(attachment) {
    const hint = `${attachment?.sourceUrl || ""} ${attachment?.url || ""}`.toLowerCase();
    if (isDecorativeDoubaoImageUrl(hint)) return "decorative";
    if (/\/(?:ocean-cloud-tos|rc_gen_image)\//i.test(hint)) return "generated";
    if (/\/(?:rc|bot-chat-image)\//i.test(hint)) return "user_upload";
    if (isRootDoubaoUserUploadUrl(hint)) return "user_upload";
    return "unknown";
  }

  function urlPathFromValue(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      return new URL(raw).pathname.toLowerCase();
    } catch (_error) {
      const match = raw.match(/https?:\/\/[^/]+([^?#\s]+)/i);
      return String(match?.[1] || raw.split(/[?#]/, 1)[0]).toLowerCase();
    }
  }

  function isDecorativeDoubaoImageUrl(value) {
    const path = urlPathFromValue(value);
    return /\/action_bar_icon\//i.test(path)
      || /\/media_selector_container_template\//i.test(path)
      || /\/effect_2_stroke_(?:light|dark)\.png~/i.test(path)
      || /\/ocean-cloud-tos\/~tplv-/i.test(path);
  }

  function isRootDoubaoUserUploadUrl(value) {
    const path = urlPathFromValue(value);
    return /\/tos-cn-i-a9rns2rl98\/[a-f0-9]{16,}(?:\.[a-z0-9]+)?~tplv-[^/?#]*-(?:image|image_raw|image-qvalue|image_private|private)\./i.test(path);
  }

  function isDoubaoGeneratedPreviewUrl(value) {
    const raw = String(value || "");
    const path = urlPathFromValue(raw);
    if (!/(\/rc_gen_image\/|\/ocean-cloud-tos\/)/i.test(path)) return false;
    return /[a-f0-9]{16,}preview\.(?:png|jpe?g|webp|bmp|gif|svg|image)(?:~|$)/i.test(path)
      || /~tplv-[^/?#]*-image_pre_watermark[^/?#]*\.heic/i.test(path)
      || /photo_dialog_preview/i.test(raw);
  }

  function shouldSkipImageAttachmentInMarkdown(message, attachment) {
    if (isDecorativeDoubaoImageUrl(attachment?.sourceUrl || attachment?.url)) return true;
    if (isDoubaoGeneratedPreviewUrl(attachment?.sourceUrl || attachment?.url)) return true;
    if (attachment?.imageReference === "reference") return true;
    const role = String(message?.role || "").trim().toLowerCase();
    return role && role !== "user" && imageAttachmentOrigin(attachment) === "user_upload";
  }

  function shouldPackageImageAttachment(attachment) {
    return attachmentKindForMarkdown(attachment) === "image"
      && imageAttachmentOrigin(attachment) === "user_upload";
  }

  function typoraFriendlyImageUrl(value) {
    const url = String(value || "").trim().toLowerCase();
    if (!url) return false;
    return /\.(png|jpe?g|gif|webp|bmp|svg|image)(?:[?#]|$)/i.test(url)
      && !/\.heic(?:[?#]|$)/i.test(url);
  }

  function signedImageUrlExpiryMs(value) {
    try {
      const raw = new URL(String(value || "")).searchParams.get("x-expires");
      const seconds = Number(raw || 0);
      return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
    } catch (_error) {
      return 0;
    }
  }

  function isExpiredSignedImageUrl(value, now = Date.now()) {
    const expiryMs = signedImageUrlExpiryMs(value);
    return Boolean(expiryMs && expiryMs <= Number(now || Date.now()));
  }

  function refreshedImageUrlFromPayload(payload) {
    const item = payload?.data?.file_urls?.[0];
    return String(item?.main_url || item?.back_url || "").trim().replace(/\\u0026/g, "&");
  }

  async function refreshAttachmentImageUrl(url) {
    const sourceUrl = String(url || "").trim();
    if (!sourceUrl || !isPublicSignedImageUrl(sourceUrl)) return "";
    try {
      const response = await fetch(new URL("/alice/upload/refresh_file_url", location.origin).toString(), {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/json"
        },
        body: JSON.stringify({ url: sourceUrl })
      });
      if (!response.ok) return "";
      const payload = await response.json();
      return refreshedImageUrlFromPayload(payload);
    } catch (error) {
      console.debug(`[${APP_ID}] refresh image url failed`, error);
      return "";
    }
  }

  function imageDownloadCandidatePriority(attachment) {
    const url = String(attachment?.url || "");
    let priority = imageAttachmentPriority(attachment);
    if (typoraFriendlyImageUrl(url)) priority += 160;
    if (isExpiredSignedImageUrl(url) && !typoraFriendlyImageUrl(url)) priority -= 80;
    if (!typoraFriendlyImageUrl(url)) priority -= 120;
    return priority;
  }

  function imageAssetExtension(mimeType, attachment) {
    const normalizedMimeType = String(mimeType || "").split(";")[0].trim().toLowerCase();
    if (normalizedMimeType === "image/png") return "png";
    if (normalizedMimeType === "image/jpeg") return "jpg";
    if (normalizedMimeType === "image/gif") return "gif";
    if (normalizedMimeType === "image/webp") return "webp";
    if (normalizedMimeType === "image/bmp") return "bmp";
    if (normalizedMimeType === "image/svg+xml") return "svg";
    const hint = `${attachment?.name || ""} ${attachment?.url || ""}`.toLowerCase();
    const match = hint.match(/\.(png|jpe?g|gif|webp|bmp|svg)(?:[?#]|$)/i);
    return match ? match[1].toLowerCase().replace("jpeg", "jpg") : "png";
  }

  async function fetchPackagedImageCandidate(candidate) {
    const url = String(candidate?.url || "").trim();
    if (!url) throw new Error("Image URL is empty");
    const urls = [];
    const push = (value) => {
      const normalized = String(value || "").trim();
      if (normalized && !urls.includes(normalized)) urls.push(normalized);
    };

    if (isExpiredSignedImageUrl(url)) {
      push(await refreshAttachmentImageUrl(url));
    }
    push(url);

    let lastError = null;
    for (const candidateUrl of urls) {
      try {
        const response = await fetchAttachmentImage(candidateUrl);
        const blob = await response.blob();
        const mimeType = inferAttachmentMimeType(
          { ...candidate, url: candidateUrl },
          blob?.type || response.headers?.get?.("content-type") || ""
        );
        return {
          candidate: {
            ...candidate,
            url: candidateUrl,
            sourceUrl: candidate.sourceUrl || url
          },
          originalUrl: url,
          blob,
          mimeType
        };
      } catch (error) {
        lastError = error;
        const refreshedUrl = await refreshAttachmentImageUrl(candidateUrl);
        if (refreshedUrl && !urls.includes(refreshedUrl)) {
          urls.push(refreshedUrl);
        }
      }
    }
    throw lastError || new Error("Image request failed");
  }

  async function packagedImageAssetsFromConversation(conversation, onProgress) {
    const groupedAssets = new Map();

    (conversation?.messages || []).forEach((message) => {
      rawMessageAttachments(message).forEach((attachment) => {
        const url = String(attachment?.url || "").trim();
        if (!url || !shouldPackageImageAttachment(attachment)) return;
        const groupKey = imageResourceGroupKey(attachment) || `url:${url}`;
        if (!groupedAssets.has(groupKey)) {
          groupedAssets.set(groupKey, {
            groupKey,
            candidates: [],
            urls: new Set()
          });
        }
        const group = groupedAssets.get(groupKey);
        if (!group.urls.has(url)) {
          group.urls.add(url);
          group.candidates.push(attachment);
        }
      });
    });

    const queue = [...groupedAssets.values()];
    const files = [];
    const rewrites = new Map();
    const unavailable = new Map();
    let cursor = 0;
    let completed = 0;
    const concurrency = Math.max(1, Math.min(IMAGE_EMBED_CONCURRENCY, queue.length || 1));

    async function worker() {
      while (cursor < queue.length) {
        const index = cursor;
        cursor += 1;
        const item = queue[index];
      const candidates = item.candidates
        .slice()
        .sort((left, right) => imageDownloadCandidatePriority(right) - imageDownloadCandidatePriority(left));
      let packaged = null;
      let lastError = null;
      for (const candidate of candidates) {
        try {
          packaged = await fetchPackagedImageCandidate(candidate);
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!packaged) {
        item.urls.forEach((url) => unavailable.set(url, {
          groupKey: item.groupKey,
          expired: isExpiredSignedImageUrl(url)
        }));
        console.debug(`[${APP_ID}] package image failed`, item.candidates[0]?.url, lastError);
        continue;
      }

      const relativePath = `assets/upload-${String(index + 1).padStart(3, "0")}.${imageAssetExtension(packaged.mimeType, packaged.candidate)}`;
      files.push({
        relativePath,
        mimeType: packaged.mimeType,
        blob: packaged.blob
      });
      item.urls.forEach((url) => rewrites.set(url, relativePath));
      if (packaged.originalUrl) rewrites.set(packaged.originalUrl, relativePath);
      if (packaged.candidate?.url) rewrites.set(packaged.candidate.url, relativePath);
        completed += 1;
        if (typeof onProgress === "function") {
          onProgress({
            index: completed - 1,
            total: queue.length,
            attachment: item.candidates[0]
          });
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return { files, rewrites, unavailable };
  }

  async function embeddedImageAssetsFromConversation(conversation, onProgress) {
    const queue = [];
    const seen = new Set();
    (conversation?.messages || []).forEach((message) => {
      messageAttachments(message).forEach((attachment) => {
        const url = String(attachment?.url || "").trim();
        if (!url || seen.has(url) || attachmentKindForMarkdown(attachment) !== "image") return;
        seen.add(url);
        queue.push(attachment);
      });
    });

    const output = new Map();
    for (let index = 0; index < queue.length; index += 1) {
      const attachment = queue[index];
      if (typeof onProgress === "function") {
        onProgress({
          index,
          total: queue.length,
          attachment
        });
      }
      try {
        output.set(String(attachment.url || "").trim(), await attachmentDataUrl(attachment));
      } catch (error) {
        console.debug(`[${APP_ID}] embed image failed`, attachment?.url, error);
        output.set(String(attachment.url || "").trim(), String(attachment.url || "").trim());
      }
    }

    return output;
  }

  function conversationWithPackagedAssets(conversation, packagedAssets, unavailableAssets = new Map()) {
    const rewrites = packagedAssets instanceof Map ? packagedAssets : new Map();
    const unavailable = unavailableAssets instanceof Map ? unavailableAssets : new Map();
    if (!rewrites.size && !unavailable.size) return conversation;
    return {
      ...conversation,
      messages: (Array.isArray(conversation?.messages) ? conversation.messages : []).map((message) => ({
        ...message,
        attachments: Array.isArray(message?.attachments)
          ? message.attachments.map((attachment) => {
            const originalUrl = String(attachment?.url || "").trim();
            return {
              ...attachment,
              sourceUrl: attachment.sourceUrl || originalUrl,
              imageGroupKey: attachment.type === "image"
                ? attachment.imageGroupKey || imageResourceGroupKey(attachment)
                : attachment.imageGroupKey,
              unavailable: unavailable.has(originalUrl),
              imageReference: attachment.imageReference,
              url: rewrites.get(originalUrl) || attachment.url
            };
          })
          : message.attachments,
        parts: Array.isArray(message?.parts)
          ? message.parts.map((part) => (
            part?.type === "image" || part?.type === "attachment"
              ? (() => {
                const originalUrl = String(part?.url || "").trim();
                return {
                  ...part,
                  sourceUrl: part.sourceUrl || originalUrl,
                  imageGroupKey: part.type === "image"
                    ? part.imageGroupKey || imageResourceGroupKey({
                      url: originalUrl,
                      sourceUrl: part.sourceUrl,
                      type: "image"
                    })
                    : part.imageGroupKey,
                  unavailable: unavailable.has(originalUrl),
                  imageReference: part.imageReference,
                  url: rewrites.get(originalUrl) || part.url
                };
              })()
              : part
          ))
          : message.parts
      }))
    };
  }

  async function buildMarkdownExportText(conversation, options = {}) {
    const renderOptions = normalizeMarkdownRenderOptions(options);
    const exportConversation = conversationForExport(conversation, renderOptions);
    if (renderOptions.imageMode !== "embed") {
      return renderMarkdown(exportConversation, renderOptions);
    }
    const embeddedAssets = await embeddedImageAssetsFromConversation(exportConversation, options?.onImageProgress);
    return renderMarkdown(exportConversation, {
      ...renderOptions,
      embeddedAssets
    });
  }

  async function buildTextExportText(conversation, options = {}) {
    const renderOptions = normalizeMarkdownRenderOptions({
      ...options,
      imageMode: "strip"
    });
    return renderText(conversationForTextExport(conversation), renderOptions);
  }

  function conversationWithEmbeddedAssets(conversation, embeddedAssets) {
    if (!(embeddedAssets instanceof Map) || !embeddedAssets.size) return conversation;
    return {
      ...conversation,
      messages: (Array.isArray(conversation?.messages) ? conversation.messages : []).map((message) => ({
        ...message,
        attachments: Array.isArray(message?.attachments)
          ? message.attachments.map((attachment) => {
            const originalUrl = String(attachment?.url || "").trim();
            return {
              ...attachment,
              sourceUrl: attachment.sourceUrl || originalUrl,
              imageGroupKey: attachment.type === "image"
                ? attachment.imageGroupKey || imageResourceGroupKey(attachment)
                : attachment.imageGroupKey,
              imageReference: attachment.imageReference,
              url: embeddedAssets.get(originalUrl) || attachment.url
            };
          })
          : message.attachments,
        parts: Array.isArray(message?.parts)
          ? message.parts.map((part) => (
            part?.type === "image" || part?.type === "attachment"
              ? (() => {
                const originalUrl = String(part?.url || "").trim();
                return {
                  ...part,
                  sourceUrl: part.sourceUrl || originalUrl,
                  imageGroupKey: part.type === "image"
                    ? part.imageGroupKey || imageResourceGroupKey({
                      url: originalUrl,
                      sourceUrl: part.sourceUrl,
                      type: "image"
                    })
                    : part.imageGroupKey,
                  imageReference: part.imageReference,
                  url: embeddedAssets.get(originalUrl) || part.url
                };
              })()
              : part
          ))
          : message.parts
      }))
    };
  }

  function escapeHtmlText(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function decodeHtmlAttribute(value) {
    return String(value || "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  function sanitizeExportUrl(value, options = {}) {
    const raw = decodeHtmlAttribute(value).trim();
    if (!raw) return "";
    const lower = raw.toLowerCase();
    if (options.image && /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i.test(raw)) {
      return raw;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      try {
        const parsed = new URL(raw);
        const allowed = options.image
          ? ["http:", "https:"]
          : ["http:", "https:", "mailto:"];
        return allowed.includes(parsed.protocol) ? raw : "";
      } catch (_error) {
        return "";
      }
    }
    return lower.startsWith("//") ? "" : raw;
  }

  function markdownToHtml(source) {
    const text = String(source || "");
    if (!text) return "";
    const placeholders = [];
    const stash = (html) => {
      const token = "\u0000PH" + placeholders.length + "\u0000";
      placeholders.push(html);
      return token;
    };

    let working = text.replace(/\r\n?/g, "\n");

    working = working.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
      const langTrim = String(lang || "").trim();
      const langClass = langTrim ? ` class="language-${escapeHtmlText(langTrim)}"` : "";
      return stash(`<pre><code${langClass}>${escapeHtmlText(code)}</code></pre>`);
    });

    working = working.replace(/`([^`\n]+)`/g, (_match, code) => {
      return stash(`<code>${escapeHtmlText(code)}</code>`);
    });

    working = escapeHtmlText(working);

    working = working.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_match, alt, url) => {
      const safeUrl = sanitizeExportUrl(url, { image: true });
      return safeUrl ? `<img src="${escapeHtmlText(safeUrl)}" alt="${alt}" loading="lazy">` : alt;
    });

    working = working.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_match, label, url) => {
      const safeUrl = sanitizeExportUrl(url);
      return safeUrl ? `<a href="${escapeHtmlText(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    });

    working = working.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    working = working.replace(/(^|[^*_])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

    working = working.replace(/^(#{1,6})\s+(.+?)\s*$/gm, (_match, hashes, content) => {
      const level = hashes.length;
      return `<h${level}>${content}</h${level}>`;
    });

    const lines = working.split("\n");
    const lineOutput = [];
    let currentList = null;
    const flushList = () => {
      if (!currentList) return;
      lineOutput.push(`<${currentList.type}>`);
      currentList.items.forEach((item) => lineOutput.push(`<li>${item}</li>`));
      lineOutput.push(`</${currentList.type}>`);
      currentList = null;
    };
    lines.forEach((line) => {
      const ulMatch = line.match(/^[-*]\s+(.+)$/);
      const olMatch = line.match(/^\d+\.\s+(.+)$/);
      if (ulMatch) {
        if (!currentList || currentList.type !== "ul") {
          flushList();
          currentList = { type: "ul", items: [] };
        }
        currentList.items.push(ulMatch[1]);
      } else if (olMatch) {
        if (!currentList || currentList.type !== "ol") {
          flushList();
          currentList = { type: "ol", items: [] };
        }
        currentList.items.push(olMatch[1]);
      } else {
        flushList();
        lineOutput.push(line);
      }
    });
    flushList();
    working = lineOutput.join("\n");

    working = working.split(/\n{2,}/).map((paragraph) => {
      const trimmed = paragraph.trim();
      if (!trimmed) return "";
      if (/^<(h[1-6]|ul|ol|pre|blockquote|img|div|table|hr)\b/i.test(trimmed)) return trimmed;
      if (/^\u0000PH\d+\u0000$/.test(trimmed)) return trimmed;
      const withBreaks = trimmed.replace(/\n/g, "<br/>");
      return `<p>${withBreaks}</p>`;
    }).filter(Boolean).join("\n");

    working = working.replace(/\u0000PH(\d+)\u0000/g, (_match, index) => placeholders[Number(index)] || "");
    return working;
  }

  const HTML_EXPORT_STYLE = [
    ":root{",
    "--bg:oklch(0.985 0.003 173);",
    "--surface:oklch(0.998 0.002 173);",
    "--surface-muted:oklch(0.972 0.006 173);",
    "--text:oklch(0.22 0.014 235);",
    "--text-muted:oklch(0.50 0.008 235);",
    "--text-soft:oklch(0.66 0.006 235);",
    "--border:oklch(0.90 0.007 185);",
    "--border-soft:oklch(0.94 0.005 185);",
    "--accent:oklch(0.62 0.11 173);",
    "--accent-strong:oklch(0.52 0.12 173);",
    "--accent-surface:color-mix(in oklch,var(--accent) 12%,white);",
    "--accent-highlight:color-mix(in oklch,var(--accent) 35%,white);",
    "--user-tint:oklch(0.88 0.03 173);",
    "--assistant-tint:oklch(0.99 0.003 173);",
    "--code-bg:oklch(0.96 0.006 185);",
    "--measure:72ch;",
    "}",
    "*,*::before,*::after{box-sizing:border-box}",
    "html,body{margin:0;padding:0}",
    "body{",
    "font-family:\"Onest\",\"PingFang SC\",\"Noto Sans SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",system-ui,sans-serif;",
    "font-size:15.5px;line-height:1.7;",
    "color:var(--text);background:var(--bg);",
    "-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;",
    "}",
    ".page-head{",
    "border-bottom:1px solid var(--border-soft);",
    "background:var(--surface);",
    "padding:28px clamp(20px,5vw,48px) 20px;",
    "}",
    ".page-head-inner{",
    "max-width:var(--measure);margin:0 auto;",
    "display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap;",
    "}",
    ".page-head h1{margin:0;font-size:22px;font-weight:600;letter-spacing:-0.01em;word-break:break-word;flex:1 1 320px;min-width:0;color:var(--text)}",
    ".meta{display:flex;flex-wrap:wrap;gap:6px 12px;color:var(--text-muted);font-size:12.5px;align-items:center;justify-content:flex-end}",
    ".meta .chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid var(--border-soft);border-radius:999px;background:var(--surface-muted);white-space:nowrap}",
    ".meta .chip b{color:var(--text-soft);font-weight:500;font-size:11.5px;letter-spacing:0.02em;text-transform:uppercase}",
    ".meta .chip span{color:var(--text);font-variant-numeric:tabular-nums}",
    ".toolbar{",
    "position:sticky;top:0;z-index:10;",
    "background:color-mix(in oklch,var(--bg) 92%,transparent);",
    "border-bottom:1px solid var(--border-soft);",
    "padding:10px clamp(20px,5vw,48px);",
    "}",
    ".toolbar-inner{max-width:var(--measure);margin:0 auto;display:flex;align-items:center;gap:12px}",
    ".toolbar input{",
    "flex:1;min-width:0;padding:9px 14px;",
    "border:1px solid var(--border);border-radius:10px;",
    "font:inherit;color:var(--text);",
    "background:var(--surface);",
    "transition:border-color 120ms ease,background-color 120ms ease;",
    "}",
    ".toolbar input::placeholder{color:var(--text-soft)}",
    ".toolbar input:focus{outline:none;border-color:var(--accent);background:var(--surface)}",
    ".toolbar .hits{font-size:12.5px;color:var(--text-muted);min-width:88px;text-align:right;font-variant-numeric:tabular-nums}",
    "main{max-width:var(--measure);margin:0 auto;padding:32px clamp(20px,5vw,48px) 80px;display:flex;flex-direction:column;gap:28px}",
    ".msg{padding:18px 4px;border-top:1px solid var(--border-soft)}",
    ".msg:first-child{border-top:0;padding-top:8px}",
    ".msg-user{background:transparent;border-radius:12px;padding:18px 20px;background-color:var(--user-tint);border-top:0;margin-top:4px}",
    ".msg-user+.msg{border-top:0}",
    ".msg-assistant{background:var(--assistant-tint)}",
    ".msg-head{display:flex;align-items:baseline;gap:12px;margin-bottom:10px;color:var(--text-muted);font-size:12px}",
    ".msg-role{font-weight:600;color:var(--text-soft);text-transform:uppercase;letter-spacing:0.08em;font-size:11.5px}",
    ".msg-user .msg-role{color:var(--accent-strong)}",
    ".msg-time{color:var(--text-soft);font-variant-numeric:tabular-nums}",
    ".msg-idx{margin-left:auto;color:var(--text-soft);font-variant-numeric:tabular-nums;font-size:11.5px}",
    ".msg-body{word-wrap:break-word;overflow-wrap:anywhere;color:var(--text)}",
    ".msg-body>:first-child{margin-top:0}",
    ".msg-body>:last-child{margin-bottom:0}",
    ".msg-body p{margin:0 0 12px}",
    ".msg-body h1,.msg-body h2,.msg-body h3,.msg-body h4{margin:20px 0 10px;line-height:1.35;font-weight:600;letter-spacing:-0.005em}",
    ".msg-body h1{font-size:20px}.msg-body h2{font-size:17.5px}.msg-body h3{font-size:15.5px}.msg-body h4{font-size:14.5px}",
    ".msg-body code{",
    "background:var(--code-bg);padding:2px 4px;border-radius:4px;",
    "font-family:\"JetBrains Mono\",ui-monospace,Menlo,Consolas,monospace;",
    "font-size:.88em;color:var(--text);",
    "}",
    ".msg-body pre{",
    "background:var(--code-bg);color:var(--text);",
    "padding:14px 16px;border-radius:8px;",
    "overflow-x:auto;font-size:13px;line-height:1.6;",
    "border:1px solid var(--border-soft);",
    "}",
    ".msg-body pre code{background:transparent;padding:0;color:inherit;font-size:inherit;border-radius:0}",
    ".msg-body img{max-width:100%;height:auto;border-radius:8px;margin:6px 0;display:block}",
    ".msg-body a{color:var(--accent-strong);text-decoration:none;transition:color 120ms ease}",
    ".msg-body a:hover{text-decoration:underline;text-underline-offset:3px}",
    ".msg-body ul,.msg-body ol{margin:0 0 12px;padding-left:24px}",
    ".msg-body li{margin:3px 0}",
    ".msg-body blockquote{",
    "margin:0 0 12px;padding:2px 0 2px 16px;",
    "color:var(--text-muted);font-style:italic;",
    "}",
    ".msg-body hr{border:0;border-top:1px solid var(--border-soft);margin:20px 0}",
    ".msg-body table{border-collapse:collapse;margin:0 0 12px;font-size:14px}",
    ".msg-body th,.msg-body td{padding:6px 10px;border:1px solid var(--border-soft);text-align:left}",
    ".msg-body th{background:var(--surface-muted);font-weight:600}",
    "mark.search-hit{background:var(--accent-highlight);color:var(--text);border-radius:3px;padding:0 2px}",
    ".part-nav{",
    "max-width:var(--measure);margin:0 auto;",
    "padding:14px clamp(20px,5vw,48px);",
    "display:flex;align-items:center;justify-content:space-between;gap:16px;",
    "font-size:13.5px;color:var(--text-muted);",
    "border-bottom:1px solid var(--border-soft);",
    "}",
    ".part-nav.part-nav-foot{border-bottom:0;border-top:1px solid var(--border-soft)}",
    ".part-nav .part-nav-center{color:var(--text-soft);font-variant-numeric:tabular-nums}",
    ".part-nav a{color:var(--accent-strong);text-decoration:none;transition:color 120ms ease}",
    ".part-nav a:hover{text-decoration:underline;text-underline-offset:3px}",
    ".page-foot{",
    "max-width:var(--measure);margin:0 auto;",
    "padding:20px clamp(20px,5vw,48px);",
    "border-top:1px solid var(--border-soft);",
    "color:var(--text-soft);font-size:12.5px;",
    "}",
    "@media (max-width:720px){",
    ".page-head{padding:22px 18px 14px}",
    ".page-head-inner{flex-direction:column;gap:12px}",
    ".meta{justify-content:flex-start}",
    ".toolbar{position:static;padding:10px 18px}",
    "main{padding:24px 18px 60px;gap:22px}",
    ".msg-user{padding:14px 16px}",
    ".part-nav,.page-foot{padding:14px 18px}",
    "}",
    "@media (prefers-reduced-motion:reduce){",
    "*,*::before,*::after{transition:none !important;animation:none !important}",
    "}"
  ].join("");

  const HTML_EXPORT_SCRIPT = [
    "(function(){",
    "var input=document.getElementById('search');",
    "var count=document.getElementById('search-count');",
    "var root=document.getElementById('messages');",
    "if(!input||!root)return;",
    "var bodies=Array.prototype.slice.call(root.querySelectorAll('.msg-body'));",
    "var bodyTexts=bodies.map(function(body){return body.textContent||'';});",
    "function clearMarks(){",
    "bodies.forEach(function(body){",
    "var marks=body.querySelectorAll('mark.search-hit');",
    "for(var i=0;i<marks.length;i++){",
    "var m=marks[i];var parent=m.parentNode;if(!parent)continue;",
    "while(m.firstChild)parent.insertBefore(m.firstChild,m);",
    "parent.removeChild(m);parent.normalize();",
    "}",
    "});",
    "}",
    "function escapeRe(s){return s.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&');}",
    "function countMatches(q){",
    "if(!q){if(count)count.textContent='';return;}",
    "var re=new RegExp(escapeRe(q),'gi');",
    "var hits=0;",
    "bodyTexts.forEach(function(text){",
    "re.lastIndex=0;var matches=text.match(re);hits+=matches?matches.length:0;",
    "});",
    "if(count)count.textContent=hits?(hits+' 处匹配，按 Enter 高亮'):'无匹配';",
    "}",
    "function highlightMatches(q){",
    "clearMarks();",
    "if(!q){if(count)count.textContent='';return;}",
    "var re=new RegExp(escapeRe(q),'gi');",
    "var hits=0;",
    "bodies.forEach(function(node){",
    "var walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT,null);",
    "var texts=[];var n;",
    "while(n=walker.nextNode()){",
    "var tag=n.parentNode&&n.parentNode.tagName;",
    "if(tag==='SCRIPT'||tag==='STYLE')continue;",
    "if(n.parentNode&&n.parentNode.closest&&n.parentNode.closest('mark.search-hit'))continue;",
    "texts.push(n);",
    "}",
    "texts.forEach(function(t){",
    "var val=t.nodeValue;if(!val)return;",
    "re.lastIndex=0;if(!re.test(val))return;re.lastIndex=0;",
    "var frag=document.createDocumentFragment();var last=0;var m;",
    "while((m=re.exec(val))){",
    "if(m.index>last)frag.appendChild(document.createTextNode(val.slice(last,m.index)));",
    "var mk=document.createElement('mark');mk.className='search-hit';mk.textContent=m[0];frag.appendChild(mk);",
    "last=m.index+m[0].length;hits++;",
    "if(m[0].length===0)re.lastIndex++;",
    "}",
    "if(last<val.length)frag.appendChild(document.createTextNode(val.slice(last)));",
    "t.parentNode.replaceChild(frag,t);",
    "});",
    "});",
    "if(count)count.textContent=hits?(hits+' 处匹配'):'无匹配';",
    "}",
    "var timer=0;",
    "input.addEventListener('input',function(){",
    "window.clearTimeout(timer);",
    "timer=window.setTimeout(function(){clearMarks();countMatches(input.value.trim());},250);",
    "});",
    "input.addEventListener('keydown',function(e){",
    "if(e.key==='Enter'){window.clearTimeout(timer);highlightMatches(input.value.trim());}",
    "if(e.key==='Escape'){input.value='';window.clearTimeout(timer);highlightMatches('');input.blur();}",
    "});",
    "document.addEventListener('keydown',function(e){",
    "if(e.key==='Escape'&&input.value){input.value='';highlightMatches('');}",
    "});",
    "})();"
  ].join("");

  function htmlMetaBlock(conversation) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const messageCount = messages.length || Number(conversation.messageCount || 0) || 0;
    const sourceLabel = `${conversation.source || "未知"} · ${captureStateLabel(captureStateOfConversation(conversation))}`;
    const exportedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
    const chips = [
      ["会话", conversation.id ? String(conversation.id).slice(-12) : "—"],
      ["消息", String(messageCount)],
      ["来源", sourceLabel],
      ["导出", exportedAt]
    ];
    const rendered = chips
      .map(([label, value]) => `<span class="chip"><b>${escapeHtmlText(label)}</b><span>${escapeHtmlText(value)}</span></span>`)
      .join("");
    return `<div class="meta">${rendered}</div>`;
  }

  function renderHtmlMessages(conversation, renderOptions) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    return messages.map((message, index) => {
      const textLines = markdownLinesFromMessageParts(message);
      const attachmentLines = markdownLinesFromAttachments(message, renderOptions);
      const allLines = textLines.length && attachmentLines.length
        ? [...textLines, "", ...attachmentLines]
        : [...textLines, ...attachmentLines];
      if (!allLines.length) return "";
      const contentMd = allLines.join("\n\n");
      const contentHtml = markdownToHtml(contentMd);
      const role = String(message.role || "assistant").toLowerCase();
      const timestamp = renderOptions.timestampMode === "show"
        ? formatMessageTimestamp(messageTimestampValue(message))
        : "";
      const indexNumber = Number(message?.metadata?.index) || (index + 1);
      return [
        `<section class="msg msg-${escapeHtmlText(role)}" data-msg-index="${indexNumber}">`,
        '<header class="msg-head">',
        `<span class="msg-role">${escapeHtmlText(roleLabel(role))}</span>`,
        timestamp ? `<time class="msg-time">${escapeHtmlText(timestamp)}</time>` : "",
        `<span class="msg-idx">#${indexNumber}</span>`,
        "</header>",
        `<div class="msg-body">${contentHtml}</div>`,
        "</section>"
      ].filter(Boolean).join("");
    }).filter(Boolean).join("\n");
  }

  function renderHtmlStart(conversation, options = {}) {
    const title = conversation.title || "豆包会话";
    const partNav = options?.partNav ? options.partNav : "";
    return [
      "<!doctype html>",
      '<html lang="zh-CN">',
      "<head>",
      '<meta charset="utf-8">',
      `<title>${escapeHtmlText(title)}</title>`,
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      `<style>${HTML_EXPORT_STYLE}</style>`,
      "</head>",
      "<body>",
      '<header class="page-head">',
      '<div class="page-head-inner">',
      `<h1>${escapeHtmlText(title)}</h1>`,
      htmlMetaBlock(conversation),
      "</div>",
      "</header>",
      '<div class="toolbar">',
      '<div class="toolbar-inner">',
      '<input type="search" id="search" aria-label="搜索消息" placeholder="搜索…">',
      '<span id="search-count" class="hits" aria-live="polite"></span>',
      "</div>",
      "</div>",
      partNav,
      '<main id="messages">',
      ""
    ].filter(Boolean).join("\n");
  }

  function renderHtmlEnd(_conversation, options = {}) {
    const partNav = options?.partNav ? options.partNav : "";
    const partNavFoot = partNav ? partNav.replace('class="part-nav"', 'class="part-nav part-nav-foot"') : "";
    const exportedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
    return [
      "</main>",
      partNavFoot,
      '<footer class="page-foot">',
      `由 Doubao Export Shell 导出 · ${escapeHtmlText(exportedAt)}`,
      "</footer>",
      `<script>${HTML_EXPORT_SCRIPT}</script>`,
      "</body>",
      "</html>",
      ""
    ].filter(Boolean).join("\n");
  }

  function renderHtml(conversation, options = {}) {
    const renderOptions = normalizeMarkdownRenderOptions(options);
    return [
      renderHtmlStart(conversation, options),
      renderHtmlMessages(conversation, renderOptions),
      renderHtmlEnd(conversation, options)
    ].join("\n");
  }

  async function buildHtmlExportText(conversation, options = {}) {
    const renderOptions = normalizeMarkdownRenderOptions(options);
    if (renderOptions.imageMode !== "embed") {
      return renderHtml(conversation, renderOptions);
    }
    const embeddedAssets = await embeddedImageAssetsFromConversation(conversation, options?.onImageProgress);
    return renderHtml(conversation, {
      ...renderOptions,
      embeddedAssets
    });
  }

  async function downloadBlob(filename, blob, mimeType) {
    const fileBlob = blob instanceof Blob ? blob : new Blob([blob], { type: mimeType || "application/octet-stream" });
    const objectUrl = URL.createObjectURL(fileBlob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename || "doubao-export";
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
  }

  async function downloadText(filename, text, mimeType) {
    const blob = new Blob([text], { type: mimeType || "text/plain;charset=utf-8" });
    await downloadBlob(filename, blob, mimeType);
  }

  let exportWorkerScriptPromise = null;

  async function fetchExtensionText(path) {
    const url = chrome?.runtime?.getURL ? chrome.runtime.getURL(path) : path;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Unable to load ${path}: ${response.status}`);
    }
    return response.text();
  }

  async function exportWorkerScriptText() {
    if (!exportWorkerScriptPromise) {
      exportWorkerScriptPromise = Promise.all([
        fetchExtensionText("lib/jszip.min.js"),
        fetchExtensionText("export-worker.js")
      ]).then(([zipSource, workerSource]) => [
        "self.JSZip=undefined;",
        zipSource,
        workerSource
      ].join("\n"));
    }
    return exportWorkerScriptPromise;
  }

  async function createExportWorker() {
    if (typeof Worker !== "function") {
      throw new Error("当前浏览器不支持后台导出 Worker");
    }
    const scriptText = await exportWorkerScriptText();
    const objectUrl = URL.createObjectURL(new Blob([scriptText], { type: "text/javascript;charset=utf-8" }));
    try {
      const worker = new Worker(objectUrl);
      worker.__doubaoExportObjectUrl = objectUrl;
      return worker;
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  function cancelActiveExportTask(reason = "user") {
    if (!activeExportTask) return false;
    activeExportTask.cancelled = true;
    try {
      activeExportTask.worker?.postMessage?.({
        type: "cancel",
        jobId: activeExportTask.jobId,
        reason
      });
    } catch (error) {
      console.debug(`[${APP_ID}] cancel export worker failed`, error);
    }
    addRuntimeLog("export_cancel_request", "已请求取消导出任务", {
      jobId: activeExportTask.jobId,
      reason
    });
    setExportFeedback("working", "正在取消导出…", state.exportFeedback.progress || 90, activeExportTask.scope || "current", "export");
    return true;
  }

  function exportWorkerPercent(message, fallback = 76) {
    const phase = String(message?.phase || "");
    const processed = Number(message?.processed ?? message?.loaded ?? 0);
    const total = Number(message?.total || 0);
    if (Number.isFinite(Number(message?.progress))) {
      const rawProgress = Number(message.progress);
      if (phase === "render") return 50 + Math.round(Math.min(1, rawProgress / 100) * 30);
      if (phase === "blob") return 80 + Math.round(Math.min(1, rawProgress / 100) * 6);
      if (phase === "zip_add") return 82 + Math.round(Math.min(1, rawProgress / 100) * 8);
      if (phase === "zip_compress") return 90 + Math.round(Math.min(1, rawProgress / 100) * 6);
    }
    if (phase === "format" && total > 0) return 50 + Math.round(Math.min(1, processed / total) * 30);
    if (phase === "render" && total > 0) return 50 + Math.round(Math.min(1, processed / total) * 30);
    if (phase === "blob" && total > 0) return 80 + Math.round(Math.min(1, processed / total) * 6);
    if (phase === "zip_add" && total > 0) return 78 + Math.round(Math.min(1, processed / total) * 10);
    if (phase === "zip_compress") return 88 + Math.round(Math.min(1, Number(message?.percent || processed) / 100) * 8);
    return fallback;
  }

  async function runExportWorkerTask({
    conversation,
    format,
    imageMode,
    timestampMode,
    split,
    assetFiles,
    outputMode,
    scope = "current",
    baseName
  }) {
    const worker = await createExportWorker();
    const jobId = randomId();
    activeExportTask = {
      jobId,
      worker,
      scope,
      cancelled: false,
      startedAt: new Date().toISOString()
    };
    state.runtime.activeExport = {
      jobId,
      scope,
      conversationId: conversation?.id || "",
      title: conversation?.title || "",
      format,
      imageMode,
      timestampMode,
      split: Boolean(split),
      messages: Array.isArray(conversation?.messages) ? conversation.messages.length : 0,
      phase: "queued",
      startedAt: activeExportTask.startedAt,
      updatedAt: activeExportTask.startedAt
    };
    saveRuntimeState();

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        try {
          worker.terminate();
          if (worker.__doubaoExportObjectUrl) {
            URL.revokeObjectURL(worker.__doubaoExportObjectUrl);
          }
        } catch (error) {
          console.debug(`[${APP_ID}] terminate export worker failed`, error);
        }
        if (activeExportTask?.jobId === jobId) activeExportTask = null;
      };

      worker.onmessage = (event) => {
        const message = event.data || {};
        if (message.jobId && message.jobId !== jobId) return;
        if (message.type === "started") {
          addRuntimeLog("export_worker_start", "后台导出任务已启动", {
            jobId,
            messages: message.total || 0,
            split: Boolean(split)
          });
          return;
        }
        if (message.type === "progress") {
          const percent = exportWorkerPercent(message, state.exportFeedback.progress || 72);
          const text = message.message || "正在后台生成导出文件…";
          const processed = Number(message.processed ?? message.loaded ?? 0);
          const total = Number(message.total || 0);
          state.runtime.activeExport = {
            ...(state.runtime.activeExport || {}),
            phase: message.phase || "",
            processed,
            total,
            percent,
            updatedAt: new Date().toISOString()
          };
          setExportFeedback("working", text, percent, scope, "export");
          if (
            message.phase !== activeExportTask?.lastLoggedPhase
            || processed === total
            || processed % 5000 === 0
          ) {
            activeExportTask.lastLoggedPhase = message.phase;
            addRuntimeLog("export_worker_progress", text, {
              phase: message.phase || "",
              processed,
              total,
              percent
            });
          }
          saveRuntimeState();
          return;
        }
        if (message.type === "complete") {
          const result = message.result || {};
          const fallbackFile = Array.isArray(message.files) ? message.files[0] : null;
          const resultBytes = result.bytes instanceof ArrayBuffer || result.bytes instanceof Uint8Array
            ? result.bytes
            : null;
          state.runtime.activeExport = {
            ...(state.runtime.activeExport || {}),
            phase: "complete",
            percent: 100,
            finishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          saveRuntimeState();
          cleanup();
          resolve({
            filename: result.filename || fallbackFile?.name || `${baseName}${message.filenameSuffix || ""}`,
            blob: resultBytes || result.blob || fallbackFile?.blob || message.blob,
            mimeType: result.mimeType || fallbackFile?.mimeType || ""
          });
          return;
        }
        if (message.type === "cancelled") {
          state.runtime.activeExport = {
            ...(state.runtime.activeExport || {}),
            phase: "cancelled",
            finishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          saveRuntimeState();
          cleanup();
          const error = new Error("导出已取消");
          error.category = "cancelled";
          reject(error);
          return;
        }
        if (message.type === "error") {
          state.runtime.activeExport = {
            ...(state.runtime.activeExport || {}),
            phase: "failed",
            error: message.message || "Export worker failed",
            finishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          saveRuntimeState();
          cleanup();
          reject(new Error(message.message || "Export worker failed"));
        }
      };

      worker.onerror = (event) => {
        state.runtime.activeExport = {
          ...(state.runtime.activeExport || {}),
          phase: "failed",
          error: event?.message || "Export worker failed",
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        saveRuntimeState();
        cleanup();
        reject(new Error(event?.message || "Export worker failed"));
      };

      worker.postMessage({
        type: "export",
        jobId,
        conversation,
        format,
        assetFiles,
        outputMode,
        options: {
          imageMode,
          timestampMode
        },
        splitOptions: {
          enabled: Boolean(split),
          force: false,
          messagesPerPart: SPLIT_EXPORT_MESSAGES_PER_PART,
          minMessages: SPLIT_EXPORT_MIN_MESSAGES,
          imagesPerPart: SPLIT_EXPORT_IMAGES_PER_PART,
          filesPerPart: SPLIT_EXPORT_FILES_PER_PART,
          embeddedImageCharsPerPart: SPLIT_EXPORT_EMBEDDED_IMAGE_CHARS_PER_PART
        },
        filenameBase: baseName
      });
    });
  }

  function extensionForFormat(format) {
    const safe = sanitizeFormat(format);
    if (safe === "json") return "json";
    if (safe === "html") return "html";
    if (safe === "txt") return "txt";
    return "md";
  }

  function mimeTypeForFormat(format) {
    const safe = sanitizeFormat(format);
    if (safe === "json") return "application/json;charset=utf-8";
    if (safe === "html") return "text/html;charset=utf-8";
    if (safe === "txt") return "text/plain;charset=utf-8";
    return "text/markdown;charset=utf-8";
  }

  function messageSplitMetrics(message) {
    return messageAttachments(message).reduce((metrics, attachment) => {
      if (attachmentKindForMarkdown(attachment) === "image") {
        if (attachment?.imageReference === "reference") return metrics;
        metrics.images += 1;
        const url = String(attachment?.url || "");
        if (url.startsWith("data:image/")) metrics.embeddedImageChars += url.length;
      } else {
        metrics.files += 1;
      }
      return metrics;
    }, { images: 0, files: 0, embeddedImageChars: 0 });
  }

  function conversationSplitMetrics(messages) {
    return (Array.isArray(messages) ? messages : []).reduce((metrics, message) => {
      const next = messageSplitMetrics(message);
      metrics.messages += 1;
      metrics.images += next.images;
      metrics.files += next.files;
      metrics.embeddedImageChars += next.embeddedImageChars;
      return metrics;
    }, { messages: 0, images: 0, files: 0, embeddedImageChars: 0 });
  }

  function shouldSplitConversation(messages) {
    const metrics = conversationSplitMetrics(messages);
    return metrics.messages >= SPLIT_EXPORT_MIN_MESSAGES
      || metrics.images >= SPLIT_EXPORT_IMAGES_PER_PART
      || metrics.files >= SPLIT_EXPORT_FILES_PER_PART
      || metrics.embeddedImageChars >= SPLIT_EXPORT_EMBEDDED_IMAGE_CHARS_PER_PART;
  }

  function shouldForceSplitConversation(conversation, conversationId = "") {
    return shouldSplitConversation(conversation?.messages);
  }

  function shouldForceSplitForCurrentConversation() {
    return shouldForceSplitConversation(currentConversationView(), currentConversationId());
  }

  function splitPartsForConversation(messages) {
    const source = Array.isArray(messages) ? messages : [];
    const rawParts = [];
    let start = 0;
    let current = [];
    let metrics = { images: 0, files: 0, embeddedImageChars: 0 };

    source.forEach((message, index) => {
      const next = messageSplitMetrics(message);
      const wouldExceed = current.length > 0 && (
        current.length >= SPLIT_EXPORT_MESSAGES_PER_PART
        || metrics.images + next.images > SPLIT_EXPORT_IMAGES_PER_PART
        || metrics.files + next.files > SPLIT_EXPORT_FILES_PER_PART
        || metrics.embeddedImageChars + next.embeddedImageChars > SPLIT_EXPORT_EMBEDDED_IMAGE_CHARS_PER_PART
      );
      if (wouldExceed) {
        rawParts.push({ start, messages: current });
        start = index;
        current = [];
        metrics = { images: 0, files: 0, embeddedImageChars: 0 };
      }
      current.push(message);
      metrics.images += next.images;
      metrics.files += next.files;
      metrics.embeddedImageChars += next.embeddedImageChars;
    });
    rawParts.push({ start, messages: current });

    return rawParts.map((part, index) => ({
      index: index + 1,
      total: rawParts.length,
      rangeStart: part.start + 1,
      rangeEnd: part.start + part.messages.length,
      ...conversationSplitMetrics(part.messages),
      messages: part.messages
    }));
  }

  function renderSplitIndexMarkdown(conversation, parts, manifest) {
    const lines = [
      `# ${conversation.title || "豆包会话"} · 分片索引`,
      "",
      `- 会话 ID：${conversation.id || ""}`,
      `- 消息总数：${manifest.totalMessages}`,
      `- 分片数：${manifest.totalParts}`,
      `- 每片消息数：${manifest.messagesPerPart}`,
      `- 格式：${manifest.format.toUpperCase()}`,
      `- 导出时间：${manifest.exportedAt}`,
      "",
      "## 分片列表",
      ""
    ];
    parts.forEach((part) => {
      lines.push(`- [Part ${part.index}（消息 #${part.rangeStart}-#${part.rangeEnd}，共 ${part.messages.length} 条）](${part.filename})`);
    });
    return lines.join("\n") + "\n";
  }

  function renderSplitIndexText(conversation, parts, manifest) {
    const lines = [
      `${conversation.title || "豆包会话"} · 分片索引`,
      "",
      `会话 ID：${conversation.id || ""}`,
      `消息总数：${manifest.totalMessages}`,
      `分片数：${manifest.totalParts}`,
      `每片消息数：${manifest.messagesPerPart}`,
      `格式：${manifest.format.toUpperCase()}`,
      `导出时间：${manifest.exportedAt}`,
      "",
      "分片列表",
      ""
    ];
    parts.forEach((part) => {
      lines.push(`Part ${part.index}：${part.filename}，消息 #${part.rangeStart}-#${part.rangeEnd}，共 ${part.messages.length} 条`);
    });
    return lines.join("\n") + "\n";
  }

  function renderSplitIndexHtml(conversation, parts, manifest) {
    const items = parts.map((part) => {
      return [
        '<li class="part-row">',
        `<a href="${escapeHtmlText(part.filename)}">`,
        `<span class="part-row-label">Part ${part.index}</span>`,
        `<span class="part-row-range">消息 #${part.rangeStart}-#${part.rangeEnd}</span>`,
        `<span class="part-row-count">${part.messages.length} 条</span>`,
        "</a>",
        "</li>"
      ].join("");
    }).join("");
    const title = conversation.title || "豆包会话";
    const style = [
      ":root{",
      "--bg:oklch(0.985 0.003 173);",
      "--surface:oklch(0.998 0.002 173);",
      "--surface-muted:oklch(0.972 0.006 173);",
      "--text:oklch(0.22 0.014 235);",
      "--text-muted:oklch(0.50 0.008 235);",
      "--text-soft:oklch(0.66 0.006 235);",
      "--border:oklch(0.90 0.007 185);",
      "--border-soft:oklch(0.94 0.005 185);",
      "--accent-strong:oklch(0.52 0.12 173);",
      "--measure:68ch;",
      "}",
      "*,*::before,*::after{box-sizing:border-box}",
      "html,body{margin:0;padding:0}",
      "body{",
      "font-family:\"Onest\",\"PingFang SC\",\"Noto Sans SC\",\"Hiragino Sans GB\",\"Microsoft YaHei\",system-ui,sans-serif;",
      "font-size:15.5px;line-height:1.7;color:var(--text);background:var(--bg);",
      "-webkit-font-smoothing:antialiased;",
      "}",
      ".wrap{max-width:var(--measure);margin:0 auto;padding:48px clamp(20px,5vw,48px) 80px}",
      ".crumbs{font-size:12.5px;color:var(--text-soft);letter-spacing:0.04em;text-transform:uppercase;margin-bottom:10px}",
      "h1{font-size:24px;margin:0 0 18px;font-weight:600;letter-spacing:-0.01em;word-break:break-word;color:var(--text)}",
      ".meta{display:flex;flex-wrap:wrap;gap:6px 10px;margin-bottom:28px}",
      ".meta .chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid var(--border-soft);border-radius:999px;background:var(--surface-muted);font-size:12.5px;color:var(--text-muted)}",
      ".meta .chip b{color:var(--text-soft);font-weight:500;font-size:11.5px;letter-spacing:0.02em;text-transform:uppercase}",
      ".meta .chip span{color:var(--text);font-variant-numeric:tabular-nums}",
      ".parts{list-style:none;padding:0;margin:0;border-top:1px solid var(--border-soft)}",
      ".part-row{border-bottom:1px solid var(--border-soft)}",
      ".part-row a{",
      "display:flex;align-items:baseline;gap:16px;",
      "padding:14px 4px;text-decoration:none;color:var(--text);",
      "transition:background-color 120ms ease,color 120ms ease;",
      "}",
      ".part-row a:hover{background:var(--surface-muted);color:var(--accent-strong)}",
      ".part-row-label{font-weight:600;min-width:80px}",
      ".part-row-range{color:var(--text-muted);font-variant-numeric:tabular-nums;flex:1}",
      ".part-row-count{color:var(--text-soft);font-variant-numeric:tabular-nums;font-size:13px}",
      "@media (max-width:720px){.wrap{padding:28px 18px 60px}.part-row-label{min-width:64px}}",
      "@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none !important}}"
    ].join("");
    return [
      "<!doctype html>",
      '<html lang="zh-CN">',
      "<head>",
      '<meta charset="utf-8">',
      `<title>${escapeHtmlText(title)} · 分片索引</title>`,
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      `<style>${style}</style>`,
      "</head>",
      "<body>",
      '<div class="wrap">',
      '<div class="crumbs">分片索引</div>',
      `<h1>${escapeHtmlText(title)}</h1>`,
      '<div class="meta">',
      `<span class="chip"><b>会话</b><span>${escapeHtmlText(conversation.id ? String(conversation.id).slice(-12) : "—")}</span></span>`,
      `<span class="chip"><b>消息</b><span>${manifest.totalMessages}</span></span>`,
      `<span class="chip"><b>分片</b><span>${manifest.totalParts}</span></span>`,
      `<span class="chip"><b>每片</b><span>${manifest.messagesPerPart} 条</span></span>`,
      `<span class="chip"><b>格式</b><span>${manifest.format.toUpperCase()}</span></span>`,
      `<span class="chip"><b>导出</b><span>${escapeHtmlText(String(manifest.exportedAt).replace("T", " ").slice(0, 19))}</span></span>`,
      "</div>",
      `<ul class="parts">${items}</ul>`,
      "</div>",
      "</body>",
      "</html>",
      ""
    ].join("\n");
  }

  function partNavHtml(part, parts) {
    if (!part || parts.length <= 1) return "";
    const prevPart = parts[part.index - 2];
    const nextPart = parts[part.index];
    const prevLink = prevPart
      ? `<a href="${escapeHtmlText(prevPart.filename)}">← Part ${prevPart.index}</a>`
      : '<span class="part-nav-placeholder"></span>';
    const nextLink = nextPart
      ? `<a href="${escapeHtmlText(nextPart.filename)}">Part ${nextPart.index} →</a>`
      : '<span class="part-nav-placeholder"></span>';
    const center = `<span class="part-nav-center">Part ${part.index} / ${part.total} · <a href="index.html">索引</a></span>`;
    return `<nav class="part-nav">${prevLink}${center}${nextLink}</nav>`;
  }

  async function buildSplitConversationZip(conversation, format, options = {}) {
    const Zip = window.JSZip;
    if (typeof Zip !== "function") {
      throw new Error("缺少 ZIP 打包能力");
    }
    const safeFormat = sanitizeFormat(format);
    const extension = extensionForFormat(safeFormat);
    const renderOptions = {
      imageMode: safeFormat === "txt" ? "strip" : sanitizeImageMode(options?.imageMode),
      timestampMode: sanitizeTimestampMode(options?.timestampMode)
    };
    const exportConversation = safeFormat === "json"
      ? conversation
      : safeFormat === "txt"
        ? conversationForTextExport(conversation)
        : conversationForExport(conversation, renderOptions);
    const messages = Array.isArray(exportConversation.messages) ? exportConversation.messages : [];
    const embeddedAssets = renderOptions.imageMode === "embed" && safeFormat !== "json"
      ? await embeddedImageAssetsFromConversation(exportConversation, options?.onImageProgress)
      : null;

    const rawParts = splitPartsForConversation(messages);
    const parts = rawParts.map((part) => ({
      ...part,
      filename: `part-${String(part.index).padStart(3, "0")}.${extension}`
    }));

    const zip = new Zip();
    parts.forEach((part) => {
      const partConversation = {
        ...exportConversation,
        messages: part.messages,
        title: `${exportConversation.title || "豆包会话"} · Part ${part.index}/${part.total}`,
        partInfo: {
          index: part.index,
          total: part.total,
          rangeStart: part.rangeStart,
          rangeEnd: part.rangeEnd,
          parentId: exportConversation.id,
          parentTitle: exportConversation.title || ""
        }
      };
      let content;
      if (safeFormat === "json") {
        content = JSON.stringify(partConversation, null, 2);
      } else if (safeFormat === "html") {
        content = renderHtml(partConversation, {
          ...renderOptions,
          embeddedAssets,
          partNav: partNavHtml(part, parts)
        });
      } else if (safeFormat === "txt") {
        content = renderText(partConversation, renderOptions);
      } else {
        content = renderMarkdown(partConversation, {
          ...renderOptions,
          embeddedAssets
        });
      }
      zip.file(part.filename, content);
    });

    const manifest = {
      id: exportConversation.id,
      title: exportConversation.title || "豆包会话",
      totalMessages: messages.length,
      totalParts: parts.length,
      messagesPerPart: SPLIT_EXPORT_MESSAGES_PER_PART,
      imagesPerPart: SPLIT_EXPORT_IMAGES_PER_PART,
      filesPerPart: SPLIT_EXPORT_FILES_PER_PART,
      embeddedImageCharsPerPart: SPLIT_EXPORT_EMBEDDED_IMAGE_CHARS_PER_PART,
      format: safeFormat,
      exportedAt: new Date().toISOString(),
      parts: parts.map((part) => ({
        index: part.index,
        filename: part.filename,
        rangeStart: part.rangeStart,
        rangeEnd: part.rangeEnd,
        count: part.messages.length,
        images: part.images,
        files: part.files,
        embeddedImageChars: part.embeddedImageChars
      }))
    };
    zip.file("manifest.json", JSON.stringify(manifest, null, 2));

    if (safeFormat === "html") {
      zip.file("index.html", renderSplitIndexHtml(exportConversation, parts, manifest));
    } else if (safeFormat === "txt") {
      zip.file("index.txt", renderSplitIndexText(exportConversation, parts, manifest));
    } else if (safeFormat === "md") {
      zip.file("index.md", renderSplitIndexMarkdown(exportConversation, parts, manifest));
    }

    return zip.generateAsync(
      {
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 }
      },
      (metadata) => {
        if (typeof options?.onUpdate === "function") options.onUpdate(metadata);
      }
    );
  }

  function showToast(message) {
    let toast = document.getElementById(`${APP_ID}-toast`);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = `${APP_ID}-toast`;
      toast.className = "dbx-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = String(message || "").trim();
    toast.hidden = false;
    window.clearTimeout(showToast.timerId);
    showToast.timerId = window.setTimeout(() => {
      const current = document.getElementById(`${APP_ID}-toast`);
      if (current) current.hidden = true;
    }, 2600);
  }

  function hideToast() {
    window.clearTimeout(showToast.timerId);
    const toast = document.getElementById(`${APP_ID}-toast`);
    if (toast) toast.hidden = true;
  }

  function setConversationLoadFeedback(progress, scope = "current", type = "refresh") {
    const loaded = Number(progress?.loaded || 0);
    const page = Number(progress?.page || 0);
    const maxPages = Number(progress?.maxPages || MAX_SCAN_MESSAGE_PAGES);
    const rawExpected = expectedMessageCountForConversation(currentConversationId());
    const expected = rawExpected >= loaded ? rawExpected : 0;
    const percentFromPages = page > 0 && maxPages > 0
      ? 22 + Math.round(Math.min(1, page / maxPages) * 66)
      : 28;
    const percentFromExpected = expected > 0
      ? 22 + Math.round(Math.min(0.98, loaded / expected) * 66)
      : percentFromPages;
    const percent = Math.max(24, Math.min(88, Math.max(percentFromPages, percentFromExpected)));
    const compactMessage = compactProgressMessage({
      ...progress,
      expected
    }, type);
    setExportFeedback(
      "working",
      compactMessage,
      percent,
      scope,
      type
    );
    if (page === 1 || page % 10 === 0 || !progress?.hasMore) {
      addRuntimeLog(type === "export" ? "export_progress" : "refresh_progress", "对话分页加载中", {
        page,
        loaded,
        expected,
        expectedSource: state.cache.summaries?.[currentConversationId()]?.messageCountSource || "",
        pageMessages: Number(progress?.pageMessages || 0),
        hasMore: Boolean(progress?.hasMore),
        ...domMessageDiagnostics()
      });
    }
  }

  async function exportCurrentConversation() {
    try {
      await requireLicenseForExport("current");
      addRuntimeLog("export_start", "开始导出当前对话", {
        format: state.format,
        imageMode: state.imageMode,
        timestampMode: state.timestampMode,
        splitMode: state.splitMode,
        dateRange: dateRangeLabel(state.dateRange) || "off",
        conversationId: currentConversationId() || "",
        routeKind: conversationRouteKind(),
        ...domMessageDiagnostics()
      });
      const dateRange = assertValidDateRange(state.dateRange);
      const cachedConversation = cachedCurrentConversationForExport(dateRange);
      let conversation = cachedConversation;
      if (conversation) {
        setExportFeedback("working", dateRange.active ? "正在筛选日期范围…" : "正在使用已刷新缓存…", 30, "current", "export");
        addRuntimeLog("export_cache_hit", "使用已刷新完整缓存导出当前对话", {
          conversationId: conversation.id || currentConversationId() || "",
          messages: Array.isArray(conversation.messages) ? conversation.messages.length : 0,
          dateRange: dateRangeLabel(dateRange) || "off"
        });
      } else {
        startFeedbackDrift({
          scope: "current",
          type: "export",
          message: dateRange.active ? "未找到完整缓存，正在刷新当前对话…" : "正在准备当前对话…",
          progress: 14,
          ceiling: 42,
          interval: 280
        });
        conversation = await ensureCurrentConversationFresh(true, {
          onProgress: (progress) => setConversationLoadFeedback(progress, "current", "export")
        });
      }
      startFeedbackDrift({
        scope: "current",
        type: "export",
        message: dateRange.active ? "正在筛选并整理导出内容…" : "正在整理导出内容…",
        progress: 48,
        ceiling: 72,
        interval: 280
      });
      conversation = maybePromoteConversationToFull(conversation);
      conversation = withFreshCurrentConversationTitle(conversation);
      if (conversation?.id && conversation?.full) {
        upsertConversation(conversation);
        conversation = state.cache.conversations[conversation.id] || conversation;
      }
      if (!conversation?.messages?.length) {
        throw new Error("No conversation messages available");
      }
      const exportConversation = applyDateRangeToConversation(conversation, dateRange);
      if (!exportConversation?.messages?.length) {
        throw new Error("No messages in selected date range");
      }
      const format = sanitizeFormat(state.format);
      const imageMode = format === "txt" ? "strip" : sanitizeImageMode(state.imageMode);
      const timestampMode = sanitizeTimestampMode(state.timestampMode);
      const splitMode = sanitizeSplitMode(state.splitMode);
      const rangeToken = dateRangeFileToken(dateRange);
      const baseName = `doubao-${sanitizeFileName(conversation.title || conversation.id)}${rangeToken ? `-${rangeToken}` : ""}-${timestampLabel()}`;
      const imageProgressCallback = ({ index, total }) => {
        const percent = total > 0
          ? 62 + Math.round(((index + 1) / total) * 24)
          : 76;
        setExportFeedback("working", `正在整理图片 ${index + 1}/${total}…`, percent, "current");
      };

      const packagedAssets = imageMode === "embed" && format !== "json"
        ? await packagedImageAssetsFromConversation(exportConversation, imageProgressCallback)
        : { files: [], rewrites: new Map(), unavailable: new Map() };
      const workerConversation = packagedAssets.rewrites.size || packagedAssets.unavailable.size
        ? conversationWithPackagedAssets(exportConversation, packagedAssets.rewrites, packagedAssets.unavailable)
        : exportConversation;
      const exportPayloadConversation = compactConversationForRuntime(workerConversation);
      if (workerConversation !== exportConversation) {
        addRuntimeLog("export_asset_prepare", "已在主线程整理用户上传图片", {
          imageMode,
          format,
          assets: packagedAssets.files.length,
          unavailable: packagedAssets.unavailable.size
        });
      }
      const splitRequired = shouldForceSplitConversation(exportPayloadConversation);
      const shouldSplit = splitRequired || (splitMode === "on" && shouldSplitConversation(exportPayloadConversation.messages));
      setExportFeedback("working", shouldSplit ? "正在启动后台分片导出…" : "正在启动后台导出…", 50, "current", "export");
      const workerResult = await runExportWorkerTask({
        conversation: exportPayloadConversation,
        format,
        imageMode,
        timestampMode,
        split: shouldSplit,
        assetFiles: packagedAssets.files,
        outputMode: packagedAssets.files.length ? "zip" : "",
        scope: "current",
        baseName
      });
      stopFeedbackDrift();
      setExportFeedback("working", "正在触发下载…", 96, "current");
      await downloadBlob(
        workerResult.filename,
        workerResult.blob,
        workerResult.mimeType || (workerResult.filename.endsWith(".zip") ? "application/zip" : mimeTypeForFormat(format))
      );
      stopFeedbackDrift();
      setExportFeedback("success", `已导出 ${exportConversation.messages.length} 条消息`, 100, "current");
      addRuntimeLog("export_success", "当前对话导出完成", {
        messages: exportConversation.messages.length,
        originalMessages: conversation.messages.length,
        full: Boolean(conversation.full),
        captureState: captureStateOfConversation(conversation),
        completeness: refreshCompletenessReason(conversation),
        dateRange: dateRangeLabel(dateRange) || "off",
        ...domMessageDiagnostics()
      });
      scheduleExportFeedbackReset();
    } catch (error) {
      stopFeedbackDrift();
      setExportFeedback("error", progressMessage(error), 100, "current");
      addRuntimeLog("export_error", "当前对话导出失败", {
        category: error?.category || "",
        message: progressMessage(error)
      });
      scheduleExportFeedbackReset(2400);
      throw error;
    }
  }

  function formatTimeLabel(value) {
    if (!value) return "未同步";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未同步";
    return date.toLocaleString();
  }

  function extensionVersion() {
    try {
      return typeof chrome !== "undefined" ? chrome?.runtime?.getManifest?.()?.version || "" : "";
    } catch (_error) {
      return "";
    }
  }

  function formatRuntimeLogValue(value) {
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (value && typeof value === "object") {
      try {
        return runtimeLogSample(JSON.stringify(value), 360);
      } catch (error) {
        return JSON.stringify(String(value));
      }
    }
    const text = String(value == null ? "" : value);
    return /[\s=|]/.test(text) ? JSON.stringify(text) : text;
  }

  function runtimeLogSample(value, maxLength = 180) {
    const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (!text) return "";
    const max = Math.max(20, Number(maxLength || 180) || 180);
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }

  function runtimeDiagnosticHeader() {
    const conversationId = currentConversationId() || "";
    const summary = conversationId ? state.cache.summaries?.[conversationId] || {} : {};
    const conversation = conversationId ? state.cache.conversations?.[conversationId] || {} : {};
    const messages = Array.isArray(conversation?.messages) ? conversation.messages.length : 0;
    const dom = domMessageDiagnostics();
    const visibleIds = visibleDomMessageIds().map(compactLogId).join(",");
    return [
      `doubao-export version=${extensionVersion() || "unknown"} logLimit=${MAX_RUNTIME_LOGS}`,
      `page path=${readPathname(location.href) || "unknown"} route=${conversationRouteKind()} conversationId=${conversationId || "missing"}`,
      `dom rows=${dom.messageRows || 0} nonEmpty=${dom.nonEmptyRows || 0} dataMessageRows=${dom.dataMessageRows || 0} roots=${dom.rootCandidates || 0} bestRootRows=${dom.bestRootRows || 0}`,
      `visibleDomIds=${visibleIds || "none"}`,
      `scroll element=${dom.messageScrollElement || "missing"} top=${dom.messageScrollTop || 0}/${Math.max(0, Number(dom.messageScrollHeight || 0) - Number(dom.messageScrollClientHeight || 0))} can=${Boolean(dom.messageScrollCanScroll)} up=${Boolean(dom.messageScrollCanScrollUp)} down=${Boolean(dom.messageScrollCanScrollDown)} overflowY=${dom.messageScrollOverflowY || ""}`,
      `plugin panelOpen=${Boolean(dom.pluginPanelOpen)} overlayPointer=${dom.pluginOverlayPointerEvents || ""} dialogOverlap=${Boolean(dom.pluginDialogOverlapsMessages)} triggerOverlap=${Boolean(dom.pluginTriggerOverlapsMessages)}`,
      `templates single=${requestTemplateStatus("single")} recent=${requestTemplateStatus("recent")} title=${requestTemplateStatus("title")}`,
      `cache messages=${messages} full=${Boolean(conversation?.full)} captureState=${captureStateOfConversation(conversation)} summaryCount=${Number(summary?.messageCount || 0)} summarySource=${summary?.messageCountSource || ""}`
    ].join("\n");
  }

  function triggerSvg() {
    if (typeof UIFramework.renderShellSvg === "function") {
      return UIFramework.renderShellSvg("dbx-trigger-icon");
    }
    return `
      <svg class="dbx-trigger-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6 5.75h7.25c2.623 0 4.75 2.127 4.75 4.75v.25c0 2.623-2.127 4.75-4.75 4.75H11l-3.5 2v-2H6A3.25 3.25 0 0 1 2.75 12V9A3.25 3.25 0 0 1 6 5.75Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M8 9.5h6M8 12.5h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    `;
  }

  function aboutActionIconSvg() {
    return `
      <svg class="dbx-about-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="7.25" stroke="currentColor" stroke-width="1.7"/>
        <path d="M12 10.75V16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
        <path d="M12 8H12.01" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>
      </svg>
    `;
  }

  function disclosureChevronSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7.75 10.25 12 14.5l4.25-4.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    `;
  }

  function footerFeedbackHtml(isVisible) {
    return `
      <div
        class="dbx-footer-feedback${state.exportFeedback.state !== "idle" ? ` is-${state.exportFeedback.state}` : ""}"
        id="${APP_ID}-footer-feedback"
        role="status"
        aria-live="polite"
        ${!isVisible ? 'hidden="hidden"' : ""}>
        <div
          class="dbx-progress-track"
          id="${APP_ID}-progress-track"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="${state.exportFeedback.progress}">
          <div
            class="dbx-progress-fill"
            id="${APP_ID}-progress-fill"
            style="width:${state.exportFeedback.progress}%;"></div>
        </div>
        <span class="dbx-feedback-text" id="${APP_ID}-feedback-text">${escapeHtml(state.exportFeedback.message || "")}</span>
        <span class="dbx-progress-label">${Math.round(state.exportFeedback.progress)}%</span>
      </div>
    `;
  }

  function formatIconSvg(format) {
    if (format === "txt") {
      return `
        <svg class="dbx-format-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7.25 4.75H16.75A1.25 1.25 0 0 1 18 6V18A1.25 1.25 0 0 1 16.75 19.25H7.25A1.25 1.25 0 0 1 6 18V6A1.25 1.25 0 0 1 7.25 4.75Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          <path d="M8.75 9H15.25M8.75 12H15.25M8.75 15H13.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      `;
    }
    if (format === "json") {
      return `
        <svg class="dbx-format-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M8 7C6.5 7 5.75 7.75 5.75 9.25V10.25C5.75 11.35 5.35 12 4.5 12C5.35 12 5.75 12.65 5.75 13.75V14.75C5.75 16.25 6.5 17 8 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          <path d="M16 7C17.5 7 18.25 7.75 18.25 9.25V10.25C18.25 11.35 18.65 12 19.5 12C18.65 12 18.25 12.65 18.25 13.75V14.75C18.25 16.25 17.5 17 16 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      `;
    }
    if (format === "html") {
      return `
        <svg class="dbx-format-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 4.5L6 19.5L12 21L18 19.5L19 4.5H5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          <path d="M8.5 8.25H15.5L15 12L12 12.9L9 12L8.75 10.25" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M9.25 14.25L12 15L14.75 14.25" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
    }
    return `
      <svg class="dbx-format-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7.25 4.75H13.5L17.25 8.5V18a1.25 1.25 0 0 1-1.25 1.25H7.25A1.25 1.25 0 0 1 6 18V6A1.25 1.25 0 0 1 7.25 4.75Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M13.25 4.75V8.75H17.25" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
      </svg>
    `;
  }

  function markdownSwitchOptionHtml({ label, note, active, toggleAttribute, ariaLabel, optionClass = "", disabled = false }) {
    return `
      <div class="dbx-bottom-option ${escapeHtml(optionClass)}">
        <div class="dbx-bottom-option-copy">
          <span class="dbx-bottom-option-label">${escapeHtml(label)}</span>
          <span class="dbx-bottom-option-note">${escapeHtml(note)}</span>
        </div>
        <button
          type="button"
          class="dbx-switch ${active ? "is-active" : ""}"
          ${toggleAttribute}="true"
          role="switch"
          aria-checked="${active ? "true" : "false"}"
          aria-label="${escapeHtml(ariaLabel)}"
          ${disabled ? 'disabled aria-disabled="true"' : ""}>
          <span class="dbx-switch-thumb" aria-hidden="true"></span>
        </button>
      </div>
    `;
  }

  function dateRangeControlHtml() {
    const range = normalizeDateRange(state.dateRange);
    const active = range.enabled;
    const label = dateRangeLabel(range);
    const note = active
      ? label || "选择开始或结束日期后，仅导出范围内消息"
      : "默认导出全部已捕获消息";
    return `
      <div class="dbx-date-range-option ${active ? "is-active" : ""}">
        ${markdownSwitchOptionHtml({
          label: "按日期范围导出",
          note,
          active,
          toggleAttribute: "data-date-range-toggle",
          ariaLabel: "按日期范围导出"
        })}
        <div class="dbx-date-range-fields" ${active ? "" : 'hidden="hidden"'}>
          <label class="dbx-date-field">
            <span>开始</span>
            <input class="dbx-date-input" type="date" data-date-range-start="true" value="${escapeHtml(range.startDate)}" aria-label="开始日期">
          </label>
          <label class="dbx-date-field">
            <span>结束</span>
            <input class="dbx-date-input" type="date" data-date-range-end="true" value="${escapeHtml(range.endDate)}" aria-label="结束日期">
          </label>
        </div>
      </div>
    `;
  }

  function bottomToggleHtml() {
    const format = sanitizeFormat(state.format);
    const timestampEnabled = sanitizeTimestampMode(state.timestampMode) === "show";
    const timestampNote = timestampEnabled
      ? "会把已捕获的消息时间追加到消息标题"
      : "默认不写出每条消息的发送时间";
    const embedEnabled = sanitizeImageMode(state.imageMode) === "embed";
    const imageLabel = format === "html" ? "HTML 携带图片" : "Markdown 携带图片";
    const imageNote = embedEnabled
      ? "生成图保留原图，上传图随文件一起导出"
      : "默认清洗图片，仅保留文字内容";
    const splitForced = shouldForceSplitForCurrentConversation();
    const splitEnabled = splitForced || sanitizeSplitMode(state.splitMode) === "on";
    const splitLabel = "大对话自动分片";
    const splitNote = splitForced
      ? "当前对话过大，已强制分片避免浏览器下载失败"
      : (
        splitEnabled
          ? `达到 ${SPLIT_EXPORT_MIN_MESSAGES} 条 / ${SPLIT_EXPORT_IMAGES_PER_PART} 图 / ${SPLIT_EXPORT_FILES_PER_PART} 附件后自动分片`
          : `达到 ${SPLIT_EXPORT_MIN_MESSAGES} 条 / ${SPLIT_EXPORT_IMAGES_PER_PART} 图 / ${SPLIT_EXPORT_FILES_PER_PART} 附件后可自动分片`
      );

    const parts = [];
    parts.push(markdownSwitchOptionHtml({
      label: "导出消息时间",
      note: timestampNote,
      active: timestampEnabled,
      toggleAttribute: "data-timestamp-mode-toggle",
      ariaLabel: "导出消息时间"
    }));
    if (format === "md" || format === "html") {
      parts.push(markdownSwitchOptionHtml({
        label: imageLabel,
        note: imageNote,
        active: embedEnabled,
        toggleAttribute: "data-image-mode-toggle",
        ariaLabel: imageLabel
      }));
    }
    parts.push(markdownSwitchOptionHtml({
      label: splitLabel,
      note: splitNote,
      active: splitEnabled,
      toggleAttribute: "data-split-mode-toggle",
      ariaLabel: splitLabel,
      optionClass: "dbx-bottom-option--split",
      disabled: splitForced
    }));
    parts.push(dateRangeControlHtml());

    return `<div class="dbx-bottom-option-wrap">${parts.join("")}</div>`;
  }

  function aboutTabHtml() {
    return `
      <div class="dbx-about">
        <div class="dbx-about-header">
          <div class="dbx-about-logo">${triggerSvg()}</div>
          <div>
            <h3 class="dbx-about-title">豆包导出助手</h3>
            <span class="dbx-about-version">v${escapeHtml(extensionVersion() || "1.0.0")} 免费版</span>
          </div>
        </div>
        <p class="dbx-about-desc">本工具仅供用户本地备份本人账号聊天记录，数据不上传服务器。</p>
        <p class="dbx-about-desc">支持导出 Markdown、HTML、JSON 与 TXT。所有处理都在当前浏览器本地完成。</p>
      </div>
    `;
  }

  function panelFooterState() {
    const current = currentConversationView();
    const feedback = state.exportFeedback;
    const exportBusy = feedback.state === "working" && feedback.type === "export";
    const refreshBusy = feedback.state === "working" && feedback.type === "refresh";
    const rangeMeta = dateRangeBounds(state.dateRange).active ? " · 已启用日期范围" : "";
    const primaryLabel = feedback.scope === "current" && feedback.state === "success" && feedback.type === "export"
      ? "导出完成"
      : feedback.scope === "current" && feedback.state === "error" && feedback.type === "export"
        ? "重试导出"
        : exportBusy && feedback.scope === "current"
          ? "取消导出"
          : "导出当前对话";
    const currentMessages = loadedMessageCount(current);
    const currentDisplayMessages = displayMessageCount(current);
    const currentMeta = currentMessages > 0
      ? `${currentMessages} 条消息可导出${rangeMeta}`
      : currentDisplayMessages > 0
        ? `${currentDisplayMessages} 条消息待刷新${rangeMeta}`
        : `等待刷新当前对话${rangeMeta}`;
    return {
      meta: refreshBusy && feedback.scope === "current" ? "正在刷新当前对话…" : currentMeta,
      secondaryAction: "refresh-current",
      secondaryLabel: refreshBusy ? "刷新中" : "刷新当前对话",
      secondaryDisabled: exportBusy || refreshBusy,
      primaryAction: "export-current",
      primaryLabel,
      primaryDisabled: refreshBusy,
      primaryState: feedback.scope === "current" && feedback.type === "export" ? feedback.state : "idle",
      secondaryVisible: !exportBusy,
      primaryVisible: !refreshBusy,
      actionsVisible: true,
      feedbackVisible: exportFeedbackVisible() && feedback.scope === "current"
    };
  }

  function syncFooterControls(overlay) {
    const footer = panelFooterState();
    const meta = overlay.querySelector(`#${APP_ID}-footer-meta`);
    const secondary = overlay.querySelector(`#${APP_ID}-footer-secondary`);
    const primary = overlay.querySelector(`#${APP_ID}-footer-primary`);
    const feedbackEl = overlay.querySelector(`#${APP_ID}-footer-feedback`);

    if (meta) {
      meta.textContent = footer.meta;
    }
    
    if (feedbackEl) {
      if (footer.feedbackVisible) {
        feedbackEl.removeAttribute("hidden");
        feedbackEl.className = `dbx-footer-feedback${state.exportFeedback.state !== "idle" ? ` is-${state.exportFeedback.state}` : ""}`;
        const fill = feedbackEl.querySelector(".dbx-progress-fill");
        const text = feedbackEl.querySelector(".dbx-feedback-text");
        const label = feedbackEl.querySelector(".dbx-progress-label");
        const track = feedbackEl.querySelector(".dbx-progress-track");
        if (fill) fill.style.width = `${state.exportFeedback.progress}%`;
        if (text) text.textContent = state.exportFeedback.message || "";
        if (label) label.textContent = `${Math.round(state.exportFeedback.progress)}%`;
        if (track) track.setAttribute("aria-valuenow", String(state.exportFeedback.progress));
      } else {
        feedbackEl.setAttribute("hidden", "hidden");
      }
    }
    if (secondary) {
      secondary.textContent = footer.secondaryLabel;
      secondary.setAttribute("data-action", footer.secondaryAction);
      secondary.disabled = footer.secondaryDisabled;
      secondary.hidden = !footer.actionsVisible || footer.secondaryVisible === false;
    }
    if (primary) {
      primary.textContent = footer.primaryLabel;
      primary.setAttribute("data-action", footer.primaryAction);
      primary.disabled = Boolean(footer.primaryDisabled);
      if (footer.primaryState && footer.primaryState !== "idle") {
        primary.setAttribute("data-state", footer.primaryState);
      } else {
        primary.removeAttribute("data-state");
      }
      primary.setAttribute("aria-busy", footer.primaryState === "working" ? "true" : "false");
      primary.hidden = !footer.actionsVisible || footer.primaryVisible === false;
    }
  }

  function createTrigger() {
    if (!document.body || document.getElementById(`${APP_ID}-trigger`)) return;
    const trigger = document.createElement("button");
    trigger.id = `${APP_ID}-trigger`;
    trigger.type = "button";
    trigger.className = "dbx-trigger";
    let isPointerDown = false;
    let didDrag = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    const edgeThreshold = 8;

    try {
      const storedPosition = JSON.parse(localStorage.getItem("dbx-trigger-pos") || "null");
      if (storedPosition && typeof storedPosition.left === "number") {
        trigger.style.left = `${storedPosition.left}px`;
        trigger.style.top = `${storedPosition.top}px`;
        trigger.style.right = "auto";
        trigger.style.transform = "none";
        requestAnimationFrame(() => snapTriggerToEdge(trigger));
      }
    } catch (error) {
      // Ignore invalid stored trigger positions.
    }

    function snapTriggerToEdge(element) {
      const rect = element.getBoundingClientRect();
      element.classList.remove("is-hidden-left", "is-hidden-right");
      if (rect.left <= edgeThreshold) {
        element.style.left = "0px";
        element.classList.add("is-hidden-left");
      } else if (rect.right >= window.innerWidth - edgeThreshold) {
        element.style.left = `${window.innerWidth - rect.width}px`;
        element.classList.add("is-hidden-right");
      }
    }

    function storeTriggerPosition(element) {
      try {
        const rect = element.getBoundingClientRect();
        localStorage.setItem("dbx-trigger-pos", JSON.stringify({
          left: rect.left,
          top: rect.top
        }));
      } catch (error) {
        // Ignore storage failures.
      }
    }

    trigger.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      isPointerDown = true;
      didDrag = false;
      startX = event.clientX;
      startY = event.clientY;
      const rect = trigger.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      trigger.classList.remove("is-hidden-left", "is-hidden-right");
      trigger.classList.add("is-dragging");
      trigger.setPointerCapture(event.pointerId);
    });

    trigger.addEventListener("pointermove", (event) => {
      if (!isPointerDown) return;
      const deltaX = event.clientX - startX;
      const deltaY = event.clientY - startY;
      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
        didDrag = true;
      }
      const width = trigger.offsetWidth;
      const height = trigger.offsetHeight;
      const left = Math.max(0, Math.min(window.innerWidth - width, startLeft + deltaX));
      const top = Math.max(0, Math.min(window.innerHeight - height, startTop + deltaY));
      trigger.style.left = `${left}px`;
      trigger.style.top = `${top}px`;
      trigger.style.right = "auto";
      trigger.style.transform = "none";
    });

    trigger.addEventListener("pointerup", (event) => {
      if (!isPointerDown) return;
      isPointerDown = false;
      trigger.classList.remove("is-dragging");
      trigger.releasePointerCapture(event.pointerId);
      if (didDrag) {
        snapTriggerToEdge(trigger);
        storeTriggerPosition(trigger);
      }
    });

    trigger.addEventListener("click", (event) => {
      if (didDrag) {
        event.preventDefault();
        event.stopPropagation();
        didDrag = false;
        return;
      }
      state.open = true;
      renderPanel();
    });
    trigger.innerHTML = triggerSvg();
    document.body.appendChild(trigger);
  }

  function formatButtonsHtml() {
    const options = [
      { value: "md", label: "Markdown", note: "阅读整理" },
      { value: "html", label: "HTML", note: "网页搜索" },
      { value: "json", label: "JSON", note: "程序处理" },
      { value: "txt", label: "TXT", note: "纯文本" }
    ];
    return options.map((option) => {
      const isActive = state.format === option.value;
      return `
        <div class="dbx-format-item ${isActive ? "is-active" : ""}">
          <button
            type="button"
            class="dbx-format ${isActive ? "is-active" : ""}"
            data-format="${option.value}"
            aria-pressed="${isActive ? "true" : "false"}">
            <span class="dbx-format-icon-wrap">${formatIconSvg(option.value)}</span>
            <span class="dbx-format-copy">
              <span class="dbx-format-label">${escapeHtml(option.label)}</span>
              <span class="dbx-format-note">${escapeHtml(option.note)}</span>
            </span>
          </button>
        </div>
      `;
    }).join("");
  }

  function badgeClassForCaptureState(value) {
    if (value === "full") return "is-accent";
    if (value === "failed") return "is-danger";
    return "is-muted";
  }

  function currentConversationSource(conversation) {
    if (!conversation) return "等待捕获";
    const label = conversation.source === "api"
      ? "接口 /im/chain/single"
      : conversation.source === "network"
        ? "页面响应捕获"
        : conversation.source === "dom"
          ? "DOM 回退"
          : conversation.source || "未知来源";
    return `${label} · ${captureStateLabel(captureStateOfConversation(conversation))}`;
  }

  function requestHealthCardHtml(conversation) {
    const runtime = latestRuntimeStatus();
    const primaryText = runtime?.category
      ? `${runtime.endpoint} · ${requestErrorCategoryLabel(runtime.category)}`
      : runtime?.endpoint
        ? `${runtime.endpoint} · 就绪`
        : "等待请求活动";
    const metaLine = `单条模板：${requestTemplateStatus("single")} · 最近模板：${requestTemplateStatus("recent")}`;
    const detailLine = runtime?.message
      ? runtime.message
      : runtime?.at
        ? formatTimeLabel(runtime.at)
        : "等待请求活动";
    return `
      <div class="dbx-details-stack">
        <div class="dbx-detail-row">
          <span>数据来源</span>
          <strong>${escapeHtml(currentConversationSource(conversation))}</strong>
        </div>
        <div class="dbx-detail-row">
          <span>请求状态</span>
          <strong>${escapeHtml(primaryText)}</strong>
        </div>
        <div class="dbx-detail-row">
          <span>模板状态</span>
          <strong>${escapeHtml(metaLine)}</strong>
        </div>
        <div class="dbx-detail-row">
          <span>最近记录</span>
          <strong>${escapeHtml(detailLine)}</strong>
        </div>
      </div>
    `;
  }

  function runtimeLogText() {
    const logs = Array.isArray(state.runtime.logs) ? state.runtime.logs : [];
    const header = runtimeDiagnosticHeader();
    if (!logs.length) return `${header}\n---\n暂无运行日志`;
    const body = logs.map((entry) => {
      const details = Object.entries(entry.details || {})
        .map(([key, value]) => `${key}=${formatRuntimeLogValue(value)}`)
        .join(" ");
      return `[${formatTimeLabel(entry.at)}] ${entry.type}: ${entry.message}${details ? ` | ${details}` : ""}`;
    }).join("\n");
    return `${header}\n---\n${body}`;
  }

  function runtimeLogHtml() {
    const logs = Array.isArray(state.runtime.logs) ? state.runtime.logs : [];
    return `
      <div class="dbx-runtime-log">
        <div class="dbx-runtime-log-head">
          <span>运行日志</span>
          <button type="button" class="dbx-log-copy" data-runtime-log-copy="true">复制日志</button>
        </div>
        <pre class="dbx-runtime-log-body">${escapeHtml(runtimeLogText())}</pre>
        ${logs.length ? "" : '<p class="dbx-runtime-log-empty">刷新或导出后会显示最近状态。</p>'}
      </div>
    `;
  }

  function diagnosticsSectionHtml(scope, note, content) {
    const open = Boolean(state.diagnostics?.[scope]);
    return `
      <div class="dbx-diagnostics ${open ? "is-open" : ""}">
        <button
          type="button"
          class="dbx-disclosure"
          data-diagnostics-toggle="${scope}"
          aria-expanded="${open ? "true" : "false"}"
          aria-controls="${APP_ID}-diagnostics-${scope}">
          <span class="dbx-disclosure-copy">
            <span class="dbx-disclosure-label">高级信息</span>
          <span class="dbx-disclosure-note">${escapeHtml(note)}</span>
          </span>
          <span class="dbx-disclosure-icon" aria-hidden="true">${disclosureChevronSvg()}</span>
        </button>
        <div class="dbx-details-content" id="${APP_ID}-diagnostics-${scope}" ${open ? "" : 'hidden="hidden"'}>
          ${open ? `${content}${runtimeLogHtml()}` : ""}
        </div>
      </div>
    `;
  }

  function loadedMessageCount(conversation) {
    return Array.isArray(conversation?.messages) ? conversation.messages.length : 0;
  }

  function displayMessageCount(conversation) {
    return loadedMessageCount(conversation) || Number(conversation?.messageCount || 0) || 0;
  }

  function currentTabHtml() {
    const conversation = currentConversationView();
    return `
      <div class="dbx-section-stack">
        <div class="dbx-card dbx-format-card">
          <div class="dbx-status-title">导出格式</div>
          <div class="dbx-format-grid">
            ${formatButtonsHtml()}
          </div>
        </div>

        <div class="dbx-panel-tail">
          ${bottomToggleHtml()}
          ${diagnosticsSectionHtml("current", "默认收起的补充信息", requestHealthCardHtml(conversation))}
        </div>
      </div>
    `;
  }

  function panelHtml() {
    const footer = panelFooterState();

    return `
      <div class="dbx-dialog" role="dialog" aria-modal="true" aria-label="豆包导出面板" style="${dialogStyleText()}">
        <div class="dbx-titlebar">
          <div class="dbx-window-controls" aria-label="窗口操作">
            <button type="button" class="dbx-window-btn dbx-window-btn--close" data-window-action="close" aria-label="关闭窗口" title="关闭"><svg viewBox="0 0 8 8" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><path d="M2.2 2.2L5.8 5.8M5.8 2.2L2.2 5.8"/></svg></button>
            <button type="button" class="dbx-window-btn dbx-window-btn--drag" data-window-action="drag" aria-label="拖动窗口" title="拖动面板"><svg viewBox="0 0 8 8" aria-hidden="true" focusable="false"><g fill="currentColor"><circle cx="2.8" cy="2.4" r="0.55"/><circle cx="2.8" cy="4" r="0.55"/><circle cx="2.8" cy="5.6" r="0.55"/><circle cx="5.2" cy="2.4" r="0.55"/><circle cx="5.2" cy="4" r="0.55"/><circle cx="5.2" cy="5.6" r="0.55"/></g></svg></button>
            <button type="button" class="dbx-window-btn dbx-window-btn--reset" data-window-action="reset" aria-label="重置位置" title="重置位置"><svg viewBox="0 0 8 8" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3V2H3M5 2H6V3M6 5V6H5M3 6H2V5"/></svg></button>
          </div>
          <div class="dbx-titlebar-copy">豆包导出助手</div>
          <div class="dbx-titlebar-actions">
            <button
              type="button"
              class="dbx-about-action ${state.aboutOpen ? "is-active" : ""}"
              data-action="toggle-about"
              aria-label="关于"
              aria-expanded="${state.aboutOpen ? "true" : "false"}"
              title="关于">
              ${aboutActionIconSvg()}
            </button>
          </div>
        </div>

        <div class="dbx-shell-body">
          <div class="dbx-content">
            <section
              id="${APP_ID}-panel-current"
              class="dbx-panel-view dbx-panel-view--current is-visible"
              data-panel="current">
              ${currentTabHtml()}
            </section>
          </div>

          <div class="dbx-about-scrim ${state.aboutOpen ? "is-open" : ""}" data-action="close-about" aria-hidden="true"></div>
          <aside
            id="${APP_ID}-about-drawer"
            class="dbx-about-drawer ${state.aboutOpen ? "is-open" : ""}"
            aria-label="关于"
            aria-hidden="${state.aboutOpen ? "false" : "true"}">
            <div class="dbx-about-drawer-head">
              <h2>关于</h2>
              <button type="button" class="dbx-drawer-close" data-action="close-about" aria-label="关闭关于" title="关闭">
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
              </button>
            </div>
            ${aboutTabHtml()}
          </aside>
        </div>

        <div class="dbx-footer">
          <div class="dbx-footer-meta" id="${APP_ID}-footer-meta">${escapeHtml(footer.meta)}</div>
          ${footerFeedbackHtml(footer.feedbackVisible)}
          <div class="dbx-footer-actions">
            <button
              type="button"
              class="dbx-button is-secondary"
              id="${APP_ID}-footer-secondary"
              data-action="${footer.secondaryAction}"
              ${footer.secondaryDisabled ? "disabled" : ""}>
              ${escapeHtml(footer.secondaryLabel)}
            </button>
            <button
              type="button"
              class="dbx-button is-primary"
              id="${APP_ID}-footer-primary"
              data-action="${footer.primaryAction}"
              ${footer.primaryDisabled ? "disabled" : ""}
              ${footer.primaryState && footer.primaryState !== "idle" ? `data-state="${escapeHtml(footer.primaryState)}"` : ""}
              aria-busy="${footer.primaryState === "working" ? "true" : "false"}">
              ${escapeHtml(footer.primaryLabel)}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  async function copyTextToClipboard(text) {
    const value = String(text || "");
    if (!value) return;
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function syncPanelDom(overlay) {
    if (!overlay) return;
    overlay.className = "dbx-overlay";

    const currentPanel = overlay.querySelector(`#${APP_ID}-panel-current`);
    const aboutDrawer = overlay.querySelector(`#${APP_ID}-about-drawer`);
    const aboutScrim = overlay.querySelector(".dbx-about-scrim");
    const aboutAction = overlay.querySelector(".dbx-about-action");

    if (currentPanel) {
      currentPanel.innerHTML = currentTabHtml();
      currentPanel.hidden = false;
      currentPanel.classList.add("is-visible");
    }

    if (aboutDrawer) {
      const aboutContent = aboutDrawer.querySelector(".dbx-about");
      if (aboutContent) aboutContent.outerHTML = aboutTabHtml();
      aboutDrawer.classList.toggle("is-open", state.aboutOpen);
      aboutDrawer.setAttribute("aria-hidden", state.aboutOpen ? "false" : "true");
    }

    if (aboutScrim) {
      aboutScrim.classList.toggle("is-open", state.aboutOpen);
    }

    if (aboutAction) {
      aboutAction.className = `dbx-about-action${state.aboutOpen ? " is-active" : ""}`;
      aboutAction.setAttribute("aria-expanded", state.aboutOpen ? "true" : "false");
    }

    syncDialogFrame(overlay);
    syncFooterControls(overlay);
  }

  function bindPanel(overlay) {
    const dragButton = overlay.querySelector('[data-window-action="drag"]');
    if (dragButton) {
      dragButton.onpointerdown = (event) => beginDialogDrag(overlay, event);
      dragButton.onpointermove = (event) => updateDialogDrag(overlay, event);
      dragButton.onpointerup = (event) => endDialogDrag(event);
      dragButton.onpointercancel = (event) => endDialogDrag(event);
    }

    overlay.onclick = async (event) => {
      if (event.target === overlay) {
        state.open = false;
        renderPanel();
        return;
      }

      const target = event.target.closest("[data-action], [data-format], [data-image-mode-toggle], [data-timestamp-mode-toggle], [data-split-mode-toggle], [data-date-range-toggle], [data-runtime-log-copy], [data-window-action], [data-diagnostics-toggle]");
      if (!target) return;

      const windowAction = target.getAttribute("data-window-action");
      if (windowAction) {
        if (windowAction === "close") {
          state.open = false;
          renderPanel();
          return;
        }
        if (windowAction === "drag") {
          return;
        }
        if (windowAction === "reset") {
          resetDialogPosition();
          syncPanelDom(overlay);
          return;
        }
      }

      if (target.getAttribute("data-runtime-log-copy")) {
        try {
          await copyTextToClipboard(runtimeLogText());
          showToast("已复制运行日志");
        } catch (error) {
          showToast("复制运行日志失败");
        }
        return;
      }

      const format = target.getAttribute("data-format");
      if (format) {
        state.format = sanitizeFormat(format);
        if (state.format === "txt") {
          state.imageMode = "strip";
        }
        if (typeof UIFramework.pulseSelectableControl === "function") {
          UIFramework.pulseSelectableControl(target);
        }
        syncPanelDom(overlay);
        return;
      }

      const imageModeToggle = target.getAttribute("data-image-mode-toggle");
      if (imageModeToggle) {
        state.imageMode = state.imageMode === "embed" ? "strip" : "embed";
        if (typeof UIFramework.pulseSelectableControl === "function") {
          UIFramework.pulseSelectableControl(target);
        }
        syncPanelDom(overlay);
        return;
      }

      const timestampModeToggle = target.getAttribute("data-timestamp-mode-toggle");
      if (timestampModeToggle) {
        state.timestampMode = state.timestampMode === "show" ? "hide" : "show";
        if (typeof UIFramework.pulseSelectableControl === "function") {
          UIFramework.pulseSelectableControl(target);
        }
        syncPanelDom(overlay);
        return;
      }

      const splitModeToggle = target.getAttribute("data-split-mode-toggle");
      if (splitModeToggle) {
        if (shouldForceSplitForCurrentConversation()) {
          state.splitMode = "on";
          syncPanelDom(overlay);
          return;
        }
        state.splitMode = sanitizeSplitMode(state.splitMode) === "on" ? "off" : "on";
        if (typeof UIFramework.pulseSelectableControl === "function") {
          UIFramework.pulseSelectableControl(target);
        }
        syncPanelDom(overlay);
        return;
      }

      const dateRangeToggle = target.getAttribute("data-date-range-toggle");
      if (dateRangeToggle) {
        state.dateRange = {
          ...normalizeDateRange(state.dateRange),
          enabled: !normalizeDateRange(state.dateRange).enabled
        };
        if (typeof UIFramework.pulseSelectableControl === "function") {
          UIFramework.pulseSelectableControl(target);
        }
        syncPanelDom(overlay);
        return;
      }

      const diagnosticsToggle = target.getAttribute("data-diagnostics-toggle");
      if (diagnosticsToggle && state.diagnostics[diagnosticsToggle] != null) {
        state.diagnostics[diagnosticsToggle] = !state.diagnostics[diagnosticsToggle];
        syncPanelDom(overlay);
        return;
      }

      const action = target.getAttribute("data-action");
      if (!action) return;

      try {
        if (action === "toggle-about") {
          state.aboutOpen = !state.aboutOpen;
          syncPanelDom(overlay);
          return;
        }
        if (action === "close-about") {
          state.aboutOpen = false;
          syncPanelDom(overlay);
          return;
        }
        if (action === "open-about") {
          state.aboutOpen = true;
          syncPanelDom(overlay);
          return;
        }
        if (action === "export-current" && activeExportTask?.scope === "current") {
          cancelActiveExportTask("current_button");
          return;
        }
        if (action === "refresh-current") {
          await requireLicenseForAccess("current", "refresh");
          const conversationId = currentConversationId() || "";
          const existing = conversationId ? state.cache.conversations?.[conversationId] : null;
          const summary = conversationId ? state.cache.summaries?.[conversationId] : null;
          addRuntimeLog("refresh_start", "开始刷新当前对话", {
            conversationId,
            pagePath: readPathname(location.href),
            routeKind: conversationRouteKind(),
            existingMessages: Array.isArray(existing?.messages) ? existing.messages.length : 0,
            existingFull: Boolean(existing?.full),
            summaryCount: Number(summary?.messageCount || 0),
            summarySource: summary?.messageCountSource || "",
            singleTemplate: requestTemplateStatus("single"),
            ...domMessageDiagnostics()
          });
          startFeedbackDrift({
            scope: "current",
            type: "refresh",
            message: "正在刷新当前对话…",
            progress: 20,
            ceiling: 82,
            interval: 280
          });
          const refreshedConversation = await ensureCurrentConversationFresh(true, {
            onProgress: (progress) => setConversationLoadFeedback(progress, "current", "refresh")
          });
          stopFeedbackDrift();
          const refreshed = conversationId ? state.cache.conversations?.[conversationId] : null;
          const finalConversation = refreshed || refreshedConversation;
          const finalMessages = Array.isArray(finalConversation?.messages) ? finalConversation.messages.length : 0;
          const finalFull = Boolean(finalConversation?.full);
          const finalCaptureState = captureStateOfConversation(finalConversation);
          const refreshComplete = finalFull || finalCaptureState === "full";
          const resultType = refreshComplete ? "refresh_success" : "refresh_partial";
          const resultMessage = refreshComplete ? "当前对话刷新完成" : "当前对话只刷新到部分内容";
          const userMessage = refreshComplete ? "当前会话已刷新。" : `当前对话未完整刷新，已保留 ${finalMessages} 条缓存消息`;
          setExportFeedback(refreshComplete ? "success" : "warning", refreshComplete ? "刷新成功" : userMessage, 100, "current", "refresh");
          addRuntimeLog(resultType, resultMessage, {
            conversationId,
            messages: finalMessages,
            full: finalFull,
            captureState: finalCaptureState,
            completeness: refreshCompletenessReason(finalConversation),
            ...domMessageDiagnostics()
          });
          scheduleExportFeedbackReset(2000);
          syncPanelDom(overlay);
          return;
        }
        if (action === "go-current") {
          state.tab = "current";
          syncPanelDom(overlay);
          return;
        }
        if (action === "close-panel") {
          state.open = false;
          renderPanel();
          return;
        }
        if (action === "export-current") {
          await exportCurrentConversation();
          return;
        }
      } catch (error) {
        stopFeedbackDrift();
        const message = progressMessage(error);
        if (action === "refresh-current") {
          setExportFeedback("error", message, 100, "current", "refresh");
          scheduleExportFeedbackReset(2400);
          addRuntimeLog("refresh_error", "当前对话刷新失败", {
            conversationId: currentConversationId() || "",
            category: error?.category || "",
            message
          });
        }
        syncPanelDom(overlay);
      }
    };

    overlay.onchange = (event) => {
      const startInput = event.target.closest?.("[data-date-range-start]");
      const endInput = event.target.closest?.("[data-date-range-end]");
      if (!startInput && !endInput) return;
      const current = normalizeDateRange(state.dateRange);
      state.dateRange = {
        ...current,
        enabled: true,
        startDate: startInput ? sanitizeDateInput(startInput.value) : current.startDate,
        endDate: endInput ? sanitizeDateInput(endInput.value) : current.endDate
      };
      syncPanelDom(overlay);
    };
  }

  function renderPanel() {
    let overlay = document.getElementById(`${APP_ID}-overlay`);
    if (!state.open) {
      overlay?.remove();
      return;
    }

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = `${APP_ID}-overlay`;
      document.body.appendChild(overlay);
      overlay.className = "dbx-overlay";
      overlay.innerHTML = panelHtml();
      bindPanel(overlay);
      syncDialogFrame(overlay);
      return;
    }

    if (!overlay.querySelector(".dbx-dialog")) {
      overlay.className = "dbx-overlay";
      overlay.innerHTML = panelHtml();
      bindPanel(overlay);
      syncDialogFrame(overlay);
      return;
    }

    syncPanelDom(overlay);
  }

  function observePage() {
    if (window.__doubaoExportObserved) return;
    window.__doubaoExportObserved = true;

    let lastUrl = normalizedUrl(location.href);
    let lastTitle = document.title;
    let timerId = 0;

    const syncView = () => {
      createTrigger();
      collectSidebarSummaries();
      const conversationId = currentConversationId();
      if (conversationId) {
        updateSummary({
          id: conversationId,
          title: documentConversationTitle(),
          url: currentConversationUrl(conversationId)
        });
      }
      if (state.open) renderPanel();
    };

    const scheduleSync = () => {
      window.clearTimeout(timerId);
      timerId = window.setTimeout(() => {
        const nextUrl = normalizedUrl(location.href);
        const nextTitle = document.title;
        const changed = nextUrl !== lastUrl || nextTitle !== lastTitle;
        lastUrl = nextUrl;
        lastTitle = nextTitle;
        if (changed) syncView();
        else createTrigger();
      }, 120);
    };

    const observer = new MutationObserver(scheduleSync);
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });

    window.addEventListener("popstate", scheduleSync);
    ["pushState", "replaceState"].forEach((name) => {
      const raw = history[name];
      if (typeof raw !== "function" || raw.__doubaoExportWrapped) return;
      const wrapped = function (...args) {
        const result = raw.apply(this, args);
        scheduleSync();
        return result;
      };
      wrapped.__doubaoExportWrapped = true;
      history[name] = wrapped;
    });

    window.setInterval(() => {
      if (normalizedUrl(location.href) !== lastUrl || document.title !== lastTitle) {
        scheduleSync();
      } else {
        createTrigger();
      }
    }, 2000);
  }

  async function init() {
    if (window.__doubaoExportInitialized) return;
    window.__doubaoExportInitialized = true;

    await loadCache();
    await loadRuntimeState();
    if (state.cache.webTabId) {
      rememberWebTabId(state.cache.webTabId);
    }

    injectBridge();
    window.addEventListener("message", handleBridgeMessage);
    createTrigger();
    collectSidebarSummaries();

    const conversationId = currentConversationId();
    if (conversationId) {
      updateSummary({
        id: conversationId,
        title: documentConversationTitle(),
        url: currentConversationUrl(conversationId)
      });
    }

    observePage();
    window.setTimeout(() => {
      ensureCurrentConversationFresh(false).catch((error) => {
        console.debug(`[${APP_ID}] warm current conversation failed`, error);
      });
    }, 900);
  }

  init().catch((error) => console.error(`[${APP_ID}] init failed`, error));
})();
