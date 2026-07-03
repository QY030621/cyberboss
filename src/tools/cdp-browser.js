"use strict";

/**
 * CDP Browser — Chrome DevTools Protocol client for cyberboss.
 *
 * Connects to a Chrome instance with --remote-debugging-port and
 * provides a simple async API to navigate, screenshot, read text,
 * click, type, and execute JavaScript.
 *
 * Usage:
 *   const { CDPBrowser } = require("./cdp-browser");
 *   const cdp = new CDPBrowser({ port: 9222 });
 *   await cdp.start();
 *   await cdp.navigate("https://example.com");
 *   const text = await cdp.getText();
 *   const png  = await cdp.screenshot(); // base64
 *   await cdp.stop();
 */

const { spawn, execSync } = require("child_process");
const net = require("net");
const http = require("http");
const WebSocket = require("ws");

// ── helpers ──────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      })
      .on("error", reject);
  });
}

// ═══════════════════════════════════════════════════════
//  CDP Browser
// ═══════════════════════════════════════════════════════

class CDPBrowser {
  /**
   * @param {{ port?: number, chromePath?: string, profileDir?: string, headless?: boolean }} opts
   */
  constructor(opts = {}) {
    this.port = opts.port || 9222;
    this.host = `127.0.0.1:${this.port}`;
    this.chromePath =
      opts.chromePath ||
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    this.profileDir = opts.profileDir || null; // null = temp dir
    this.headless = opts.headless !== false; // default true
    this._ws = null;
    this._msgId = 0;
    this._pending = new Map(); // msgId → { resolve, reject }
    this._chromeProc = null;
  }

  // ── lifecycle ───────────────────────────────────────

  /** Launch Chrome and connect. */
  async start() {
    await this._launchChrome();
    await this._connect();
    await this._enableBase();
  }

  /** Close everything. */
  async stop() {
    try { this._ws && this._ws.close(); } catch (_) { /* ignore */ }
    try { this._chromeProc && this._chromeProc.kill(); } catch (_) { /* ignore */ }
    this._ws = null;
    this._chromeProc = null;
  }

  // ── CDP primitives ──────────────────────────────────

  /** Send a CDP command and wait for the result. */
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this._msgId;
      this._pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ id, method, params });
      // small timeout per call
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      const orig = this._pending.get(id);
      if (orig) {
        orig._timer = timer;
      }
      this._ws.send(payload);
    });
  }

  /** Evaluate JS in the page. Returns the JSON-serializable result. */
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const err = res.exceptionDetails.text || res.exceptionDetails.exception?.description || "eval error";
      throw new Error(err);
    }
    return res.result?.value;
  }

  // ── high-level API ──────────────────────────────────

  /** Navigate to a URL. Resolves when the page has loaded. */
  async navigate(url) {
    const { frameId, loaderId } = await this.send("Page.navigate", { url });
    // Wait for load event
    await this._waitForLoad(loaderId);
    await sleep(500); // extra settle time
    return frameId;
  }

  /** Take a full-page screenshot. Returns base64 PNG string. */
  async screenshot() {
    const res = await this.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    return res.data; // base64
  }

  /** Get visible text content of the page. */
  async getText() {
    return await this.evaluate(
      "document.body ? document.body.innerText : ''"
    );
  }

  /** Get the current page title. */
  async getTitle() {
    return await this.evaluate("document.title");
  }

  /** Get the current page URL. */
  async getURL() {
    return await this.evaluate("location.href");
  }

  /** Click an element matching the CSS selector. */
  async click(selector) {
    const res = await this.send("Runtime.evaluate", {
      expression: `
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { found: false };
          el.scrollIntoView({ behavior: "instant", block: "center" });
          const rect = el.getBoundingClientRect();
          return { found: true, x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
        })()
      `,
      returnByValue: true,
    });
    const info = res.result?.value;
    if (!info || !info.found) throw new Error(`Element not found: ${selector}`);

    // Use Input.dispatchMouseEvent
    const x = Math.round(info.x);
    const y = Math.round(info.y);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sleep(50);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(300);
  }

  /** Type text into the currently focused element. */
  async type(text) {
    for (const ch of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", text: ch });
    }
  }

  /** Scroll down by `px` pixels. */
  async scrollBy(px = 500) {
    await this.evaluate(`window.scrollBy(0, ${px})`);
    await sleep(300);
  }

  /** Press Enter. */
  async pressEnter() {
    await this.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", windowsVirtualKeyCode: 13, unmodifiedText: "\r", text: "\r",
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "char", windowsVirtualKeyCode: 13, unmodifiedText: "\r", text: "\r",
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp", windowsVirtualKeyCode: 13, unmodifiedText: "\r", text: "\r",
    });
  }

  // ── internals ───────────────────────────────────────

  async _launchChrome() {
    const args = [
      `--remote-debugging-port=${this.port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--disable-features=TranslateUI",
    ];

    if (this.headless) {
      args.push("--headless=new");
    }

    if (this.profileDir) {
      args.push(`--user-data-dir=${this.profileDir}`);
    } else {
      // Use a temp profile dir
      const os = require("os");
      const path = require("path");
      const tmp = path.join(os.tmpdir(), `cdp-chrome-${Date.now()}`);
      args.push(`--user-data-dir=${tmp}`);
    }

    args.push("about:blank");

    console.log(`[cdp] launching: "${this.chromePath}" ${args.join(" ")}`);

    this._chromeProc = spawn(this.chromePath, args, {
      detached: false,
      stdio: ["ignore", "ignore", "ignore"],
    });

    // Wait for the debugging endpoint to be ready
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        await httpGetJSON(`http://${this.host}/json/version`);
        console.log("[cdp] Chrome is ready");
        return;
      } catch (_) {
        // not ready yet
      }
    }
    throw new Error("Chrome did not start in time");
  }

  async _connect() {
    // Get the list of available pages
    const pages = await httpGetJSON(`http://${this.host}/json`);
    // Pick the first page (about:blank) or create one
    let target = pages.find((p) => p.type === "page");
    if (!target) {
      // Create a new target via PUT
      const newPage = await httpGetJSON(`http://${this.host}/json/new?about:blank`);
      target = newPage;
    }

    console.log(`[cdp] connecting to: ${target.url}`);

    this._ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this._ws.once("open", resolve);
      this._ws.once("error", reject);
    });

    this._ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.id && this._pending.has(msg.id)) {
        const entry = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        clearTimeout(entry._timer);
        if (msg.error) {
          entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          entry.resolve(msg.result || {});
        }
      }
    });

    this._ws.on("close", () => {
      // Reject all pending
      for (const [id, entry] of this._pending) {
        entry.reject(new Error("CDP connection closed"));
        this._pending.delete(id);
      }
    });

    console.log("[cdp] WebSocket connected");
  }

  async _enableBase() {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    // DOM.enable not always needed; skip Input.enable (doesn't exist in CDP)
    console.log("[cdp] base domains enabled");
  }

  async _waitForLoad(loaderId) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(), 15000);
      const handler = (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
        if (msg.method === "Page.loadEventFired" && msg.params?.loaderId === loaderId) {
          clearTimeout(timeout);
          this._ws.removeListener("message", handler);
          resolve();
        }
      };
      this._ws.on("message", handler);
    });
  }
}

module.exports = { CDPBrowser };
