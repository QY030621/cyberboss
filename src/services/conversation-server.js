const http = require("http");
const { URL } = require("url");
const path = require("path");
const fs = require("fs");

function startConversationServer({ store, port = 4319, host = "127.0.0.1" }) {
  if (!store || typeof store.readDate !== "function") {
    throw new Error("conversation server requires a valid store");
  }

  const pageHtml = loadSearchPage();

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const pathname = url.pathname;

      if (req.method === "GET" && (pathname === "/" || pathname === "/search")) {
        serveHtml(res, pageHtml);
        return;
      }

      if (req.method === "GET" && pathname === "/api/dates") {
        const dates = store.listDates();
        writeJson(res, 200, { dates });
        return;
      }

      if (req.method === "GET" && pathname === "/api/conversations") {
        const date = url.searchParams.get("date") || "";
        const records = store.readDate(date);
        writeJson(res, 200, { date: date || formatToday(), messages: records });
        return;
      }

      if (req.method === "GET" && pathname === "/healthz") {
        writeJson(res, 200, { ok: true });
        return;
      }

      writeJson(res, 404, { error: "not_found" });
    } catch (error) {
      writeJson(res, 500, { error: error.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      console.log(`[conversation-server] listening on http://${host}:${port}`);
      resolve(server);
    });
  });
}

function loadSearchPage() {
  const pagePath = path.resolve(__dirname, "..", "..", "templates", "conversation-search.html");
  try {
    return fs.readFileSync(pagePath, "utf8");
  } catch {
    return buildFallbackPage();
  }
}

function buildFallbackPage() {
  return [
    "<!DOCTYPE html>",
    "<html><head><meta charset='utf-8'><title>聊天记录搜索</title></head>",
    "<body><h1>Search page template not found</h1></body>",
    "</html>",
  ].join("\n");
}

function serveHtml(res, html) {
  const body = Buffer.from(String(html || ""), "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
  });
  res.end(body);
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function formatToday() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { startConversationServer };
