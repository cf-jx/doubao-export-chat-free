(function () {
  "use strict";

  const currentScript = document.currentScript;
  const appId = currentScript?.dataset?.appId || "doubao-export-shell";
  const eventName = currentScript?.dataset?.eventName || "__DOUBAO_EXPORT_BRIDGE_V3__";

  if (window.__doubaoExportBridgeInstalled) return;
  window.__doubaoExportBridgeInstalled = true;

  const trackedPath = (rawUrl) => {
    try {
      const pathname = new URL(rawUrl, window.location.origin).pathname.toLowerCase();
      return pathname.endsWith("/im/chain/single")
        || pathname.endsWith("/api/im/chain/single")
        || pathname.endsWith("/im/chain/recent_conv")
        || pathname.endsWith("/api/im/chain/recent_conv")
        || pathname.endsWith("/im/conversation/info")
        || pathname.endsWith("/api/im/conversation/info");
    } catch (error) {
      return false;
    }
  };

  const serializeHeaders = (headersLike) => {
    if (!headersLike) return {};
    if (headersLike instanceof Headers) {
      const output = {};
      headersLike.forEach((value, key) => {
        output[String(key).toLowerCase()] = String(value);
      });
      return output;
    }
    if (Array.isArray(headersLike)) {
      const output = {};
      headersLike.forEach((pair) => {
        if (!Array.isArray(pair) || pair.length < 2) return;
        output[String(pair[0]).toLowerCase()] = String(pair[1]);
      });
      return output;
    }
    if (typeof headersLike === "object") {
      const output = {};
      Object.entries(headersLike).forEach(([key, value]) => {
        output[String(key).toLowerCase()] = String(value);
      });
      return output;
    }
    return {};
  };

  const postBridge = (payload) => {
    window.postMessage({
      source: appId,
      type: eventName,
      payload
    }, "*");
  };

  function downloadFromPageWorld(payload) {
    const requestId = payload?.requestId || "";
    try {
      const bytes = payload?.bytes instanceof Uint8Array
        ? payload.bytes
        : new Uint8Array(payload?.bytes || []);
      const blob = new Blob([bytes], {
        type: payload?.mimeType || "application/octet-stream"
      });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = payload?.filename || "doubao-export";
      anchor.rel = "noopener";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
      postBridge({
        kind: "download_result",
        requestId,
        ok: true
      });
    } catch (error) {
      postBridge({
        kind: "download_result",
        requestId,
        ok: false,
        message: error?.message || String(error || "Download failed")
      });
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== appId || data.type !== eventName) return;
    const payload = data.payload;
    if (payload?.kind === "download") {
      downloadFromPageWorld(payload);
    }
  });

  const tryPostResponse = (url, method, status, text) => {
    if (!trackedPath(url) || !text) return;
    try {
      const data = JSON.parse(text);
      postBridge({
        kind: "response",
        url,
        method,
        status,
        data
      });
    } catch (error) {
      // Ignore non-JSON bodies.
    }
  };

  const rawFetch = window.fetch;
  window.fetch = async function (...args) {
    const input = args[0];
    const init = args[1];
    const url = typeof input === "string" ? input : input?.url || "";
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    try {
      if (trackedPath(url)) {
        const headers = serializeHeaders(init?.headers || input?.headers);
        if (method !== "GET") {
          let bodyText = "";
          if (typeof init?.body === "string") bodyText = init.body;
          else if (init?.body != null) bodyText = String(init.body);
          else if (typeof Request !== "undefined" && input instanceof Request) {
            input.clone().text().then((text) => {
              postBridge({ kind: "request", url, method, headers, bodyText: text || "" });
            }).catch(() => {
              postBridge({ kind: "request", url, method, headers, bodyText: "" });
            });
          } else {
            postBridge({ kind: "request", url, method, headers, bodyText: "" });
          }
          if (!(typeof Request !== "undefined" && input instanceof Request)) {
            postBridge({ kind: "request", url, method, headers, bodyText });
          }
        }
      }
    } catch (error) {
      // Ignore request capture failures.
    }

    const response = await rawFetch.apply(this, args);
    try {
      const absoluteUrl = typeof url === "string" && url ? new URL(url, window.location.origin).toString() : response.url;
      if (trackedPath(absoluteUrl)) {
        response.clone().text().then((text) => {
          tryPostResponse(absoluteUrl, method, response.status, text);
        }).catch(() => {
          // Ignore response clone failures.
        });
      }
    } catch (error) {
      // Ignore response capture failures.
    }
    return response;
  };

  const rawOpen = XMLHttpRequest.prototype.open;
  const rawSend = XMLHttpRequest.prototype.send;
  const rawSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (...args) {
    this.__doubaoExportMethod = String(args[0] || "GET").toUpperCase();
    this.__doubaoExportUrl = args[1] ? new URL(args[1], window.location.origin).toString() : "";
    this.__doubaoExportHeaders = {};
    return rawOpen.apply(this, args);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (this.__doubaoExportHeaders && name) {
        this.__doubaoExportHeaders[String(name).toLowerCase()] = String(value);
      }
    } catch (error) {
      // Ignore header capture failures.
    }
    return rawSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (trackedPath(this.__doubaoExportUrl)) {
        const bodyText = typeof body === "string" ? body : body != null ? String(body) : "";
        if (this.__doubaoExportMethod !== "GET") {
          postBridge({
            kind: "request",
            url: this.__doubaoExportUrl,
            method: this.__doubaoExportMethod,
            headers: this.__doubaoExportHeaders || {},
            bodyText
          });
        }
        this.addEventListener("load", () => {
          tryPostResponse(
            this.__doubaoExportUrl,
            this.__doubaoExportMethod,
            this.status,
            typeof this.responseText === "string" ? this.responseText : ""
          );
        });
      }
    } catch (error) {
      // Ignore XHR capture failures.
    }
    return rawSend.apply(this, arguments);
  };
})();
