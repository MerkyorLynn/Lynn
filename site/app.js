const RELEASE = {
  guiVersion: "0.87.4",
  cliVersion: "0.87.4",
  releasePage: "https://github.com/MerkyorLynn/Lynn/releases/tag/v0.87.4",
  assets: {
    macArm:
      "https://download.merkyorlynn.com/downloads/Lynn-0.87.4-macOS-arm64.dmg?rev=20261029",
    macIntel:
      "https://download.merkyorlynn.com/downloads/Lynn-0.87.4-macOS-x64.dmg?rev=20261029",
    windows:
      "https://download.merkyorlynn.com/downloads/Lynn-0.87.4-Windows-Setup.exe?rev=20261029",
  },
};

function detectPlatform() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";

  if (/Win/i.test(platform) || /Windows/i.test(ua)) {
    return "windows";
  }

  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
    return "mac";
  }

  return "other";
}

function applyReleaseData() {
  const guiVersionNode = document.getElementById("gui-release-version");
  if (guiVersionNode) guiVersionNode.textContent = RELEASE.guiVersion;
  const cliVersionNode = document.getElementById("cli-release-version");
  if (cliVersionNode) cliVersionNode.textContent = RELEASE.cliVersion;

  document.querySelectorAll("[data-download-key]").forEach((link) => {
    const key = link.getAttribute("data-download-key");
    if (!key) return;
    if (!RELEASE.assets[key]) {
      link.removeAttribute("href");
      link.removeAttribute("target");
      link.setAttribute("aria-disabled", "true");
      link.classList.add("button-disabled");
      return;
    }
    link.setAttribute("href", RELEASE.assets[key]);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noreferrer");
  });
}

function applyPlatformHint() {
  const platform = detectPlatform();
  const callout = document.getElementById("platform-callout");

  if (platform === "windows") {
    document
      .querySelector('[data-platform-card="windows"]')
      ?.classList.add("is-recommended");
    if (callout) {
      callout.innerHTML =
        "<strong>已识别为 Windows：</strong> 推荐直接下载 Windows 安装版。";
    }
    return;
  }

  if (platform === "mac") {
    document
      .querySelector('[data-platform-card="mac-arm"]')
      ?.classList.add("is-recommended");
    if (callout) {
      callout.innerHTML =
        "<strong>已识别为 macOS：</strong> 请根据你的芯片型号选择已公证的 Apple Silicon 或 Intel 版本。";
    }
    return;
  }

  if (callout) {
    callout.innerHTML =
      "<strong>未自动识别系统：</strong> 你也可以直接前往 Gitee Release 页面选择安装包。";
  }
}

function applyCopyButtons() {
  document.querySelectorAll("[data-copy-target]").forEach((button) => {
    const targetId = button.getAttribute("data-copy-target");
    const target = targetId ? document.getElementById(targetId) : null;
    if (!target) return;
    button.addEventListener("click", async () => {
      const text = target.textContent || "";
      try {
        await navigator.clipboard.writeText(text);
        const previous = button.textContent;
        button.textContent = "已复制";
        window.setTimeout(() => {
          button.textContent = previous || "复制";
        }, 1400);
      } catch {
        button.textContent = "手动复制";
      }
    });
  });
}

applyReleaseData();
applyPlatformHint();
applyCopyButtons();
