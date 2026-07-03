/** Quick smoke test for CDP Browser */
"use strict";

const { CDPBrowser } = require("../src/tools/cdp-browser");

async function main() {
  const cdp = new CDPBrowser({ headless: true });
  console.log("1. Starting Chrome...");
  await cdp.start();

  console.log("2. Navigating to example.com...");
  await cdp.navigate("https://example.com");

  const title = await cdp.getTitle();
  const url = await cdp.getURL();
  const text = await cdp.getText();

  console.log(`   Title: ${title}`);
  console.log(`   URL:   ${url}`);
  console.log(`   Text:  ${text.slice(0, 200)}...`);

  console.log("3. Taking screenshot...");
  const pngB64 = await cdp.screenshot();
  console.log(`   Screenshot: ${pngB64.length} chars base64`);

  console.log("4. Stopping...");
  await cdp.stop();

  console.log("✅ CDP Browser smoke test PASSED");
}

main().catch((err) => {
  console.error("❌ FAILED:", err.message);
  process.exit(1);
});
