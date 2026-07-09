(function () {
  "use strict";

  const DEFAULT_MESSAGES_PER_PART = 500;
  const DEFAULT_SPLIT_MIN_MESSAGES = 600;
  const DEFAULT_IMAGES_PER_PART = 80;
  const DEFAULT_FILES_PER_PART = 120;
  const DEFAULT_EMBEDDED_IMAGE_CHARS_PER_PART = 8_000_000;
  const PROTOCOL_VERSION = 1;
  const OPFS_ROOT_DIR = "doubao-export-shell";
  const OPFS_MIN_BLOB_BYTES = 8 * 1024 * 1024;
  const activeJobs = new Map();

  function post(type, payload = {}) {
    self.postMessage({
      type,
      protocolVersion: PROTOCOL_VERSION,
      ...payload
    });
  }

  function postComplete(payload, transfer = []) {
    self.postMessage({
      type: "complete",
      protocolVersion: PROTOCOL_VERSION,
      ...payload
    }, transfer);
  }

  function normalizeFormat(value) {
    const format = String(value || "").trim().toLowerCase();
    if (format === "json") return "json";
    if (format === "html") return "html";
    if (format === "txt" || format === "text") return "txt";
    if (format === "markdown" || format === "md") return "md";
    throw new Error(`Unsupported export format: ${format || "empty"}`);
  }

  function normalizeImageMode(value) {
    return String(value || "").trim().toLowerCase() === "embed" ? "embed" : "strip";
  }

  function normalizeTimestampMode(value) {
    return String(value || "").trim().toLowerCase() === "show" ? "show" : "hide";
  }

  function normalizeSplitOptions(value = {}) {
    const messagesPerPart = Math.max(1, Number(value.messagesPerPart || DEFAULT_MESSAGES_PER_PART) || DEFAULT_MESSAGES_PER_PART);
    const minMessages = Math.max(1, Number(value.minMessages || DEFAULT_SPLIT_MIN_MESSAGES) || DEFAULT_SPLIT_MIN_MESSAGES);
    const imagesPerPart = Math.max(1, Number(value.imagesPerPart || DEFAULT_IMAGES_PER_PART) || DEFAULT_IMAGES_PER_PART);
    const filesPerPart = Math.max(1, Number(value.filesPerPart || DEFAULT_FILES_PER_PART) || DEFAULT_FILES_PER_PART);
    const embeddedImageCharsPerPart = Math.max(
      1,
      Number(value.embeddedImageCharsPerPart || DEFAULT_EMBEDDED_IMAGE_CHARS_PER_PART) || DEFAULT_EMBEDDED_IMAGE_CHARS_PER_PART
    );
    const enabled = value.enabled === true || String(value.mode || "").toLowerCase() === "on";
    return {
      enabled,
      force: value.force === true,
      messagesPerPart,
      minMessages,
      imagesPerPart,
      filesPerPart,
      embeddedImageCharsPerPart,
      includeIndex: value.includeIndex !== false,
      includeManifest: value.includeManifest !== false
    };
  }

  function normalizeConversation(value) {
    const conversation = value && typeof value === "object" ? value : {};
    return {
      ...conversation,
      id: String(conversation.id || "").trim(),
      title: String(conversation.title || conversation.id || "Doubao conversation").trim() || "Doubao conversation",
      source: String(conversation.source || "unknown").trim() || "unknown",
      messages: Array.isArray(conversation.messages) ? conversation.messages.filter(Boolean) : []
    };
  }

  function normalizeOptions(value = {}) {
    return {
      imageMode: normalizeImageMode(value.imageMode),
      timestampMode: normalizeTimestampMode(value.timestampMode)
    };
  }

  function jobState(jobId) {
    if (!activeJobs.has(jobId)) {
      activeJobs.set(jobId, { cancelled: false, tempFiles: [], tempRoot: null, storageMode: "memory" });
    }
    return activeJobs.get(jobId);
  }

  function assertNotCancelled(jobId) {
    if (activeJobs.get(jobId)?.cancelled) {
      const error = new Error("Export cancelled");
      error.name = "AbortError";
      throw error;
    }
  }

  function progress(jobId, phase, loaded, total, message, extra = {}) {
    const safeTotal = Math.max(1, Number(total || 1));
    const safeLoaded = Math.min(safeTotal, Math.max(0, Number(loaded || 0)));
    post("progress", {
      jobId,
      phase,
      loaded: safeLoaded,
      total: safeTotal,
      progress: Math.round((safeLoaded / safeTotal) * 100),
      message,
      ...extra
    });
  }

  function sanitizeFileName(value) {
    return String(value || "doubao-chat")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "doubao-chat";
  }

  function fileNameForConversation(conversation, index, extension, usedNames) {
    const prefix = String(index + 1).padStart(2, "0");
    const rawBase = sanitizeFileName(conversation?.title || conversation?.id || `doubao-chat-${index + 1}`);
    let baseName = rawBase ? `${prefix}-${rawBase}` : `${prefix}-doubao-chat`;
    while (usedNames.has(baseName)) {
      baseName = `${baseName}-${String(conversation?.id || index + 1).slice(-6)}`;
    }
    usedNames.add(baseName);
    return `${baseName}.${extension}`;
  }

  function extensionForFormat(format) {
    const normalized = normalizeFormat(format);
    if (normalized === "json") return "json";
    if (normalized === "html") return "html";
    if (normalized === "txt") return "txt";
    return "md";
  }

  function mimeTypeForFormat(format) {
    const normalized = normalizeFormat(format);
    if (normalized === "json") return "application/json;charset=utf-8";
    if (normalized === "html") return "text/html;charset=utf-8";
    if (normalized === "txt") return "text/plain;charset=utf-8";
    return "text/markdown;charset=utf-8";
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
      if (!key || seen.has(key)) return;
      seen.add(key);
      output.push(paragraph);
    });
    return output.join("\n\n").trim();
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

  function roleLabel(role) {
    const normalized = String(role || "").trim().toLowerCase();
    if (normalized === "user") return "User";
    if (normalized === "system") return "System";
    return "Doubao";
  }

  function textRoleLabel(role) {
    const normalized = String(role || "").trim().toLowerCase();
    if (normalized === "user") return "用户";
    if (normalized === "system") return "系统";
    return "豆包";
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

  function captureStateOfConversation(conversation) {
    const messageCount = Array.isArray(conversation?.messages)
      ? conversation.messages.length
      : Number(conversation?.messageCount || 0);
    return normalizeCaptureState(conversation?.captureState, messageCount, Boolean(conversation?.full));
  }

  function captureStateLabel(value) {
    if (value === "full") return "full";
    if (value === "partial") return "partial";
    if (value === "summary_only") return "summary only";
    if (value === "failed") return "failed";
    return "unknown";
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
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join("-") + " " + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join(":");
  }

  function imageVariantPriority(value) {
    return {
      image_ori: 3,
      image_preview: 2,
      image_thumb: 1
    }[String(value || "").trim().toLowerCase()] || 0;
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

  function typoraFriendlyImageUrl(value) {
    const url = String(value || "").trim().toLowerCase();
    if (!url) return false;
    return /\.(png|jpe?g|gif|webp|bmp|svg|image)(?:[?#]|$)/i.test(url)
      && !/\.heic(?:[?#]|$)/i.test(url);
  }

  function imageAttachmentPriority(attachment) {
    const url = String(attachment?.url || "");
    let priority = imageVariantPriority(attachment?.imageVariant || imageVariantFromUrl(url)) * 1000;
    if (attachment?.imageReference === "reference") priority += 80;
    if (!isExpiredSignedImageUrl(url)) priority += 60;
    if (typoraFriendlyImageUrl(url)) priority += 30;
    if (/~tplv-[^/?#]*-image_raw\./i.test(url)) priority += 20;
    if (/~tplv-[^/?#]*-(?:heic|private)\.heic/i.test(url)) priority -= 25;
    return priority;
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

  function messageAttachments(message) {
    if (Array.isArray(message?.attachments) && message.attachments.length) return normalizeAttachments(message.attachments);
    return normalizeAttachments((Array.isArray(message?.parts) ? message.parts : [])
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

  function attachmentKind(attachment) {
    const explicitType = String(attachment?.type || attachment?.attachmentType || "").trim().toLowerCase();
    if (explicitType === "image") return "image";
    const name = String(attachment?.name || "").trim().toLowerCase();
    const url = String(attachment?.url || "").trim().toLowerCase();
    return /\.(png|jpg|jpeg|gif|webp|bmp|svg|image)(\?|#|$)/i.test(`${name} ${url}`) ? "image" : "file";
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

  function markdownLinesFromAttachments(message, options = {}) {
    return messageAttachments(message)
      .map((attachment) => {
        const url = String(attachment?.url || "").trim();
        if (!url) return "";
        const kind = attachmentKind(attachment);
        if (kind === "image" && shouldSkipImageAttachmentInMarkdown(message, attachment)) return "";
        if (kind === "image" && options.imageMode === "strip") return "";
        const label = escapeMarkdownLinkText(attachmentDisplayName(attachment, kind === "image" ? "image" : "attachment"));
        if (kind === "image" && attachment?.unavailable) {
          return `> 用户上传图片已失效，源站未返回可用文件：${label}`;
        }
        return kind === "image" ? `![${label}](${url})` : `[${label}](${url})`;
      })
      .filter(Boolean);
  }

  function renderMarkdown(conversation, options = {}) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const lines = [
      `# ${conversation.title || "Doubao conversation"}`,
      "",
      `- Conversation ID: ${conversation.id || ""}`,
      `- Messages: ${messages.length}`,
      `- Source: ${conversation.source || "unknown"} (${captureStateLabel(captureStateOfConversation(conversation))})`,
      `- Exported at: ${new Date().toISOString()}`,
      ""
    ];

    messages.forEach((message) => {
      const textLines = markdownLinesFromMessageParts(message);
      const attachmentLines = markdownLinesFromAttachments(message, options);
      const contentLines = textLines.length && attachmentLines.length
        ? [...textLines, "", ...attachmentLines]
        : [...textLines, ...attachmentLines];
      if (!contentLines.length) return;

      const timestamp = options.timestampMode === "show" ? formatMessageTimestamp(messageTimestampValue(message)) : "";
      lines.push(timestamp ? `## ${roleLabel(message.role)} - ${timestamp}` : `## ${roleLabel(message.role)}`);
      lines.push("");
      lines.push(...contentLines);
      lines.push("");
    });

    return lines.join("\n").trim() + "\n";
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

  function renderText(conversation, options = {}) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const lines = [
      `标题：${conversation.title || "Doubao conversation"}`,
      `会话 ID：${conversation.id || ""}`,
      `消息数：${messages.length}`,
      `来源：${conversation.source || "unknown"} (${captureStateLabel(captureStateOfConversation(conversation))})`,
      `导出时间：${new Date().toISOString()}`
    ];
    const body = [];
    messages.forEach((message) => {
      const contentLines = textLinesFromMessageParts(message);
      if (!contentLines.length) return;
      const timestamp = options.timestampMode === "show" ? formatMessageTimestamp(messageTimestampValue(message)) : "";
      body.push(timestamp ? `${textRoleLabel(message.role)} - ${timestamp}` : textRoleLabel(message.role));
      body.push(...contentLines);
      body.push("");
    });
    if (body.length) {
      lines.push("", "----------------------------------------", "", body.join("\n").trim());
    }
    return lines.join("\n").trim() + "\n";
  }

  function messageHasRenderableContent(message, format, options = {}) {
    if (format === "json") return true;
    if (format === "txt") return textLinesFromMessageParts(message).length > 0;
    return markdownLinesFromMessageParts(message).length > 0
      || markdownLinesFromAttachments(message, options).length > 0;
  }

  function conversationForRender(conversation, format, options = {}) {
    if (format === "json") return conversation;
    const messages = (Array.isArray(conversation?.messages) ? conversation.messages : [])
      .filter((message) => messageHasRenderableContent(message, format, options));
    return {
      ...conversation,
      messages
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

  function normalizedUrlForProtocolCheck(value) {
    return String(value || "").trim().replace(/[\u0000-\u001f\u007f\s]+/g, "");
  }

  function isSafeDataImageUrl(value) {
    const normalized = normalizedUrlForProtocolCheck(value);
    const match = normalized.match(/^data:image\/([a-z0-9.+-]+)(?:;[a-z0-9.+-]+=[^;,]*)*;base64,[a-z0-9+/]+=*$/i);
    return Boolean(match && String(match[1] || "").toLowerCase() !== "svg+xml");
  }

  function safeMarkdownUrlForHtml(value, options = {}) {
    const url = String(value || "").trim();
    if (!url) return "";
    const normalized = normalizedUrlForProtocolCheck(url);
    const schemeMatch = normalized.match(/^([a-z][a-z0-9+.-]*):/i);
    if (!schemeMatch) return url;
    const scheme = String(schemeMatch[1] || "").toLowerCase();
    if (scheme === "http" || scheme === "https" || scheme === "mailto") return url;
    if (options.allowDataImage && scheme === "data" && isSafeDataImageUrl(url)) return url;
    return "";
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
    working = working.replace(/`([^`\n]+)`/g, (_match, code) => stash(`<code>${escapeHtmlText(code)}</code>`));
    working = escapeHtmlText(working);
    working = working.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_match, alt, url) => {
      const safeUrl = safeMarkdownUrlForHtml(url, { allowDataImage: true });
      return safeUrl ? `<img src="${safeUrl}" alt="${alt}" loading="lazy">` : alt;
    });
    working = working.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_match, label, url) => {
      const safeUrl = safeMarkdownUrlForHtml(url);
      return safeUrl ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
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

    working = lineOutput.join("\n").split(/\n{2,}/).map((paragraph) => {
      const trimmed = paragraph.trim();
      if (!trimmed) return "";
      if (/^<(h[1-6]|ul|ol|pre|blockquote|img|div|table|hr)\b/i.test(trimmed)) return trimmed;
      if (/^\u0000PH\d+\u0000$/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, "<br/>")}</p>`;
    }).filter(Boolean).join("\n");

    return working.replace(/\u0000PH(\d+)\u0000/g, (_match, index) => placeholders[Number(index)] || "");
  }

  const HTML_EXPORT_STYLE = [
    ":root{color-scheme:light;--bg:#f8faf9;--surface:#ffffff;--surface-muted:#eef4f1;--text:#1f2933;--text-muted:#5f6f7a;--border:#dbe5df;--accent:#177e6f;--user:#e3f4ee;--code:#edf2f1;--measure:72ch}",
    "*,*::before,*::after{box-sizing:border-box}",
    "html,body{margin:0;padding:0}",
    "body{font-family:system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;font-size:15.5px;line-height:1.7;color:var(--text);background:var(--bg)}",
    ".page-head{border-bottom:1px solid var(--border);background:var(--surface);padding:28px clamp(20px,5vw,48px) 20px}",
    ".page-head-inner{max-width:var(--measure);margin:0 auto;display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap}",
    "h1{margin:0;font-size:22px;font-weight:650;word-break:break-word}",
    ".meta{display:flex;flex-wrap:wrap;gap:6px 12px;color:var(--text-muted);font-size:12.5px;justify-content:flex-end}",
    ".chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid var(--border);border-radius:999px;background:var(--surface-muted);white-space:nowrap}",
    ".chip b{font-weight:600;font-size:11.5px;text-transform:uppercase}",
    ".toolbar{position:sticky;top:0;z-index:10;background:rgba(248,250,249,.92);border-bottom:1px solid var(--border);padding:10px clamp(20px,5vw,48px)}",
    ".toolbar-inner{max-width:var(--measure);margin:0 auto;display:flex;align-items:center;gap:12px}",
    ".toolbar input{flex:1;min-width:0;padding:9px 14px;border:1px solid var(--border);border-radius:8px;font:inherit;color:var(--text);background:var(--surface)}",
    ".hits{font-size:12.5px;color:var(--text-muted);min-width:88px;text-align:right;font-variant-numeric:tabular-nums}",
    "main{max-width:var(--measure);margin:0 auto;padding:32px clamp(20px,5vw,48px) 80px;display:flex;flex-direction:column;gap:28px}",
    ".msg{padding:18px 4px;border-top:1px solid var(--border)}",
    ".msg:first-child{border-top:0;padding-top:8px}",
    ".msg-user{border-radius:8px;padding:18px 20px;background:var(--user);border-top:0;margin-top:4px}",
    ".msg-head{display:flex;align-items:baseline;gap:12px;margin-bottom:10px;color:var(--text-muted);font-size:12px}",
    ".msg-role{font-weight:700;text-transform:uppercase;letter-spacing:.08em;font-size:11.5px}",
    ".msg-idx{margin-left:auto;font-variant-numeric:tabular-nums;font-size:11.5px}",
    ".msg-body{word-wrap:break-word;overflow-wrap:anywhere}",
    ".msg-body>:first-child{margin-top:0}.msg-body>:last-child{margin-bottom:0}",
    ".msg-body p{margin:0 0 12px}.msg-body h1,.msg-body h2,.msg-body h3,.msg-body h4{margin:20px 0 10px;line-height:1.35}",
    ".msg-body code{background:var(--code);padding:2px 4px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em}",
    ".msg-body pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.6;border:1px solid var(--border)}",
    ".msg-body pre code{background:transparent;padding:0;font-size:inherit}",
    ".msg-body img{max-width:100%;height:auto;border-radius:8px;margin:6px 0;display:block}",
    ".msg-body a{color:var(--accent);text-decoration:none}.msg-body a:hover{text-decoration:underline;text-underline-offset:3px}",
    ".msg-body ul,.msg-body ol{margin:0 0 12px;padding-left:24px}.msg-body li{margin:3px 0}",
    ".part-nav{max-width:var(--measure);margin:0 auto;padding:14px clamp(20px,5vw,48px);display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:13.5px;color:var(--text-muted);border-bottom:1px solid var(--border)}",
    ".part-nav-foot{border-bottom:0;border-top:1px solid var(--border)}",
    ".page-foot{max-width:var(--measure);margin:0 auto;padding:20px clamp(20px,5vw,48px);border-top:1px solid var(--border);color:var(--text-muted);font-size:12.5px}",
    "mark.search-hit{background:#ffe08a;color:var(--text);border-radius:3px;padding:0 2px}",
    "@media (max-width:720px){.page-head{padding:22px 18px 14px}.page-head-inner{flex-direction:column;gap:12px}.toolbar{position:static;padding:10px 18px}main{padding:24px 18px 60px;gap:22px}.msg-user{padding:14px 16px}.part-nav,.page-foot{padding:14px 18px}}"
  ].join("");

  const HTML_EXPORT_SCRIPT = [
    "(function(){",
    "var input=document.getElementById('search');var count=document.getElementById('search-count');var root=document.getElementById('messages');if(!input||!root)return;",
    "var bodies=Array.prototype.slice.call(root.querySelectorAll('.msg-body'));",
    "var bodyTexts=bodies.map(function(body){return body.textContent||'';});",
    "function clearMarks(){bodies.forEach(function(body){var marks=body.querySelectorAll('mark.search-hit');for(var i=0;i<marks.length;i++){var m=marks[i];var parent=m.parentNode;if(!parent)continue;while(m.firstChild)parent.insertBefore(m.firstChild,m);parent.removeChild(m);parent.normalize();}});}",
    "function escapeRe(s){return s.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&');}",
    "function countMatches(q){if(!q){if(count)count.textContent='';return;}var re=new RegExp(escapeRe(q),'gi');var hits=0;bodyTexts.forEach(function(text){re.lastIndex=0;var matches=text.match(re);hits+=matches?matches.length:0;});if(count)count.textContent=hits?(hits+' matches, press Enter to highlight'):'No matches';}",
    "function highlightMatches(q){clearMarks();if(!q){if(count)count.textContent='';return;}var re=new RegExp(escapeRe(q),'gi');var hits=0;bodies.forEach(function(node){var walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT,null);var texts=[];var n;while(n=walker.nextNode()){var tag=n.parentNode&&n.parentNode.tagName;if(tag==='SCRIPT'||tag==='STYLE')continue;texts.push(n);}texts.forEach(function(t){var val=t.nodeValue;if(!val)return;re.lastIndex=0;if(!re.test(val))return;re.lastIndex=0;var frag=document.createDocumentFragment();var last=0;var m;while((m=re.exec(val))){if(m.index>last)frag.appendChild(document.createTextNode(val.slice(last,m.index)));var mk=document.createElement('mark');mk.className='search-hit';mk.textContent=m[0];frag.appendChild(mk);last=m.index+m[0].length;hits++;if(m[0].length===0)re.lastIndex++;}if(last<val.length)frag.appendChild(document.createTextNode(val.slice(last)));t.parentNode.replaceChild(frag,t);});});if(count)count.textContent=hits?(hits+' matches'):'No matches';}",
    "var timer=0;input.addEventListener('input',function(){window.clearTimeout(timer);timer=window.setTimeout(function(){clearMarks();countMatches(input.value.trim());},250);});input.addEventListener('keydown',function(e){if(e.key==='Enter'){window.clearTimeout(timer);highlightMatches(input.value.trim());}if(e.key==='Escape'){input.value='';window.clearTimeout(timer);highlightMatches('');input.blur();}});",
    "})();"
  ].join("");

  function htmlMetaBlock(conversation) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const chips = [
      ["Conversation", conversation.id ? String(conversation.id).slice(-12) : "-"],
      ["Messages", String(messages.length)],
      ["Source", `${conversation.source || "unknown"} / ${captureStateLabel(captureStateOfConversation(conversation))}`],
      ["Exported", new Date().toISOString().replace("T", " ").slice(0, 19)]
    ];
    return `<div class="meta">${chips.map(([label, value]) => `<span class="chip"><b>${escapeHtmlText(label)}</b><span>${escapeHtmlText(value)}</span></span>`).join("")}</div>`;
  }

  function renderHtmlMessages(conversation, options = {}) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    return messages.map((message, index) => {
      const textLines = markdownLinesFromMessageParts(message);
      const attachmentLines = markdownLinesFromAttachments(message, options);
      const allLines = textLines.length && attachmentLines.length
        ? [...textLines, "", ...attachmentLines]
        : [...textLines, ...attachmentLines];
      if (!allLines.length) return "";

      const role = String(message.role || "assistant").toLowerCase();
      const timestamp = options.timestampMode === "show" ? formatMessageTimestamp(messageTimestampValue(message)) : "";
      const indexNumber = Number(message?.metadata?.index) || (index + 1);
      return [
        `<section class="msg msg-${escapeHtmlText(role)}" data-msg-index="${indexNumber}">`,
        '<header class="msg-head">',
        `<span class="msg-role">${escapeHtmlText(roleLabel(role))}</span>`,
        timestamp ? `<time class="msg-time">${escapeHtmlText(timestamp)}</time>` : "",
        `<span class="msg-idx">#${indexNumber}</span>`,
        "</header>",
        `<div class="msg-body">${markdownToHtml(allLines.join("\n\n"))}</div>`,
        "</section>"
      ].filter(Boolean).join("");
    }).filter(Boolean).join("\n");
  }

  function renderHtml(conversation, options = {}) {
    const title = conversation.title || "Doubao conversation";
    const partNav = options.partNav || "";
    const partNavFoot = partNav ? partNav.replace('class="part-nav"', 'class="part-nav part-nav-foot"') : "";
    const exportedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
    return [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      `<title>${escapeHtmlText(title)}</title>`,
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      `<style>${HTML_EXPORT_STYLE}</style>`,
      "</head>",
      "<body>",
      '<header class="page-head"><div class="page-head-inner">',
      `<h1>${escapeHtmlText(title)}</h1>`,
      htmlMetaBlock(conversation),
      "</div></header>",
      '<div class="toolbar"><div class="toolbar-inner"><input type="search" id="search" aria-label="Search messages" placeholder="Search"><span id="search-count" class="hits" aria-live="polite"></span></div></div>',
      partNav,
      '<main id="messages">',
      renderHtmlMessages(conversation, options),
      "</main>",
      partNavFoot,
      `<footer class="page-foot">Exported by Doubao Export Shell at ${escapeHtmlText(exportedAt)}</footer>`,
      `<script>${HTML_EXPORT_SCRIPT}</script>`,
      "</body>",
      "</html>",
      ""
    ].filter(Boolean).join("\n");
  }

  function messageSplitMetrics(message) {
    return messageAttachments(message).reduce((metrics, attachment) => {
      if (attachmentKind(attachment) === "image") {
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

  function shouldSplitConversation(messages, splitOptions) {
    const metrics = conversationSplitMetrics(messages);
    return metrics.messages >= splitOptions.minMessages
      || metrics.images >= splitOptions.imagesPerPart
      || metrics.files >= splitOptions.filesPerPart
      || metrics.embeddedImageChars >= splitOptions.embeddedImageCharsPerPart;
  }

  function splitPartsForConversation(messages, splitOptions) {
    const source = Array.isArray(messages) ? messages : [];
    const rawParts = [];
    let start = 0;
    let current = [];
    let metrics = { images: 0, files: 0, embeddedImageChars: 0 };

    source.forEach((message, index) => {
      const next = messageSplitMetrics(message);
      const wouldExceed = current.length > 0 && (
        current.length >= splitOptions.messagesPerPart
        || metrics.images + next.images > splitOptions.imagesPerPart
        || metrics.files + next.files > splitOptions.filesPerPart
        || metrics.embeddedImageChars + next.embeddedImageChars > splitOptions.embeddedImageCharsPerPart
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

  function partNavHtml(part, parts) {
    if (!part || parts.length <= 1) return "";
    const prevPart = parts[part.index - 2];
    const nextPart = parts[part.index];
    const prevLink = prevPart ? `<a href="${escapeHtmlText(prevPart.filename)}">Previous</a>` : "<span></span>";
    const nextLink = nextPart ? `<a href="${escapeHtmlText(nextPart.filename)}">Next</a>` : "<span></span>";
    const center = `<span>Part ${part.index} / ${part.total} - <a href="index.html">Index</a></span>`;
    return `<nav class="part-nav">${prevLink}${center}${nextLink}</nav>`;
  }

  function renderSplitIndexMarkdown(conversation, parts, manifest) {
    const lines = [
      `# ${conversation.title || "Doubao conversation"} split index`,
      "",
      `- Conversation ID: ${conversation.id || ""}`,
      `- Total messages: ${manifest.totalMessages}`,
      `- Total parts: ${manifest.totalParts}`,
      `- Messages per part: ${manifest.messagesPerPart}`,
      `- Format: ${manifest.format.toUpperCase()}`,
      `- Exported at: ${manifest.exportedAt}`,
      "",
      "## Parts",
      ""
    ];
    parts.forEach((part) => {
      lines.push(`- [Part ${part.index} messages #${part.rangeStart}-#${part.rangeEnd}](${part.filename})`);
    });
    return lines.join("\n") + "\n";
  }

  function renderSplitIndexText(conversation, parts, manifest) {
    const lines = [
      `${conversation.title || "Doubao conversation"} split index`,
      "",
      `Conversation ID: ${conversation.id || ""}`,
      `Total messages: ${manifest.totalMessages}`,
      `Total parts: ${manifest.totalParts}`,
      `Messages per part: ${manifest.messagesPerPart}`,
      `Format: ${manifest.format.toUpperCase()}`,
      `Exported at: ${manifest.exportedAt}`,
      "",
      "Parts",
      ""
    ];
    parts.forEach((part) => {
      lines.push(`Part ${part.index}: ${part.filename}, messages #${part.rangeStart}-#${part.rangeEnd}, ${part.messages.length} messages`);
    });
    return lines.join("\n") + "\n";
  }

  function renderSplitIndexHtml(conversation, parts, manifest) {
    const links = parts.map((part) => {
      return `<li><a href="${escapeHtmlText(part.filename)}">Part ${part.index}: messages #${part.rangeStart}-#${part.rangeEnd}</a></li>`;
    }).join("");
    return [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      `<title>${escapeHtmlText(conversation.title || "Doubao conversation")} split index</title>`,
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      "<style>body{font-family:system-ui,sans-serif;line-height:1.7;max-width:72ch;margin:0 auto;padding:40px 20px;color:#1f2933;background:#f8faf9}a{color:#177e6f}li{margin:8px 0}.meta{color:#5f6f7a;font-size:14px}</style>",
      "</head>",
      "<body>",
      `<h1>${escapeHtmlText(conversation.title || "Doubao conversation")} split index</h1>`,
      `<p class="meta">${manifest.totalMessages} messages / ${manifest.totalParts} parts / ${manifest.format.toUpperCase()}</p>`,
      `<ul>${links}</ul>`,
      "</body>",
      "</html>",
      ""
    ].join("\n");
  }

  async function createTextBlob(text, mimeType) {
    if (typeof ReadableStream === "function" && typeof Response === "function" && typeof TextEncoder === "function") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(String(text || "")));
          controller.close();
        }
      });
      return new Response(stream, { headers: { "Content-Type": mimeType } }).blob();
    }
    return new Blob([String(text || "")], { type: mimeType });
  }

  async function getDirectory(root, name, options = {}) {
    if (!root || typeof root.getDirectoryHandle !== "function") return null;
    return root.getDirectoryHandle(name, options);
  }

  async function getFile(root, name, options = {}) {
    if (!root || typeof root.getFileHandle !== "function") return null;
    return root.getFileHandle(name, options);
  }

  async function removeEntry(root, name, options = {}) {
    if (!root || typeof root.removeEntry !== "function") return;
    try {
      await root.removeEntry(name, options);
    } catch (error) {
      // Temporary cleanup must never fail the export result.
    }
  }

  function safePathSegments(value) {
    return String(value || "file")
      .split("/")
      .map((segment) => sanitizeFileName(segment))
      .filter(Boolean);
  }

  async function createOpfsTempRoot(jobId) {
    if (!navigator?.storage?.getDirectory) return null;
    const originRoot = await navigator.storage.getDirectory();
    const appRoot = await getDirectory(originRoot, OPFS_ROOT_DIR, { create: true });
    if (!appRoot) return null;
    const tempName = `job-${sanitizeFileName(jobId)}-${Date.now()}`;
    return {
      originRoot,
      appRoot,
      tempName,
      dir: await getDirectory(appRoot, tempName, { create: true })
    };
  }

  async function writeOpfsBlob(tempRoot, name, blob) {
    const segments = safePathSegments(name);
    const fileName = segments.pop() || "file";
    let current = tempRoot.dir;
    for (const segment of segments) {
      current = await getDirectory(current, segment, { create: true });
    }
    const fileHandle = await getFile(current, fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(blob);
    } finally {
      await writable.close();
    }
    return fileHandle;
  }

  async function fileBlob(file) {
    if (file?.fileHandle && typeof file.fileHandle.getFile === "function") {
      try {
        return await file.fileHandle.getFile();
      } catch (error) {
        if (file.blob instanceof Blob) return file.blob;
        throw error;
      }
    }
    return file.blob;
  }

  async function cleanupJobTemp(jobId) {
    const job = activeJobs.get(jobId);
    if (!job?.tempRoot) return;
    await removeEntry(job.tempRoot.appRoot, job.tempRoot.tempName, { recursive: true });
    job.tempRoot = null;
    job.tempFiles = [];
  }

  async function makeFile(name, content, mimeType, format, role, part = null) {
    const blob = content instanceof Blob ? content : await createTextBlob(content, mimeType);
    const job = makeFile.jobId ? activeJobs.get(makeFile.jobId) : null;
    if (job?.tempRoot && blob.size >= OPFS_MIN_BLOB_BYTES) {
      try {
        const fileHandle = await writeOpfsBlob(job.tempRoot, name, blob);
        const file = {
          name,
          mimeType,
          format,
          role,
          part,
          size: blob.size,
          storage: "opfs",
          fileHandle,
          blob
        };
        job.tempFiles.push(file);
        return file;
      } catch (error) {
        job.tempRoot = null;
        job.storageMode = "memory";
        post("progress", {
          jobId: makeFile.jobId,
          phase: "storage",
          loaded: 1,
          total: 1,
          progress: 100,
          message: "OPFS failed, using memory fallback"
        });
      }
    }
    return {
      name,
      mimeType,
      format,
      role,
      part,
      size: blob.size,
      storage: "memory",
      blob
    };
  }

  function renderConversation(conversation, format, options) {
    if (format === "json") return JSON.stringify(conversation, null, 2);
    if (format === "txt") return renderText(conversation, { ...options, imageMode: "strip" });
    return format === "html" ? renderHtml(conversation, options) : renderMarkdown(conversation, options);
  }

  async function buildSingleFile(jobId, conversation, format, options, filenameBase) {
    assertNotCancelled(jobId);
    makeFile.jobId = jobId;
    progress(jobId, "render", 0, 1, "Rendering conversation");
    const content = renderConversation(conversation, format, options);
    assertNotCancelled(jobId);
    progress(jobId, "blob", 1, 1, "Creating Blob");
    return [
      await makeFile(
        `${filenameBase}.${extensionForFormat(format)}`,
        content,
        mimeTypeForFormat(format),
        format,
        "document"
      )
    ];
  }

  async function buildSplitFiles(jobId, conversation, format, options, splitOptions, filenameBase) {
    makeFile.jobId = jobId;
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const rawParts = splitPartsForConversation(messages, splitOptions);
    const extension = extensionForFormat(format);
    const mimeType = mimeTypeForFormat(format);
    const parts = rawParts.map((part) => ({
      ...part,
      filename: `part-${String(part.index).padStart(3, "0")}.${extension}`
    }));
    const files = [];

    for (let index = 0; index < parts.length; index += 1) {
      assertNotCancelled(jobId);
      const part = parts[index];
      progress(jobId, "render", index, parts.length, `Rendering part ${part.index} of ${parts.length}`, {
        partIndex: part.index,
        partTotal: parts.length
      });
      const partConversation = {
        ...conversation,
        title: `${conversation.title || "Doubao conversation"} - Part ${part.index}/${part.total}`,
        messages: part.messages,
        partInfo: {
          index: part.index,
          total: part.total,
          rangeStart: part.rangeStart,
          rangeEnd: part.rangeEnd,
          parentId: conversation.id,
          parentTitle: conversation.title || ""
        }
      };
      const partOptions = format === "html"
        ? { ...options, partNav: partNavHtml(part, parts) }
        : options;
      const content = renderConversation(partConversation, format, partOptions);
      files.push(await makeFile(`${filenameBase}/${part.filename}`, content, mimeType, format, "part", {
        index: part.index,
        total: part.total,
        rangeStart: part.rangeStart,
        rangeEnd: part.rangeEnd
      }));
    }

    const manifest = {
      id: conversation.id,
      title: conversation.title || "Doubao conversation",
      totalMessages: messages.length,
      totalParts: parts.length,
      messagesPerPart: splitOptions.messagesPerPart,
      imagesPerPart: splitOptions.imagesPerPart,
      filesPerPart: splitOptions.filesPerPart,
      embeddedImageCharsPerPart: splitOptions.embeddedImageCharsPerPart,
      format,
      exportedAt: new Date().toISOString(),
      filesAreUnzipped: true,
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

    if (splitOptions.includeManifest) {
      files.push(await makeFile(`${filenameBase}/manifest.json`, JSON.stringify(manifest, null, 2), "application/json;charset=utf-8", "json", "manifest"));
    }
    if (splitOptions.includeIndex) {
      const indexFormat = format === "html" ? "html" : format === "txt" ? "txt" : "md";
      const indexContent = format === "html"
        ? renderSplitIndexHtml(conversation, parts, manifest)
        : format === "txt"
          ? renderSplitIndexText(conversation, parts, manifest)
          : renderSplitIndexMarkdown(conversation, parts, manifest);
      files.push(await makeFile(`${filenameBase}/index.${indexFormat}`, indexContent, mimeTypeForFormat(indexFormat), indexFormat, "index"));
    }

    progress(jobId, "blob", parts.length, parts.length, "Created split file Blobs");
    return files;
  }

  async function packageFilesAsZip(jobId, files, filename) {
    assertNotCancelled(jobId);
    if (typeof self.JSZip !== "function") {
      importScripts("lib/jszip.min.js");
    }
    const Zip = self.JSZip;
    if (typeof Zip !== "function") throw new Error("ZIP library is unavailable");
    const zip = new Zip();
    for (let index = 0; index < files.length; index += 1) {
      assertNotCancelled(jobId);
      const file = files[index];
      zip.file(file.name, await fileBlob(file));
      progress(jobId, "zip_add", index + 1, files.length, `Adding file ${index + 1} of ${files.length}`);
    }
    const totalBytes = files.reduce((sum, file) => sum + Number(file?.size || 0), 0);
    const largeZip = totalBytes >= 8 * 1024 * 1024 || files.length > 20;
    const blob = await zip.generateAsync(
      {
        type: "blob",
        compression: largeZip ? "STORE" : "DEFLATE",
        compressionOptions: largeZip ? undefined : { level: 6 },
        streamFiles: true
      },
      (metadata) => {
        post("progress", {
          jobId,
          phase: "zip_compress",
          loaded: Math.round(Number(metadata?.percent || 0)),
          total: 100,
          progress: Math.round(Number(metadata?.percent || 0)),
          message: "Compressing ZIP"
        });
      }
    );
    return {
      filename,
      mimeType: "application/zip",
      blob
    };
  }

  async function buildAssetFiles(jobId, assets, prefix = "") {
    makeFile.jobId = jobId;
    const files = [];
    const normalizedPrefix = String(prefix || "");
    const normalizedAssets = Array.isArray(assets) ? assets : [];
    for (let index = 0; index < normalizedAssets.length; index += 1) {
      assertNotCancelled(jobId);
      const asset = normalizedAssets[index] || {};
      const relativePath = String(asset.relativePath || "").replace(/^[/\\]+/, "");
      if (!relativePath || !(asset.blob instanceof Blob)) continue;
      files.push(await makeFile(
        `${normalizedPrefix}${relativePath}`,
        asset.blob,
        asset.mimeType || asset.blob.type || "application/octet-stream",
        "asset",
        "asset"
      ));
    }
    return files;
  }

  async function handleExport(message) {
    const jobId = String(message.jobId || message.id || `export-${Date.now()}`);
    activeJobs.set(jobId, { cancelled: false, tempFiles: [], tempRoot: null, storageMode: "memory" });

    try {
      const format = normalizeFormat(message.format);
      const options = normalizeOptions(message.options || message.renderOptions || {});
      const renderOptions = format === "txt" ? { ...options, imageMode: "strip" } : options;
      const conversation = conversationForRender(normalizeConversation(message.conversation), format, renderOptions);
      const splitOptions = normalizeSplitOptions(message.splitOptions || {});
      const filenameBase = sanitizeFileName(message.filenameBase || conversation.title || conversation.id || "doubao-chat");
      const assetFiles = format === "txt" ? [] : Array.isArray(message.assetFiles) ? message.assetFiles : [];

      if (!conversation.messages.length) {
        throw new Error("No conversation messages available");
      }

      post("started", {
        jobId,
        format,
        messageCount: conversation.messages.length,
        conversationCount: 1,
        split: splitOptions.enabled || splitOptions.force
      });

      const job = jobState(jobId);
      try {
        job.tempRoot = await createOpfsTempRoot(jobId);
        job.storageMode = job.tempRoot ? "opfs" : "memory";
      } catch (error) {
        job.tempRoot = null;
        job.storageMode = "memory";
        post("progress", {
          jobId,
          phase: "storage",
          loaded: 0,
          total: 1,
          progress: 0,
          message: "OPFS unavailable, using memory fallback"
        });
      }
      post("storage", {
        jobId,
        mode: job.storageMode
      });

      const shouldSplit = splitOptions.force || (splitOptions.enabled && shouldSplitConversation(conversation.messages, splitOptions));
      const files = shouldSplit
        ? await buildSplitFiles(jobId, conversation, format, renderOptions, splitOptions, filenameBase)
        : await buildSingleFile(jobId, conversation, format, renderOptions, filenameBase);
      const assetPrefix = shouldSplit ? `${filenameBase}/` : "";
      files.push(...await buildAssetFiles(jobId, assetFiles, assetPrefix));

      assertNotCancelled(jobId);
      const result = shouldSplit || message.outputMode === "zip" || assetFiles.length
        ? await packageFilesAsZip(jobId, files, `${filenameBase}${shouldSplit ? `-split-${format}` : ""}.zip`)
        : {
          filename: files[0].name,
          mimeType: files[0].mimeType,
          blob: await fileBlob(files[0])
        };
      await cleanupJobTemp(jobId);
      postComplete({
        jobId,
        format,
        split: shouldSplit,
        fileCount: files.length,
        files: files.map((file) => ({
          name: file.name,
          mimeType: file.mimeType,
          format: file.format,
          role: file.role,
          part: file.part,
          size: file.size,
            storage: file.storage
          })),
        result
      });
    } catch (error) {
      await cleanupJobTemp(jobId);
      if (error?.name === "AbortError") {
        post("cancelled", { jobId, message: "Export cancelled" });
        return;
      }
      post("error", {
        jobId,
        name: error?.name || "Error",
        message: error?.message || String(error || "Export failed"),
        stack: error?.stack || ""
      });
    } finally {
      activeJobs.delete(jobId);
    }
  }

  self.addEventListener("message", (event) => {
    const message = event.data || {};
    const type = String(message.type || message.action || "export").toLowerCase();
    const jobId = String(message.jobId || message.id || "");

    if (type === "cancel") {
      if (jobId) {
        jobState(jobId).cancelled = true;
        post("cancelling", { jobId });
      }
      return;
    }

    if (type === "ping") {
      post("pong", { jobId });
      return;
    }

    if (type === "export" || type === "build") {
      handleExport(message);
      return;
    }

    post("error", {
      jobId,
      name: "ProtocolError",
      message: `Unsupported worker message type: ${type}`
    });
  });

  post("ready");
})();
