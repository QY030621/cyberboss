"use strict";

/**
 * XHS Tool Host — CDP-powered Xiaohongshu tools for cyberboss.
 *
 * Connects to an existing Chrome/Edge instance with --remote-debugging-port=9222.
 * Provides: search, read note, comment, publish, screenshot.
 */

const CDP = require("chrome-remote-interface");
const http = require("http");

const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatShortDate() {
  return new Date().toISOString().slice(0, 10);
}

function httpGetJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    }).on("error", reject);
  });
}

class XhsToolHost {
  constructor() {
    this._ready = false;
    this._lastNoteTargetId = "";
  }

  /** Ensure CDP is reachable */
  async _ensureCDP() {
    if (this._ready) return;
    try {
      await httpGetJSON(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
      this._ready = true;
    } catch (e) {
      throw new Error(
        "CDP browser not running. Start Edge with: --remote-debugging-port=9222"
      );
    }
  }

  /**
   * Get CDP client for a page target.
   *
   * @param {Object} opts
   * @param {boolean} [opts.shouldNavigate]   — navigate after connect
   * @param {string}  [opts.url]              — URL to navigate to
   * @param {boolean} [opts.preferExplore]    — prefer tab with /explore/ in URL
   * @param {string}  [opts.targetId]         — connect to a specific target id
   */
  async _getClient(opts = {}) {
    const { shouldNavigate = false, url = "", preferExplore = false, targetId = "" } =
      typeof opts === "object" && opts !== null ? opts : {};

    await this._ensureCDP();
    const targets = await httpGetJSON(`http://${CDP_HOST}:${CDP_PORT}/json`);

    let page;
    if (targetId) {
      // Reconnect to a known tab
      page = targets.find((t) => t.id === targetId);
      if (!page) {
        // Tab gone — fall back to first page
        page = targets.find((t) => t.type === "page");
      }
    } else if (preferExplore) {
      // Prefer the tab that already has Xiaohongshu explore open
      page = targets.find(
        (t) => t.type === "page" && String(t.url || "").includes("/explore/")
      );
      if (!page) {
        page = targets.find((t) => t.type === "page");
      }
    } else {
      page = targets.find((t) => t.type === "page");
    }

    if (!page) throw new Error("No browser page found");

    const client = await CDP({ target: page.id });

    // Enable all domains we might need
    await Promise.all([
      client.Page.enable(),
      client.Runtime.enable(),
      client.DOM.enable(),
    ]);

    if (shouldNavigate && url) {
      await client.Page.navigate({ url });
      await sleep(5000);
    }

    return {
      client,
      targetId: page.id,
      Page: client.Page,
      Runtime: client.Runtime,
      Input: client.Input,
      DOM: client.DOM,
    };
  }

  // ═══ Tools ══════════════════════════════════════

  /** Search Xiaohongshu */
  async search(keyword) {
    const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&type=51`;
    const { client, Runtime } = await this._getClient({ shouldNavigate: true, url: searchUrl });

    try {
      const res = await Runtime.evaluate({
        expression: `(() => {
          const feed = document.querySelector('[class*=feeds-page], [class*=search-result], [class*=note-list]')
            || document.querySelector('main')
            || document.body;
          const links = [...feed.querySelectorAll('a[href*="/explore/"]')];
          const seen = new Set();
          const items = [];
          for (const a of links) {
            const href = a.href.replace(/#.*$/, '');
            if (seen.has(href)) continue;
            seen.add(href);
            const r = a.getBoundingClientRect();
            if (r.width < 60 || r.height < 40) continue;
            const parent = a.closest('section') || a;
            const text = (parent.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 150);
            if (text.length > 10) items.push({ title: text.slice(0, 120), link: a.href });
          }
          return items.slice(0, 12);
        })()`,
        returnByValue: true,
      });
      return res.result?.value || [];
    } finally {
      await client.close();
    }
  }

  /** Read a specific note by clicking into it from search results */
  async readNote(keyword = "", noteIndex = 0) {
    const searchUrl = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&type=51`;

    // Step 1: Open search page
    let { client, Runtime, targetId } = await this._getClient({ shouldNavigate: true, url: searchUrl });
    // Track the search tab's id so we can detect new tabs
    const searchTabId = targetId;

    let noteTitle = "";
    let noteDesc = "";
    let noteAuthor = "";
    let noteComments = [];

    try {
      await sleep(3000);

      // Step 2: Find search result cards (only in feed area, not sidebar/related)
      const cards = await Runtime.evaluate({
        expression: `(() => {
          const feed = document.querySelector('[class*=feeds-page], [class*=search-result], [class*=note-list]')
            || document.querySelector('main')
            || document.body;
          const links = [...feed.querySelectorAll('a[href*="/explore/"]')];
          const seen = new Set();
          const items = [];
          for (const a of links) {
            const href = a.href.replace(/#.*$/, '');
            if (seen.has(href)) continue;
            seen.add(href);
            const r = a.getBoundingClientRect();
            if (r.width < 60 || r.height < 40) continue;
            items.push({ href: a.href, text: (a.textContent || '').trim().slice(0, 80), idx: items.length });
          }
          return items.slice(0, 15);
        })()`,
        returnByValue: true,
      });

      const items = cards.result?.value || [];
      if (!items.length) {
        await client.close();
        return { error: "No search results found" };
      }
      if (noteIndex >= items.length) noteIndex = 0;

      const target = items[noteIndex];

      // Step 3: Navigate to the note URL directly instead of clicking
      // This avoids tab-switching problems entirely
      await client.close();

      const { client: noteClient, Runtime: noteRt, Page: notePage, Input: noteInput, targetId: noteTabId } =
        await this._getClient({ shouldNavigate: true, url: target.href });

      this._lastNoteTargetId = noteTabId;
      client = noteClient;
      Runtime = noteRt;
      const Page = notePage;
      const Input = noteInput;
      targetId = noteTabId;

      await sleep(4000);

      // Step 4: Scroll to load content
      for (let y = 300; y < 3000; y += 600) {
        await Runtime.evaluate({ expression: `window.scrollTo(0, ${y})`, returnByValue: true });
        await sleep(400);
      }

      // Step 5: Extract note content
      const detail = await Runtime.evaluate({
        expression: `(() => {
          const title = document.querySelector('#detail-title')?.textContent?.trim()
            || document.querySelector('meta[property="og:title"]')?.content
            || document.title
            || '';
          const desc = document.querySelector('#detail-desc')?.textContent?.trim()
            || document.querySelector('[class*=desc]')?.textContent?.trim()
            || document.querySelector('meta[name="description"]')?.content
            || '';
          const authorEl = document.querySelector('[class*=username], [class*=author], [class*=name]');
          const author = authorEl ? authorEl.textContent.trim().slice(0, 50) : '';

          const comments = [...document.querySelectorAll('[class*=comment-item], [class*=comment-container]')]
            .slice(0, 8)
            .map(el => {
              const au = el.querySelector('[class*=username], [class*=author], [class*=name]');
              const co = el.querySelector('[class*=content], [class*=text], [class*=body]');
              return {
                author: au ? au.textContent.trim().slice(0, 40) : '',
                content: co ? co.textContent.trim().slice(0, 300) : ''
              };
            });

          return { title: title.slice(0, 200), desc: desc.slice(0, 3000), author, comments };
        })()`,
        returnByValue: true,
      });

      const result = detail.result?.value || {};

      // Step 6: Read carousel images (image-text notes have swipeable photo slideshows)
      const carouselImages = await this._readCarouselImages({ Runtime, Input, Page, keyword, noteIndex });
      if (carouselImages.length) {
        result.carouselImages = carouselImages;
      }

      return result;
    } finally {
      try { await client.close(); } catch {}
    }
  }

  /**
   * Read carousel images from an image-text note.
   * Detects slide count from dot indicators, enters fullscreen, screenshots each slide, saves to inbox.
   */
  async _readCarouselImages({ Runtime, Input, Page, keyword = "", noteIndex = 0 }) {
    const images = [];
    try {
      // Scroll back up to see the image area
      await Runtime.evaluate({ expression: "window.scrollTo(0, 0)", returnByValue: true });
      await sleep(800);

      // Detect carousel dots / slide count
      const carouselInfo = await Runtime.evaluate({
        expression: `(() => {
          // XHS carousel has dot indicators — each dot is a small circle div
          const dots = [...document.querySelectorAll('[class*=swiper-pagination] span, [class*=dot], [class*=indicator]')];
          // Also check for image counter like "1/5"
          const counterEl = document.querySelector('[class*=counter], [class*=index]');
          let count = dots.length;
          if (!count) {
            // Try to count by looking at the carousel track width vs slide width
            const track = document.querySelector('[class*=swiper-wrapper], [class*=carousel-track], [class*=slider-track]');
            if (track) {
              const slides = track.children;
              if (slides.length > 0) count = slides.length;
            }
          }
          if (!count) {
            // Look for img tags in the main image area
            const imgs = document.querySelectorAll('img[src*="xhscdn"], img[src*="sns-img"]');
            if (imgs.length > 0) count = Math.min(imgs.length, 12);
          }

          // Find the main image element to click
          const mainImg = document.querySelector('[class*=swiper-slide-active] img, [class*=active] img, .swiper-slide-active img')
            || document.querySelector('[class*=carousel] img, [class*=swiper] img, [class*=slider] img')
            || document.querySelector('img[src*="xhscdn"], img[src*="sns-img"]');

          const imgRect = mainImg ? (() => { const r = mainImg.getBoundingClientRect(); return { x: r.left+r.width/2, y: r.top+r.height/2, w: r.width, h: r.height }; })() : null;

          return { count, clickable: imgRect && imgRect.w > 100, x: imgRect?.x || 0, y: imgRect?.y || 0 };
        })()`,
        returnByValue: true,
      });

      const slideCount = carouselInfo.result?.value?.count || 0;
      if (slideCount < 1) return images;

      const total = Math.min(slideCount, 12); // safety cap

      // Click main image to enter fullscreen mode
      const clickPt = carouselInfo.result?.value;
      if (clickPt?.clickable) {
        await Input.dispatchMouseEvent({ type: "mousePressed", x: clickPt.x, y: clickPt.y, button: "left", clickCount: 1 });
        await sleep(120);
        await Input.dispatchMouseEvent({ type: "mouseReleased", x: clickPt.x, y: clickPt.y, button: "left", clickCount: 1 });
        await sleep(2000);
      } else {
        return images; // no image to click
      }

      // Screenshot each slide
      const inboxDir = this._getInboxDir();
      const fs = require("fs");
      const path = require("path");
      fs.mkdirSync(inboxDir, { recursive: true });

      for (let i = 0; i < total; i++) {
        // Screenshot current fullscreen view
        try {
          const { data } = await Page.captureScreenshot({ format: "png" });
          const filename = `xhs-carousel-${formatShortDate()}-${i + 1}.png`;
          const filePath = path.join(inboxDir, filename);
          fs.writeFileSync(filePath, Buffer.from(data, "base64"));
          images.push({ index: i, path: filePath });
        } catch (e) {
          console.error(`[xhs-tool-host] carousel screenshot ${i + 1} failed: ${e.message}`);
        }

        // Navigate to next slide (swipe right-to-left or click right arrow)
        if (i < total - 1) {
          const navResult = await Runtime.evaluate({
            expression: `(() => {
              // Try arrow buttons first
              const arrows = [...document.querySelectorAll('[class*=arrow], [class*=nav]')];
              const rightArrow = arrows.find(a => {
                const t = (a.textContent || '').trim();
                return t === '›' || t === '▶' || t === '→' || /right|next/i.test(a.className);
              });
              if (rightArrow) {
                const r = rightArrow.getBoundingClientRect();
                return { method: 'arrow', x: r.left+r.width/2, y: r.top+r.height/2 };
              }
              // Fallback: swipe gesture — click right side of the image
              return { method: 'swipe', x: window.innerWidth * 0.85, y: window.innerHeight * 0.5 };
            })()`,
            returnByValue: true,
          });

          const nav = navResult.result?.value;
          if (nav) {
            await Input.dispatchMouseEvent({ type: "mousePressed", x: nav.x, y: nav.y, button: "left", clickCount: 1 });
            await sleep(100);
            await Input.dispatchMouseEvent({ type: "mouseReleased", x: nav.x, y: nav.y, button: "left", clickCount: 1 });
          }
          await sleep(1200);
        }
      }

      // Close fullscreen — press Escape or click outside
      await Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 });
      await sleep(500);

    } catch (e) {
      console.error(`[xhs-tool-host] carousel read failed: ${e.message}`);
    }
    return images;
  }

  _getInboxDir() {
    const os = require("os");
    const p = require("path");
    return p.join(os.homedir(), ".cyberboss", "inbox", formatShortDate());
  }

  /** Post a comment on the note that was last opened by readNote */
  async comment(text) {
    if (!this._lastNoteTargetId) {
      return { error: "No note has been opened yet. Use search+read first." };
    }

    // Reconnect to the same tab, preferring /explore/ as fallback
    const { client, Runtime, Input } = await this._getClient({ preferExplore: true });

    try {
      // Check we're still on a note page
      const url = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      if (!url.result?.value?.includes("/explore/")) {
        return { error: "Not on a note page. The note tab may have navigated away." };
      }

      // Scroll to fully load comments
      for (let y = 500; y < 5000; y += 1000) {
        await Runtime.evaluate({ expression: `window.scrollTo(0, ${y})`, returnByValue: true });
        await sleep(500);
      }
      await sleep(1000);

      // Find comment input
      const inputInfo = await Runtime.evaluate({
        expression: `(() => {
          const el = document.querySelector('.content-input, [class*=content-input], textarea[placeholder*="评论"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left+r.width/2, y: r.top+r.height/2, w: r.width, h: r.height };
        })()`,
        returnByValue: true,
      });

      if (!inputInfo.result?.value) return { error: "Comment input not found" };

      const inp = inputInfo.result.value;

      // Click input
      await Input.dispatchMouseEvent({ type: "mousePressed", x: inp.x, y: inp.y, button: "left", clickCount: 1 });
      await Input.dispatchMouseEvent({ type: "mouseReleased", x: inp.x, y: inp.y, button: "left", clickCount: 1 });
      await sleep(300);

      // Clear and type
      await Runtime.evaluate({
        expression: `(() => { const el = document.querySelector('.content-input, [class*=content-input], textarea[placeholder*="评论"]'); if(el) { el.textContent=""; el.value=""; el.focus(); } })()`,
        returnByValue: true,
      });
      await sleep(200);

      for (const ch of text) {
        await Input.insertText({ text: ch });
        await sleep(20);
      }
      await sleep(800);

      // Find send button
      const sendInfo = await Runtime.evaluate({
        expression: `(() => {
          const btns = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '发送');
          if (!btns.length) return null;
          const r = btns[0].getBoundingClientRect();
          return { x: r.left+r.width/2, y: r.top+r.height/2 };
        })()`,
        returnByValue: true,
      });

      if (!sendInfo.result?.value) return { error: "Send button not found", typed: text };

      const snd = sendInfo.result.value;

      // Click send
      await Input.dispatchMouseEvent({ type: "mousePressed", x: snd.x, y: snd.y, button: "left", clickCount: 1 });
      await sleep(80);
      await Input.dispatchMouseEvent({ type: "mouseReleased", x: snd.x, y: snd.y, button: "left", clickCount: 1 });
      await sleep(3000);

      // Verify
      const confirm = await Runtime.evaluate({
        expression: `(() => {
          const input = document.querySelector('.content-input, [class*=content-input], textarea[placeholder*="评论"]');
          const cleared = input ? ((input.textContent||'').trim().length < 5 && (input.value||'').trim().length < 5) : false;
          return { posted: cleared, text };
        })()`,
        returnByValue: true,
      });

      return confirm.result?.value || { posted: false, text };
    } finally {
      await client.close();
    }
  }

  /** Publish a new Xiaohongshu note */
  async publish({ title = "", content = "", images = [] } = {}) {
    const normalizedTitle = String(title || "").trim();
    const normalizedContent = String(content || "").trim();
    if (!normalizedTitle) return { error: "title is required" };
    if (!normalizedContent) return { error: "content is required" };
    if (!Array.isArray(images) || !images.length) return { error: "at least one image is required" };

    // Validate image paths exist
    const fs = require("fs");
    const validImages = [];
    for (const img of images) {
      const p = String(img || "").trim();
      if (!p) continue;
      try {
        if (fs.existsSync(p)) validImages.push(p);
      } catch {
        // skip paths that fail stat
      }
    }
    if (!validImages.length) {
      return { error: "None of the provided image paths exist on disk" };
    }

    const publishUrl = "https://creator.xiaohongshu.com/publish/publish";
    const { client, Runtime, Input, Page, DOM } = await this._getClient({
      shouldNavigate: true,
      url: publishUrl,
    });

    try {
      // Wait for the publish page to fully load
      await sleep(5000);

      // Step 0: Click "上传图文" to enter image+text posting mode
      const modeResult = await Runtime.evaluate({
        expression: `(() => {
          const btns = [...document.querySelectorAll('button, [role="button"], div')].filter(el => {
            const t = (el.textContent || '').trim();
            return t === '上传图文';
          });
          if (!btns.length) return { found: false };
          const r = btns[0].getBoundingClientRect();
          return { found: true, x: r.left+r.width/2, y: r.top+r.height/2 };
        })()`,
        returnByValue: true,
      });

      if (modeResult.result?.value?.found) {
        const mc = modeResult.result.value;
        await Input.dispatchMouseEvent({ type: "mousePressed", x: mc.x, y: mc.y, button: "left", clickCount: 1 });
        await sleep(100);
        await Input.dispatchMouseEvent({ type: "mouseReleased", x: mc.x, y: mc.y, button: "left", clickCount: 1 });
        await sleep(4000); // Wait for image+text form to render
      }

      // Step 1: Upload images via CDP
      const doc = await DOM.getDocument();
      const rootNodeId = doc?.root?.nodeId;
      if (!rootNodeId) {
        return { error: "Cannot access document root" };
      }

      const { nodeIds } = await DOM.querySelectorAll({ nodeId: rootNodeId, selector: 'input[type="file"]' });
      if (!nodeIds || !nodeIds.length) {
        return { error: "Cannot locate file upload input" };
      }

      await DOM.setFileInputFiles({ files: validImages, nodeId: nodeIds[0] });

      // Dispatch change event so React detects the upload
      await Runtime.evaluate({
        expression: `(() => {
          const inp = document.querySelector('input[type="file"]');
          if (inp) {
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            inp.dispatchEvent(new Event('input', { bubbles: true }));
          }
        })()`,
        returnByValue: true,
      });

      // Wait for upload + React to render the form
      await sleep(6000);

      // Step 2: Find and fill title — re-scan after upload since React renders it dynamically
      const titleInputResult = await Runtime.evaluate({
        expression: `(() => {
          // After image upload, creator page renders title + body inputs
          const candidates = [
            ...document.querySelectorAll('input[type="text"]'),
            ...document.querySelectorAll('[contenteditable="true"]'),
            ...document.querySelectorAll('textarea'),
            ...document.querySelectorAll('[class*=title] input'),
            ...document.querySelectorAll('[class*=title] textarea'),
            ...document.querySelectorAll('[placeholder*="标题"]'),
          ];
          for (const el of candidates) {
            const r = el.getBoundingClientRect();
            if (r.width > 100 && r.height > 20 && r.top < 600) {
              const ph = (el.placeholder || '').toLowerCase();
              const cls = (el.className || '').toLowerCase();
              // Title is typically the first visible text input after upload
              el.focus();
              return { found: true, placeholder: el.placeholder, tag: el.tagName, className: cls.slice(0, 60) };
            }
          }
          // Fallback: just look for any visible text input
          for (const el of document.querySelectorAll('input[type="text"], textarea')) {
            const r = el.getBoundingClientRect();
            if (r.width > 100 && r.height > 20) {
              el.focus();
              return { found: true, placeholder: el.placeholder, tag: el.tagName, fallback: true };
            }
          }
          return { found: false, candidateCount: candidates.length };
        })()`,
        returnByValue: true,
      });

      if (!titleInputResult.result?.value?.found) {
        return { error: "Title input not found after upload", detail: titleInputResult.result?.value };
      }

      // Clear and type title
      await Runtime.evaluate({
        expression: `(() => {
          const el = document.activeElement;
          if (el && (el.tagName==='INPUT' || el.tagName==='TEXTAREA' || el.isContentEditable)) {
            if (el.tagName==='INPUT' || el.tagName==='TEXTAREA') el.value = '';
            else el.textContent = '';
          }
        })()`,
        returnByValue: true,
      });
      await sleep(200);

      // Type title (max 20 chars)
      for (const ch of normalizedTitle.slice(0, 20)) {
        await Input.insertText({ text: ch });
        await sleep(25);
      }
      await sleep(500);

      // Step 3: Find body editor — typically a contenteditable after the title
      const bodyResult = await Runtime.evaluate({
        expression: `(() => {
          const els = [
            ...document.querySelectorAll('[contenteditable="true"]'),
            ...document.querySelectorAll('textarea'),
          ];
          // Find the LARGEST visible editor (body is bigger than title)
          let best = null;
          let bestArea = 0;
          for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < 40) continue;
            const area = r.width * r.height;
            if (area > bestArea) { bestArea = area; best = el; }
          }
          if (best) {
            best.focus();
            return { found: true, tag: best.tagName, area: bestArea };
          }
          return { found: false };
        })()`,
        returnByValue: true,
      });

      if (!bodyResult.result?.value?.found) {
        return { error: "Content editor not found after upload. Title may have been entered.", title: normalizedTitle };
      }

      // Clear body
      await Runtime.evaluate({
        expression: `(() => {
          const el = document.activeElement;
          if (el) {
            if (el.tagName==='TEXTAREA') el.value = '';
            else el.textContent = '';
          }
        })()`,
        returnByValue: true,
      });
      await sleep(200);

      // Type content
      for (const ch of normalizedContent) {
        await Input.insertText({ text: ch });
        await sleep(15);
      }
      await sleep(1000);

      // Step 4: Click publish button
      const pubBtnResult = await Runtime.evaluate({
        expression: `(() => {
          const btns = [...document.querySelectorAll('button')].filter(b => {
            const t = b.textContent.trim();
            return t === '发布' || t === '发布笔记';
          });
          for (const b of btns) {
            const r = b.getBoundingClientRect();
            if (r.width > 30) return { x: r.left+r.width/2, y: r.top+r.height/2, text: b.textContent.trim() };
          }
          return null;
        })()`,
        returnByValue: true,
      });

      if (!pubBtnResult.result?.value) {
        return { error: "Publish button not found. Content has been entered.", title: normalizedTitle };
      }

      const pubBtn = pubBtnResult.result.value;

      await Input.dispatchMouseEvent({ type: "mousePressed", x: pubBtn.x, y: pubBtn.y, button: "left", clickCount: 1 });
      await sleep(80);
      await Input.dispatchMouseEvent({ type: "mouseReleased", x: pubBtn.x, y: pubBtn.y, button: "left", clickCount: 1 });
      await sleep(5000);

      // Step 5: Verify
      const verifyResult = await Runtime.evaluate({
        expression: `(() => {
          const currentUrl = location.href;
          const bodyText = (document.body.textContent || '').slice(0, 500);
          const changed = !currentUrl.includes('/publish/publish');
          const successText = bodyText.includes('发布成功') || bodyText.includes('已发布');
          return { likelyPublished: changed || successText, url: currentUrl, textPreview: bodyText.slice(0, 200) };
        })()`,
        returnByValue: true,
      });

      return {
        published: verifyResult.result?.value?.likelyPublished ?? true,
        title: normalizedTitle,
        imagesCount: validImages.length,
        url: verifyResult.result?.value?.url || "",
        detail: verifyResult.result?.value || {},
      };
    } finally {
      await client.close();
    }
  }

  /** Take a screenshot of the current browser page */
  async screenshot() {
    const { client, Page } = await this._getClient({});
    try {
      const { data } = await Page.captureScreenshot({ format: "png" });
      return { imageBase64: data };
    } finally {
      await client.close();
    }
  }

  // ═══ Tool Host Interface ══════════════════════════

  listTools() {
    return [
      {
        name: "xhs_search",
        description:
          "Search Xiaohongshu (小红书) by keyword. Returns up to 12 note cards with title and link. Input: { keyword: string }",
        inputSchema: {
          type: "object",
          required: ["keyword"],
          properties: {
            keyword: { type: "string", description: "Search keyword" },
          },
        },
      },
      {
        name: "xhs_read",
        description:
          "Read a Xiaohongshu note. Searches by keyword, clicks into a result, and returns the full note content including title, description, author, and comments. Input: { keyword: string, noteIndex?: number }",
        inputSchema: {
          type: "object",
          required: ["keyword"],
          properties: {
            keyword: { type: "string", description: "Search keyword to find the note" },
            noteIndex: { type: "integer", description: "Which result to open (0 = first). Default 0.", default: 0 },
          },
        },
      },
      {
        name: "xhs_comment",
        description:
          "Post a comment on the currently open Xiaohongshu note. Must call xhs_read first to open a note — comment reuses that tab. Input: { text: string }",
        inputSchema: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", description: "Comment text to post" },
          },
        },
      },
      {
        name: "xhs_publish",
        description:
          "Publish a new Xiaohongshu note. Navigates to creator.xiaohongshu.com, uploads images, fills title and content, and clicks publish. Input: { title: string (max 20 chars), content: string, images: string[] (absolute file paths) }",
        inputSchema: {
          type: "object",
          required: ["title", "content", "images"],
          properties: {
            title: { type: "string", description: "Note title (max 20 characters)" },
            content: { type: "string", description: "Note body text" },
            images: {
              type: "array",
              items: { type: "string" },
              description: "Array of absolute file paths to images to upload",
            },
          },
        },
      },
    ];
  }

  async invokeTool(toolName, args = {}) {
    switch (toolName) {
      case "xhs_search": {
        const kw = String(args.keyword || "").trim();
        if (!kw) throw new Error("keyword is required");
        const results = await this.search(kw);
        return { results };
      }
      case "xhs_read": {
        const kw = String(args.keyword || "").trim();
        if (!kw) throw new Error("keyword is required");
        const idx = typeof args.noteIndex === "number" ? args.noteIndex : 0;
        const note = await this.readNote(kw, idx);
        return note;
      }
      case "xhs_comment": {
        const text = String(args.text || "").trim();
        if (!text) throw new Error("text is required");
        const result = await this.comment(text);
        return result;
      }
      case "xhs_publish": {
        const title = String(args.title || "").trim();
        const content = String(args.content || "").trim();
        const images = Array.isArray(args.images) ? args.images : [];
        if (!title) throw new Error("title is required");
        if (!content) throw new Error("content is required");
        if (!images.length) throw new Error("at least one image is required");
        const result = await this.publish({ title, content, images });
        return result;
      }
      default:
        throw new Error(`Unknown XHS tool: ${toolName}`);
    }
  }
}

module.exports = { XhsToolHost };
