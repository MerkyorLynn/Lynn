// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SNAPSHOT_SCRIPT } = require("../browser-snapshot.cjs");

// Characterization test: runs the real in-page snapshot script against a jsdom
// DOM and locks its current output. jsdom has no layout, so isVisible()'s
// offsetParent check would mark everything invisible — shim it to the parent.
beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, "offsetParent", {
    get(this: HTMLElement) {
      return this.parentNode as Element | null;
    },
    configurable: true,
  });
});

function snapshot(): { currentUrl: string; text: string } {
  // SNAPSHOT_SCRIPT is an IIFE reading document/window/location (jsdom globals).
  // eslint-disable-next-line no-eval
  return eval(SNAPSHOT_SCRIPT);
}

describe("SNAPSHOT_SCRIPT (DOM → AXTree snapshot)", () => {
  it("captures interactive elements with refs, headings, links, and text", () => {
    document.body.innerHTML = `
      <h1>Title Here</h1>
      <a href="https://example.com/go">Go Link</a>
      <button>Click Me</button>
      <input type="text" value="hello" aria-label="Name field" />
      <p>Some paragraph text content here</p>
    `;
    const snap = snapshot();
    expect(snap.text).toContain("Title Here");
    expect(snap.text).toContain("Go Link");
    expect(snap.text).toContain("Click Me");
    expect(snap.text).toContain("Name field");
    expect(snap.text).toContain("Some paragraph text content here");
    expect(snap.text).toMatch(/\[\d+\]/); // refs assigned to interactive elements
  });

  it("annotates interactive elements with data-hana-ref for later click/type", () => {
    document.body.innerHTML = `<button>Press</button>`;
    snapshot();
    expect(document.querySelector("button")?.getAttribute("data-hana-ref")).toBeTruthy();
  });

  it("returns currentUrl and a Page/URL header", () => {
    document.body.innerHTML = "<p>hello world</p>";
    const snap = snapshot();
    expect(snap.currentUrl).toBeTruthy();
    expect(snap.text).toContain("Page:");
    expect(snap.text).toContain("URL:");
  });

  it("re-runs cleanly (clears prior refs)", () => {
    document.body.innerHTML = `<button>A</button>`;
    snapshot();
    document.body.innerHTML = `<button>B</button><button>C</button>`;
    const snap = snapshot();
    // refs restart from 1 each run
    expect(snap.text).toContain("[1]");
    expect(snap.text).toContain("[2]");
  });
});
