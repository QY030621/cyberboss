#!/usr/bin/env node
/**
 * 免费生图 — Pollinations.ai，支持多种风格模型。
 *
 * 用法:
 *   node scripts/generate-image.js "描述" [宽] [高] [模型] [负面词]
 *   node scripts/generate-image.js --help
 *
 * 模型选项:
 *   flux (默认/通用)    flux-realism (写实/真人)
 *   flux-anime (二次元)  flux-3d (3D渲染)
 *   turbo (快速)
 *
 * 示例:
 *   node scripts/generate-image.js "a white fluffy cat sleeping on sofa, soft lighting, cozy atmosphere, 4k high quality" 600 600 flux-realism "ugly, deformed, blurry, low quality, extra limbs"
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OUT_DIR = process.env.IMAGE_OUT_DIR || path.resolve(__dirname, "..", "generated-images");
const BASE_URL = "https://image.pollinations.ai";

const VALID_MODELS = ["flux", "flux-realism", "flux-anime", "flux-3d", "turbo"];
const DEFAULT_MODEL = "flux-realism";
const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 600;
const DEFAULT_NEGATIVE = "ugly, deformed, blurry, low quality, extra fingers, bad anatomy, watermark, text, signature";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https:") ? https : http;
    transport.get(url, (res) => {
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(destPath); });
      file.on("error", reject);
    }).on("error", reject);
  });
}

function showHelp() {
  console.error("用法: node scripts/generate-image.js \"描述\" [宽] [高] [模型] [负面词]");
  console.error("");
  console.error("模型: flux, flux-realism(写实), flux-anime(二次元), flux-3d(3D), turbo");
  console.error("默认: 600x600 flux-realism");
  console.error("");
  console.error("示例:");
  console.error('  node scripts/generate-image.js "a cute cat sleeping, soft lighting" 600 600 flux-realism');
  process.exit(0);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) showHelp();

  const raw = process.argv[2];
  if (!raw) showHelp();

  const width = parseInt(process.argv[3]) || DEFAULT_WIDTH;
  const height = parseInt(process.argv[4]) || DEFAULT_HEIGHT;
  const model = VALID_MODELS.includes(process.argv[5]) ? process.argv[5] : DEFAULT_MODEL;
  const negative = process.argv[6] || DEFAULT_NEGATIVE;

  // 如果 prompt 里没有明显的风格词，自动加一点
  let prompt = raw;
  const hasStyle = /photorealistic|4k|hd|high quality|detailed|cinematic|photography|art style|oil painting|watercolor/i.test(prompt);
  if (!hasStyle) prompt = `${raw}, high quality, detailed, soft natural lighting`;

  const encoded = encodeURIComponent(prompt);
  const negEncoded = encodeURIComponent(negative);
  const url = `${BASE_URL}/prompt/${encoded}?width=${width}&height=${height}&model=${model}&nologo=true&enhance=true&negative=${negEncoded}&seed=${Math.floor(Math.random() * 100000)}`;

  console.error(`生成中... 模型=${model} 尺寸=${width}x${height}`);
  console.error(`描述: ${raw}`);

  ensureDir(OUT_DIR);

  const hash = crypto.createHash("md5").update(raw + Date.now()).digest("hex").slice(0, 8);
  const filename = `img_${hash}.jpg`;
  const destPath = path.join(OUT_DIR, filename);

  try {
    await download(url, destPath);
    console.log(destPath);
  } catch (err) {
    console.error("生图失败:", err.message);
    process.exit(1);
  }
}

main();
