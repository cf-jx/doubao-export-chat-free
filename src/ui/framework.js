(function () {
  "use strict";

  function resolveElement(target) {
    if (!target) return null;
    if (typeof target === "string") {
      return document.querySelector(target);
    }
    return target;
  }

  function renderShellSvg(className = "") {
    return `
      <svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
        <path d="M12 3a7 7 0 0 0-7 7v7a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-7a7 7 0 0 0-7-7z" />
        <circle cx="9" cy="12" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="15" cy="12" r="1.5" fill="currentColor" stroke="none" />
      </svg>
    `;
  }

  function syncSegmentedState(root, itemSelector, activeMatcher) {
    const resolvedRoot = resolveElement(root);
    if (!resolvedRoot) return;

    resolvedRoot.querySelectorAll(itemSelector).forEach((item) => {
      item.classList.toggle("is-active", Boolean(activeMatcher(item)));
    });
  }

  function pulseSelectableControl(control) {
    const element = resolveElement(control);
    if (!element) return;

    element.style.animation = "none";
    void element.offsetHeight;
    element.style.animation = "";
  }

  function switchPanel(panel, isActive) {
    const element = resolveElement(panel);
    if (!element) return;

    element.hidden = !isActive;
    element.classList.toggle("is-visible", Boolean(isActive));
  }

  function bindWorkbenchTabs(root, options = {}) {
    const resolvedRoot = resolveElement(root);
    if (!resolvedRoot) return null;

    const navSelector = options.navSelector || "[data-tab]";
    const tabs = Array.from(resolvedRoot.querySelectorAll(navSelector))
      .filter((tab) => tab.dataset && tab.dataset.tab);
    const panelMap = options.panelMap || {};
    let currentTab = options.initialTab || tabs[0]?.dataset?.tab || "";

    function applyState(nextTab, trigger = null) {
      if (!nextTab) return currentTab;

      tabs.forEach((tab) => {
        const isActive = tab.dataset.tab === nextTab;
        tab.classList.toggle("is-active", isActive);
        tab.setAttribute("aria-pressed", String(isActive));
      });

      Object.entries(panelMap).forEach(([tabName, panel]) => {
        switchPanel(panel, tabName === nextTab);
      });

      const previousTab = currentTab;
      currentTab = nextTab;

      if (typeof options.onChange === "function") {
        options.onChange({
          currentTab,
          previousTab,
          trigger,
          root: resolvedRoot
        });
      }

      return currentTab;
    }

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const nextTab = tab.dataset.tab;
        if (!nextTab || nextTab === currentTab) return;
        applyState(nextTab, tab);
      });
    });

    applyState(currentTab, null);

    return {
      activateTab(nextTab) {
        return applyState(nextTab, null);
      },
      getCurrentTab() {
        return currentTab;
      }
    };
  }

  window.DoubaoUIFramework = {
    resolveElement,
    renderShellSvg,
    syncSegmentedState,
    pulseSelectableControl,
    switchPanel,
    bindWorkbenchTabs
  };
})();
