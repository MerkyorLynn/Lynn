const RELEASE = {
  version: "0.77.11",
  releasePage: "https://github.com/MerkyorLynn/Lynn/releases/tag/v0.77.11",
  assets: {
    macArm:
      "https://download.merkyorlynn.com/downloads/Lynn-0.77.11-macOS-Apple-Silicon.dmg",
    macIntel:
      "https://download.merkyorlynn.com/downloads/Lynn-0.77.11-macOS-Intel.dmg",
    windows:
      "https://download.merkyorlynn.com/downloads/Lynn-0.77.11-Windows-Setup.exe",
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
  const versionNode = document.getElementById("release-version");
  if (versionNode) {
    versionNode.textContent = RELEASE.version;
  }

  document.querySelectorAll("[data-download-key]").forEach((link) => {
    const key = link.getAttribute("data-download-key");
    if (!key || !RELEASE.assets[key]) return;
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
        "<strong>已识别为 macOS：</strong> 请根据你的芯片型号选择 Apple Silicon 或 Intel 版本。";
    }
    return;
  }

  if (callout) {
    callout.innerHTML =
      "<strong>未自动识别系统：</strong> 你也可以直接前往 GitHub Release 页面选择安装包。";
  }
}

applyReleaseData();
applyPlatformHint();
