(function () {
  "use strict";

  const DEFAULT_DIALOG_WIDTH = 440;
  const DEFAULT_DIALOG_HEIGHT = 440;
  const EDGE_MARGIN = 16;
  const dialog = document.querySelector("#mock-dialog");
  const currentPanel = document.querySelector("#mock-panel-current");
  const aboutDrawer = document.querySelector("#mock-about-drawer");
  const aboutScrim = document.querySelector(".dbx-about-scrim");
  const aboutAction = document.querySelector(".dbx-about-action");
  const footer = document.querySelector(".dbx-footer");
  const footerMeta = document.querySelector("#mock-footer-meta");
  const secondary = document.querySelector("#mock-secondary");
  const primary = document.querySelector("#mock-primary");
  const state = {
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
    feedback: {
      scope: "",
      state: "idle",
      message: "",
      progress: 0
    },
    windowPosition: {
      left: null,
      top: null
    }
  };
  const sample = {
    current: {
      title: "手机版对话",
      messageCount: 99,
      captureState: "完整",
      source: "页面响应捕获 · 完整",
      requestStatus: "/im/chain/single · 就绪",
      templateStatus: "单条模板已捕获 · 最近模板已捕获",
      latestRecord: "最近同步：今天 09:41"
    }
  };

  let dragSession = null;
  let feedbackTimerId = 0;

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function clampDialogPosition(left, top, width, height) {
    const maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN);
    const maxTop = Math.max(EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN);
    return {
      left: Math.min(Math.max(left, EDGE_MARGIN), maxLeft),
      top: Math.min(Math.max(top, EDGE_MARGIN), maxTop)
    };
  }

  function syncDialogPosition() {
    const styles = [
      `width:min(${DEFAULT_DIALOG_WIDTH}px, calc(100vw - 32px))`,
      `height:min(${DEFAULT_DIALOG_HEIGHT}px, calc(100vh - 32px))`
    ];
    if (Number.isFinite(state.windowPosition.left) && Number.isFinite(state.windowPosition.top)) {
      styles.push("position:absolute");
      styles.push(`left:${state.windowPosition.left}px`);
      styles.push(`top:${state.windowPosition.top}px`);
    }
    dialog.style.cssText = styles.join("; ");
  }

  function resetDialogPosition() {
    state.windowPosition = {
      left: null,
      top: null
    };
    syncDialogPosition();
  }

  function beginDialogDrag(event) {
    if (event.button !== 0) return;
    const rect = dialog.getBoundingClientRect();
    state.windowPosition = {
      left: rect.left,
      top: rect.top
    };
    syncDialogPosition();
    dragSession = {
      pointerId: event.pointerId,
      width: rect.width,
      height: rect.height,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function updateDialogDrag(event) {
    if (!dragSession || event.pointerId !== dragSession.pointerId) return;
    state.windowPosition = clampDialogPosition(
      event.clientX - dragSession.offsetX,
      event.clientY - dragSession.offsetY,
      dragSession.width,
      dragSession.height
    );
    syncDialogPosition();
  }

  function endDialogDrag(event) {
    if (!dragSession || event.pointerId !== dragSession.pointerId) return;
    event.currentTarget?.releasePointerCapture?.(event.pointerId);
    dragSession = null;
  }

  function chevronSvg() {
    return `
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7.75 10.25 12 14.5l4.25-4.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    `;
  }

  function formatIconSvg(format) {
    if (format === "txt") {
      return `
        <svg class="dbx-format-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M7.25 4.75H16.75A1.25 1.25 0 0 1 18 6V18A1.25 1.25 0 0 1 16.75 19.25H7.25A1.25 1.25 0 0 1 6 18V6A1.25 1.25 0 0 1 7.25 4.75Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path>
          <path d="M8.75 9H15.25M8.75 12H15.25M8.75 15H13.25" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
        </svg>
      `;
    }
    if (format === "json") {
      return `
        <svg class="dbx-format-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M8 7C6.5 7 5.75 7.75 5.75 9.25V10.25C5.75 11.35 5.35 12 4.5 12C5.35 12 5.75 12.65 5.75 13.75V14.75C5.75 16.25 6.5 17 8 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
          <path d="M16 7C17.5 7 18.25 7.75 18.25 9.25V10.25C18.25 11.35 18.65 12 19.5 12C18.65 12 18.25 12.65 18.25 13.75V14.75C18.25 16.25 17.5 17 16 17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
        </svg>
      `;
    }
    if (format === "html") {
      return `
        <svg class="dbx-format-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 4.5L6 19.5L12 21L18 19.5L19 4.5H5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path>
          <path d="M8.5 8.25H15.5L15 12L12 12.9L9 12L8.75 10.25" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path>
        </svg>
      `;
    }
    return `
      <svg class="dbx-format-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7.25 4.75H13.5L17.25 8.5V18a1.25 1.25 0 0 1-1.25 1.25H7.25A1.25 1.25 0 0 1 6 18V6A1.25 1.25 0 0 1 7.25 4.75Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path>
        <path d="M13.25 4.75V8.75H17.25" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path>
      </svg>
    `;
  }

  function formatButtonsHtml() {
    const options = [
      { value: "md", label: "Markdown", note: "阅读整理" },
      { value: "html", label: "HTML", note: "网页搜索" },
      { value: "json", label: "JSON", note: "程序处理" },
      { value: "txt", label: "TXT", note: "纯文本" }
    ];
    return options
      .map((option) => {
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
                <span class="dbx-format-label">${option.label}</span>
                <span class="dbx-format-note">${option.note}</span>
              </span>
            </button>
          </div>
        `;
      })
      .join("");
  }

  function markdownSwitchOptionHtml({ label, note, active, toggleAttribute, ariaLabel, optionClass = "" }) {
    return `
      <div class="dbx-bottom-option ${optionClass}">
        <div class="dbx-bottom-option-copy">
          <span class="dbx-bottom-option-label">${label}</span>
          <span class="dbx-bottom-option-note">${note}</span>
        </div>
        <button
          type="button"
          class="dbx-switch ${active ? "is-active" : ""}"
          ${toggleAttribute}="true"
          role="switch"
          aria-checked="${active ? "true" : "false"}"
          aria-label="${ariaLabel}">
          <span class="dbx-switch-thumb" aria-hidden="true"></span>
        </button>
      </div>
    `;
  }

  function sanitizeDateInput(value) {
    const text = String(value || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
  }

  function dateRangeLabel() {
    const startDate = sanitizeDateInput(state.dateRange.startDate);
    const endDate = sanitizeDateInput(state.dateRange.endDate);
    if (!state.dateRange.enabled || (!startDate && !endDate)) return "";
    if (startDate && endDate) return `${startDate} 至 ${endDate}`;
    if (startDate) return `${startDate} 之后`;
    return `${endDate} 之前`;
  }

  function dateRangeControlHtml() {
    const active = Boolean(state.dateRange.enabled);
    const label = dateRangeLabel();
    return `
      <div class="dbx-date-range-option ${active ? "is-active" : ""}">
        ${markdownSwitchOptionHtml({
          label: "按日期范围导出",
          note: active ? label || "选择开始或结束日期后，仅导出范围内消息" : "默认导出全部已捕获消息",
          active,
          toggleAttribute: "data-date-range-toggle",
          ariaLabel: "按日期范围导出"
        })}
        <div class="dbx-date-range-fields" ${active ? "" : "hidden"}>
          <label class="dbx-date-field">
            <span>开始</span>
            <input class="dbx-date-input" type="date" data-date-range-start="true" value="${sanitizeDateInput(state.dateRange.startDate)}" aria-label="开始日期">
          </label>
          <label class="dbx-date-field">
            <span>结束</span>
            <input class="dbx-date-input" type="date" data-date-range-end="true" value="${sanitizeDateInput(state.dateRange.endDate)}" aria-label="结束日期">
          </label>
        </div>
      </div>
    `;
  }

  function bottomToggleHtml() {
    const format = state.format;
    const timestampEnabled = state.timestampMode === "show";
    const timestampNote = timestampEnabled
      ? "会把已捕获的消息时间追加到消息标题"
      : "默认不写出每条消息的发送时间";
    const embedEnabled = state.imageMode === "embed";
    const imageLabel = format === "html" ? "HTML 内嵌图片" : "内嵌图片";
    const imageNote = embedEnabled
      ? "图片会直接写入导出文件"
      : "默认清洗图片，仅保留文字内容";
    const splitEnabled = state.splitMode === "on";
    const splitNote = splitEnabled
      ? "按 500 条 / 80 图 / 120 附件上限分片并打包成 ZIP"
      : "关闭时始终输出单文件";

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
      label: "大对话自动分片",
      note: splitNote,
      active: splitEnabled,
      toggleAttribute: "data-split-mode-toggle",
      ariaLabel: "大对话自动分片",
      optionClass: "dbx-bottom-option--split"
    }));
    parts.push(dateRangeControlHtml());

    return `<div class="dbx-bottom-option-wrap">${parts.join("")}</div>`;
  }

  function diagnosticsSectionHtml(scope, note, content) {
    const open = Boolean(state.diagnostics[scope]);
    return `
      <div class="dbx-diagnostics ${open ? "is-open" : ""}">
        <button
          type="button"
          class="dbx-disclosure"
          data-diagnostics-toggle="${scope}"
          aria-expanded="${open ? "true" : "false"}"
          aria-controls="mock-diagnostics-${scope}">
          <span class="dbx-disclosure-copy">
            <span class="dbx-disclosure-label">高级信息</span>
          <span class="dbx-disclosure-note">${note}</span>
          </span>
          <span class="dbx-disclosure-icon" aria-hidden="true">${chevronSvg()}</span>
        </button>
        <div class="dbx-details-content" id="mock-diagnostics-${scope}" ${open ? "" : "hidden"}>
          ${open ? content : ""}
        </div>
      </div>
    `;
  }

  function currentDiagnosticsHtml() {
    return `
      <div class="dbx-details-stack">
        <div class="dbx-detail-row">
          <span>数据来源</span>
          <strong>${sample.current.source}</strong>
        </div>
        <div class="dbx-detail-row">
          <span>请求状态</span>
          <strong>${sample.current.requestStatus}</strong>
        </div>
        <div class="dbx-detail-row">
          <span>模板状态</span>
          <strong>${sample.current.templateStatus}</strong>
        </div>
        <div class="dbx-detail-row">
          <span>最近记录</span>
          <strong>${sample.current.latestRecord}</strong>
        </div>
      </div>
    `;
  }

  function currentPanelHtml() {
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
          ${diagnosticsSectionHtml("current", "默认收起的补充信息", currentDiagnosticsHtml())}
        </div>
      </div>
    `;
  }

  function aboutPanelHtml() {
    return `
      <div class="dbx-about">
        <div class="dbx-about-header">
          <div class="dbx-about-logo">
            <svg class="dbx-trigger-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 5.75h7.25c2.623 0 4.75 2.127 4.75 4.75v.25c0 2.623-2.127 4.75-4.75 4.75H11l-3.5 2v-2H6A3.25 3.25 0 0 1 2.75 12V9A3.25 3.25 0 0 1 6 5.75Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>
              <path d="M8 9.5h6M8 12.5h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
            </svg>
          </div>
          <div>
            <h3 class="dbx-about-title">豆包导出助手</h3>
            <span class="dbx-about-version">v1.0.0 免费版</span>
          </div>
        </div>
        <p class="dbx-about-desc">本工具仅供用户本地备份本人账号聊天记录，数据不上传服务器。</p>
        <p class="dbx-about-desc">支持导出 Markdown、HTML、JSON 与 TXT。所有处理都在当前浏览器本地完成。</p>
      </div>
    `;
  }

  function feedbackVisible() {
    return state.feedback.scope === "current" && state.feedback.state !== "idle";
  }

  function footerState() {
    const exportBusy = state.feedback.state === "working";
    const rangeMeta = dateRangeLabel() ? " · 已启用日期范围" : "";
    return {
      meta: `${sample.current.messageCount} 条消息可导出${rangeMeta}`,
      secondaryAction: "refresh-current",
      secondaryLabel: exportBusy ? "处理中…" : "刷新当前对话",
      secondaryDisabled: exportBusy,
      primaryAction: "export-current",
      primaryLabel:
        state.feedback.scope === "current" && state.feedback.state === "success"
          ? "导出完成"
          : state.feedback.scope === "current" && state.feedback.state === "error"
            ? "重试导出"
            : exportBusy && state.feedback.scope === "current"
              ? "正在导出…"
              : "导出当前对话",
      primaryDisabled: exportBusy,
      primaryState: state.feedback.scope === "current" ? state.feedback.state : "idle"
    };
  }

  function syncPanels() {
    currentPanel.innerHTML = currentPanelHtml();
    currentPanel.hidden = false;
    currentPanel.classList.add("is-visible");

    const aboutContent = aboutDrawer.querySelector(".dbx-about");
    if (aboutContent) aboutContent.outerHTML = aboutPanelHtml();
    aboutDrawer.classList.toggle("is-open", state.aboutOpen);
    aboutDrawer.setAttribute("aria-hidden", state.aboutOpen ? "false" : "true");
    aboutScrim.classList.toggle("is-open", state.aboutOpen);
    aboutAction.classList.toggle("is-active", state.aboutOpen);
    aboutAction.setAttribute("aria-expanded", state.aboutOpen ? "true" : "false");
  }

  function syncFooter() {
    const currentFooter = footerState();
    footerMeta.textContent = currentFooter.meta;

    const feedbackEl = document.querySelector("#mock-footer-feedback");
    if (feedbackEl) {
      const visible = feedbackVisible();
      feedbackEl.hidden = !visible;
      feedbackEl.className = `dbx-footer-feedback${visible ? ` is-${state.feedback.state}` : ""}`;
      feedbackEl.querySelector(".dbx-progress-fill").style.width = `${state.feedback.progress}%`;
      feedbackEl.querySelector(".dbx-feedback-text").textContent = state.feedback.message;
      feedbackEl.querySelector(".dbx-progress-label").textContent = `${Math.round(state.feedback.progress)}%`;
      feedbackEl.querySelector(".dbx-progress-track").setAttribute("aria-valuenow", String(state.feedback.progress));
    }

    secondary.disabled = currentFooter.secondaryDisabled;
    secondary.textContent = currentFooter.secondaryLabel;
    secondary.dataset.action = currentFooter.secondaryAction;

    primary.disabled = currentFooter.primaryDisabled;
    primary.textContent = currentFooter.primaryLabel;
    primary.dataset.action = currentFooter.primaryAction;
    primary.setAttribute("aria-busy", currentFooter.primaryState === "working" ? "true" : "false");
    if (currentFooter.primaryState && currentFooter.primaryState !== "idle") {
      primary.setAttribute("data-state", currentFooter.primaryState);
    } else {
      primary.removeAttribute("data-state");
    }
  }

  function syncView() {
    syncPanels();
    syncFooter();
    syncDialogPosition();
  }

  function setFeedback(nextState, message, progress, scope) {
    window.clearTimeout(feedbackTimerId);
    state.feedback = {
      scope,
      state: nextState,
      message,
      progress
    };
    if (nextState !== "working") {
      stopFeedbackDrift();
    }
    syncFooter();
  }

  function stopFeedbackDrift() {
    window.clearInterval(stopFeedbackDrift.timerId);
    stopFeedbackDrift.timerId = 0;
  }

  function startFeedbackDrift({ scope, message, progress, ceiling, interval = 280 }) {
    stopFeedbackDrift();
    setFeedback("working", message, progress, scope);
    stopFeedbackDrift.timerId = window.setInterval(() => {
      const current = state.feedback;
      if (!current || current.state !== "working" || current.scope !== scope) {
        stopFeedbackDrift();
        return;
      }
      if (current.progress >= ceiling) return;
      const remaining = ceiling - current.progress;
      const nextProgress = Math.min(ceiling, current.progress + Math.max(1, Math.ceil(remaining * 0.18)));
      if (nextProgress === current.progress) return;
      state.feedback = {
        ...current,
        progress: nextProgress
      };
      syncFooter();
    }, interval);
  }

  function scheduleFeedbackReset(delay) {
    window.clearTimeout(feedbackTimerId);
    feedbackTimerId = window.setTimeout(() => {
      state.feedback = {
        scope: "",
        state: "idle",
        message: "",
        progress: 0
      };
      syncFooter();
    }, delay);
  }

  async function runCurrentExport() {
    startFeedbackDrift({
      scope: "current",
      message: "正在准备当前对话…",
      progress: 14,
      ceiling: 42
    });
    await wait(280);
    startFeedbackDrift({
      scope: "current",
      message:
        state.format === "json"
          ? "正在生成 JSON 文件…"
          : state.imageMode === "embed"
            ? "正在内嵌图片…"
            : "正在生成 Markdown 文件…",
      progress: 76,
      ceiling: state.imageMode === "embed" ? 88 : 92,
      interval: 240
    });
    await wait(420);
    stopFeedbackDrift();
    setFeedback("success", `已导出 ${sample.current.messageCount} 条消息`, 100, "current");
    scheduleFeedbackReset(1800);
  }

  aboutAction?.addEventListener("click", () => {
    state.aboutOpen = !state.aboutOpen;
    syncView();
  });

  aboutScrim?.addEventListener("click", () => {
    state.aboutOpen = false;
    syncView();
  });

  aboutDrawer?.addEventListener("click", (event) => {
    if (event.target.closest("[data-action='close-about']")) {
      state.aboutOpen = false;
      syncView();
    }
  });

  document.querySelector(".dbx-content")?.addEventListener("click", (event) => {
    const formatButton = event.target.closest("[data-format]");
    if (formatButton) {
      state.format = formatButton.getAttribute("data-format") || "md";
      if (state.format === "txt") {
        state.imageMode = "strip";
      }
      syncView();
      return;
    }

    const imageModeToggle = event.target.closest("[data-image-mode-toggle]");
    if (imageModeToggle) {
      state.imageMode = state.imageMode === "embed" ? "strip" : "embed";
      syncView();
      return;
    }

    const timestampModeToggle = event.target.closest("[data-timestamp-mode-toggle]");
    if (timestampModeToggle) {
      state.timestampMode = state.timestampMode === "show" ? "hide" : "show";
      syncView();
      return;
    }

    const splitModeToggle = event.target.closest("[data-split-mode-toggle]");
    if (splitModeToggle) {
      state.splitMode = state.splitMode === "on" ? "off" : "on";
      syncView();
      return;
    }

    const dateRangeToggle = event.target.closest("[data-date-range-toggle]");
    if (dateRangeToggle) {
      state.dateRange.enabled = !state.dateRange.enabled;
      syncView();
      return;
    }

    const diagnosticsToggle = event.target.closest("[data-diagnostics-toggle]");
    if (diagnosticsToggle) {
      const scope = diagnosticsToggle.getAttribute("data-diagnostics-toggle");
      if (scope && state.diagnostics[scope] != null) {
        state.diagnostics[scope] = !state.diagnostics[scope];
        syncView();
      }
      return;
    }

  });

  document.querySelector(".dbx-content")?.addEventListener("change", (event) => {
    const startInput = event.target.closest("[data-date-range-start]");
    const endInput = event.target.closest("[data-date-range-end]");
    if (!startInput && !endInput) return;
    state.dateRange.enabled = true;
    if (startInput) state.dateRange.startDate = sanitizeDateInput(startInput.value);
    if (endInput) state.dateRange.endDate = sanitizeDateInput(endInput.value);
    syncView();
  });

  secondary.addEventListener("click", async () => {
    const action = secondary.dataset.action;
    if (action === "refresh-current") {
      await wait(300);
      return;
    }
  });

  primary.addEventListener("click", async () => {
    const action = primary.dataset.action;
    if (action === "export-current") {
      await runCurrentExport();
      return;
    }
  });

  document.querySelector('[data-window-action="close"]')?.addEventListener("click", () => {
    dialog.style.display = "none";
  });

  const dragButton = document.querySelector('[data-window-action="drag"]');
  dragButton?.addEventListener("pointerdown", beginDialogDrag);
  dragButton?.addEventListener("pointermove", updateDialogDrag);
  dragButton?.addEventListener("pointerup", endDialogDrag);
  dragButton?.addEventListener("pointercancel", endDialogDrag);

  document.querySelector('[data-window-action="reset"]')?.addEventListener("click", () => {
    resetDialogPosition();
  });

  window.addEventListener("resize", () => {
    if (state.windowPosition.left == null || state.windowPosition.top == null) return;
    const rect = dialog.getBoundingClientRect();
    state.windowPosition = clampDialogPosition(
      state.windowPosition.left,
      state.windowPosition.top,
      rect.width,
      rect.height
    );
    syncDialogPosition();
  });

  syncView();
})();
