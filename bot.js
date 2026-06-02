// ===============================
// vpww-bot.js（完全版）
// 府県予報区だけを対象にした 1・2・3 レベル判定ロジック
// ===============================

import fs from "fs";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import { Client, GatewayIntentBits } from "discord.js";

// -------------------------------
// 設定
// -------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const WARNING_CHANNEL_ID = "1432943947789107374";   // 気象警報
const GENERAL_CHANNEL_ID = "1483610479103443149"; 
const TORNADO_CHANNEL_ID = "1432944215674982521";
const RIVER_CHANNEL_ID = "1501523378635542598";
const FEED_URL = "https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml";
const SAVE_FILE = "./vpww_last_updated.json";

// -------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// -------------------------------
function loadLastUpdated() {
  try {
    return JSON.parse(fs.readFileSync(SAVE_FILE, "utf8")).lastUpdated || "";
  } catch {
    return "";
  }
}

function saveLastUpdated(updated) {
  fs.writeFileSync(SAVE_FILE, JSON.stringify({ lastUpdated: updated }, null, 2));
}

function ensureArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// -------------------------------
// レベル判定
// -------------------------------
function levelFromName(name) {
  if (!name) return 1;
  if (name.includes("特別警報")) return 5;
  if (name.includes("危険警報")) return 4;
  if (name.includes("警報")) return 3;
  if (name.includes("注意報")) return 2;
  return 1;
}

function emojiOf(level) {
  return ["", "⬜️", "🟨", "🟥", "🟪", "⬛️"][level] || "⬜️";
}

function typeNameOf(level) {
  switch (level) {
    case 2: return "気象注意報";
    case 3: return "気象警報";
    case 4: return "危険警報";
    case 5: return "特別警報";
    default: return "気象情報";
  }
}

// -------------------------------
// Control.Title から現象名抽出
// -------------------------------
function extractPhenomenon(controlTitle) {
  if (!controlTitle) return "";

  // ★ 全ての括弧を抽出
  const matches = [...controlTitle.matchAll(/（([^（）]+)）/g)];

  // 括弧が無い → 現象名なし
  if (matches.length === 0) return "";

  // ★ 最後の括弧だけを現象名として採用
  return matches[matches.length - 1][1];
}


function normalizePhenomenon(ph) {
  if (!ph) return "";
  if (ph.includes("暴風")) return "暴風(雪)";
  return ph;
}

// -------------------------------
// 1・2・3 のレベル判定ロジック
// -------------------------------
function getLevelsForPrefecture(body, prefectureCode) {
  const warnings = ensureArray(body.Warning)
    .filter(w => w["@_type"] === "気象警報・注意報（府県予報区等）");

  let currentLevels = [];   // ① 今の最大レベル（解除以外）
  let canceledLevels = [];  // ② 解除されたもの
  let fromLevels = [];      // ③ OOからXX の OO のレベル

  for (const w of warnings) {
    for (const it of ensureArray(w.Item)) {
      if (String(it.Area?.Code) !== String(prefectureCode)) continue;

      const name = it.Kind?.Name || "";
      const status = it.Kind?.Status || "";
      const level = levelFromName(name);

      if (!name) continue;

      // ① 今の最大レベル（解除以外）
      if (!status.includes("解除")) {
        currentLevels.push(level);
      }

      // ② 解除されたもの
      if (status.includes("解除")) {
        canceledLevels.push(level);
      }

      // ③ OOからXX
      const m = status.match(/(.+?)から/);
      if (m) {
        const fromName = m[1];
        const fromLevel = levelFromName(fromName);
        fromLevels.push(fromLevel);
      }
    }
  }

  const emojiLevel = Math.max(...currentLevels, 1);
  const textLevel = Math.max(...currentLevels, ...canceledLevels, ...fromLevels, 1);

  return { emojiLevel, textLevel };
}

// -------------------------------
// Body 行生成
// -------------------------------
function buildBodyLines(body, prefectureCode) {
  const warnings = ensureArray(body.Warning)
    .filter(w => w["@_type"] === "気象警報・注意報（府県予報区等）");

  const items = [];

  for (const w of warnings) {
    for (const it of ensureArray(w.Item)) {
      if (String(it.Area?.Code) !== String(prefectureCode)) continue;

      const status = it.Kind?.Status || "不明";
      const name = it.Kind?.Name || "";
      items.push({ status, name });
    }
  }

  if (items.length === 0) return [];

  const groups = {};
  for (const it of items) {
    if (!groups[it.status]) groups[it.status] = [];
    groups[it.status].push(it.name);
  }

  const order = s => {
    if (s.includes("発表")) return 1;
    if (s.includes("継続")) return 2;
    if (s.includes("解除")) return 4;
    return 3;
  };

  return Object.keys(groups)
    .sort((a, b) => order(a) - order(b))
    .map(status => `［${status}］${groups[status].join("、")}`);
}

// -------------------------------
// extra.xml → VPWW55〜60
// -------------------------------
async function fetchVPWWFeed() {
  const res = await fetch(FEED_URL);
  const xmlText = await res.text();

  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  const xml = parser.parse(xmlText);

  const entries = ensureArray(xml.feed?.entry);
  if (!entries.length) return [];

  return entries
    .filter(e => {
      const id = e.id || "";
      return (
        id.includes("VPWW55") ||
        id.includes("VPWW56") ||
        id.includes("VPWW57") ||
        id.includes("VPWW58") ||
        id.includes("VPWW59") ||
        id.includes("VPWW60") ||
        id.includes("VPZJ50") ||
        id.includes("VPHW51") ||
        id.includes("VXKO")
      );
    })
    .map(e => {
      const link = ensureArray(e.link)[0];
      return {
        id: e.id,
        updated: e.updated,
        xmlUrl: link?.["@_href"] || e.id   // ★ VPZJ50 は link が無いことがある
      };
    });
}

function buildGeneralWeatherInfo(xml) {
  const report = xml.Report;
  if (!report) return null;

  const head = report.Head;

  const title = head?.Title || "全般気象情報";
  const serial = head?.Serial || "1";
  const text = head?.Headline?.Text || "";

  const dt = new Date(head?.ReportDateTime);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  const hh = String(dt.getHours()).padStart(2, "0");
  const mi = String(dt.getMinutes()).padStart(2, "0");

  const header = `《${title}　第${serial}号》（${mm}/${dd} ${hh}:${mi}発表）`;

  return `${header}\n${text}`;
}
function getTornadoTargetArea(xml) {
  const body = xml.Report?.Body;
  if (!body) return "不明";

  // Body の一次細分区域
  const warnings = ensureArray(body.Warning)
    .filter(w => w["@_type"] === "竜巻注意情報（一次細分区域等）");

  const allAreas = [];
  const activeAreas = [];

  for (const w of warnings) {
    for (const item of ensureArray(w.Item)) {
      const areaName = item.Area?.Name || "";
      const status = item.Kind?.Status || "";

      if (!areaName) continue;

      allAreas.push(areaName);

      if (status.includes("発表")) {
        activeAreas.push(areaName);
      }
    }
  }

  if (allAreas.length === 0) return "不明";

  if (activeAreas.length === allAreas.length) {
    return "全域";
  }

  return activeAreas.join("、");
}

// -------------------------------
// entry XML → メッセージ生成
// -------------------------------
async function buildMessagesFromEntry(entry) {
  const url = entry.xmlUrl;

  // ================================
  // ★ VPHW51（竜巻注意情報）
  // ================================
  if (url.includes("_VPHW51_")) {
    const res = await fetch(url);
    const xmlText = await res.text();

    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
    const xml = parser.parse(xmlText);

    const report = xml.Report;
    if (!report) return [];

    const head =
      report.Head ||
      report["jmx:Head"] ||
      report["informationBasis1:Head"] ||
      report["Head"];

    // ★ 県名は「発表細分」から取る
    const infoPref = ensureArray(head.Headline?.Information)
      .find(i => i["@_type"] === "竜巻注意情報（発表細分）");

    const prefName =
      infoPref?.Item?.Areas?.Area?.Name ||
      "不明";

    // ★ 目撃判定（Head.Title に「目撃」が含まれる）
    const headTitle = head?.Title || "";
    const isWitness = headTitle.includes("目撃");

    // ★ タイトル生成
    const title = isWitness
      ? `${prefName} 気象防災速報（竜巻目撃）`
      : `${prefName} 気象防災速報（竜巻注意）`;

    const serial = head?.Serial || "1";

    // 有効期限
    const valid = head?.ValidDateTime ? new Date(head.ValidDateTime) : null;
    const validHH = valid ? String(valid.getHours()).padStart(2, "0") : "--";
    const validMI = valid ? String(valid.getMinutes()).padStart(2, "0") : "--";

    // 発表時刻
    const dt = new Date(head?.ReportDateTime || entry.updated);
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    const hh = String(dt.getHours()).padStart(2, "0");
    const mi = String(dt.getMinutes()).padStart(2, "0");

    // ★ 対象地域（一次細分区域）
    const targetArea = getTornadoTargetArea(xml);

    // ★ メッセージ組み立て
    let header =
      `【🌪${title}🌪】\n` +
      `（${mm}/${dd} ${hh}:${mi}発表）\n`;

    // ★ 目撃あり → 警告行追加
    if (isWitness) {
      header += `【⚠️目撃情報あり⚠️】\n`;
    }

    header +=
      `［対象地域］${targetArea}\n` +
      `［第${serial}号 ${validHH}:${validMI}まで有効］\n\n` +
      `雷や急な風の変化などを感じたら頑丈な建物の中へ`;

    return [{
      type: "tornado",
      text: header
    }];
  }

  // ================================
  // ★ VPZJ50（全般気象情報）
  // ================================
  if (url.includes("_VPZJ50_")) {
    const res = await fetch(url);
    const xmlText = await res.text();

    const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
    const xml = parser.parse(xmlText);

    const report = xml.Report;
    if (!report) return [];

    const head =
      report.Head ||
      report["jmx:Head"] ||
      report["informationBasis1:Head"] ||
      report["Head"];

    const title = head?.Title || "全般気象情報";
    const serial = head?.Serial || "1";
    const headline = head?.Headline?.Text || "";  // ★ 短文だけ残す

    const dt = new Date(head?.ReportDateTime || entry.updated);
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    const hh = String(dt.getHours()).padStart(2, "0");
    const mi = String(dt.getMinutes()).padStart(2, "0");

    const header = `《${title}　第${serial}号》（${mm}/${dd} ${hh}:${mi}発表）`;

    return [{
      type: "general",
      text: `${header}\n${headline}`  // ★ 長文 Comment は付けない
    }];
  }

  // ================================
  // ★ VPWW（気象警報）
  // ================================
  const res = await fetch(url);
  const xmlText = await res.text();

  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  const xml = parser.parse(xmlText);

  const report = xml.Report;
  if (!report) return [];

  const head = report.Head;
  const body = report.Body;

  if (!shouldSendMessage(body)) return [];

  const controlTitle = report.Control?.Title || "";
  const rawPhenomenon = extractPhenomenon(controlTitle);
  const phenomenon = normalizePhenomenon(rawPhenomenon);

  const reportTime =
    head?.ReportDateTime ||
    report.Control?.DateTime ||
    entry.updated;

  const infos = ensureArray(head?.Headline?.Information);

  const targetInfos = infos.filter(
    info => info["@_type"] === "気象警報・注意報（府県予報区等）"
  );

  const messages = [];

  for (const info of targetInfos) {
    for (const item of ensureArray(info.Item)) {

      const prefectureName = item.Areas.Area.Name;
      const prefectureCode = item.Areas.Area.Code;

      const { emojiLevel, textLevel } = getLevelsForPrefecture(body, prefectureCode);

      const dt = new Date(reportTime);
      const mm = String(dt.getMonth() + 1).padStart(2, "0");
      const dd = String(dt.getDate()).padStart(2, "0");
      const hh = String(dt.getHours()).padStart(2, "0");
      const mi = String(dt.getMinutes()).padStart(2, "0");

      const title =
        `【${emojiOf(emojiLevel)}${prefectureName} ${typeNameOf(textLevel)}(${phenomenon})】\n` +
        `（${mm}/${dd} ${hh}:${mi}発表）`;

      const bodyLines = buildBodyLines(body, prefectureCode);
      const municipalBlocks = buildMunicipalBlocks(body);
      const regionBlocks = buildRegionBlocks(body);

      let msg = title;

      if (bodyLines.length > 0) msg += "\n" + bodyLines.join("\n");
      if (textLevel >= 4 && municipalBlocks.length > 0)
        msg += "\n\n" + municipalBlocks.join("\n\n");
      if (regionBlocks.length > 0)
        msg += "\n\n" + regionBlocks.join("\n");

      if (emojiLevel >= 4) {
        msg += "\n\n⚠️重大な災害が切迫　危険な場所から全員避難⚠️";
      }

      messages.push({
        type: "warning",
        text: msg
      });
    }
  }

  return messages;
}


// -------------------------------
async function postToDiscord(messageObj) {
  let channelId;

  if (messageObj.type === "general") {
    // 全般気象情報（VPZJ50）
    channelId = GENERAL_CHANNEL_ID;

  } else if (messageObj.type === "tornado") {
    // 竜巻注意情報（VPHW51）
    channelId = TORNADO_CHANNEL_ID;

  } else {
    // 気象警報（VPWW55〜60）
    channelId = WARNING_CHANNEL_ID;
  }

  const ch = client.channels.cache.get(channelId);
  if (ch) {
    await ch.send(messageObj.text);
  }
}


// -------------------------------
async function postAllOnStartup() {
  const entries = await fetchVPWWFeed();
  if (!entries.length) return;

  entries.sort((a, b) => a.updated.localeCompare(b.updated));

  for (const entry of entries) {
    const msgs = await buildMessagesFromEntry(entry);
    for (const m of msgs) await postToDiscord(m);
  }

  saveLastUpdated(entries.at(-1).updated);
}
function buildMunicipalBlocks(body) {
  const warnings = ensureArray(body.Warning)
    .filter(w => w["@_type"] === "気象警報・注意報（市町村等）");

  const map = {}; // { "暴風警報": ["八王子市", ...] }

  for (const w of warnings) {
    for (const it of ensureArray(w.Item)) {

      const name = it.Kind?.Name || "";
      const status = it.Kind?.Status || "";
      const areaName = it.Area?.Name || "";

      // ★ 種別名が空なら除外（"発表警報・注意報はなし" など）
      if (!name) continue;

      // ★ 「解除」は除外
      if (status.includes("解除")) continue;

      // ★ 危険警報（レベル4）または特別警報（レベル5）以外は除外
      const level = levelFromName(name);
      if (level < 4) continue;

      if (!map[name]) map[name] = [];
      map[name].push(areaName);
    }
  }

  // ★ 種別をレベル順に並べる（5→4）
  const sorted = Object.keys(map).sort((a, b) =>
    levelFromName(b) - levelFromName(a)
  );

  if (sorted.length === 0) return [];

  const blocks = [];

  for (const kindName of sorted) {
    const areas = map[kindName].join(" ");

    // ★ 絵文字なしで純粋な種別名だけ
    blocks.push(`〈${kindName}〉\n${areas}`);
  }

  return blocks;
}
function buildRegionBlocks(body) {
  const warnings = ensureArray(body.Warning)
    .filter(w => w["@_type"] === "気象警報・注意報（市町村等をまとめた地域等）");

  const regions = {};

  for (const w of warnings) {
    for (const it of ensureArray(w.Item)) {

      const areaName = it.Area?.Name || "";
      const kindName = it.Kind?.Name || "";
      const status = it.Kind?.Status || "";

      if (!areaName) continue;

      // ★ 「発表警報・注意報はなし」は情報ゼロ扱い → 後で除外
      if (status.includes("発表警報・注意報はなし")) continue;

      if (!regions[areaName]) regions[areaName] = [];

      const finalKind = kindName || "警報・注意報";
      const finalStatus = status || "解除";

      regions[areaName].push({
        kind: finalKind,
        status: finalStatus
      });
    }
  }

  const blocks = [];

  for (const area of Object.keys(regions).sort((a, b) => a.localeCompare(b, "ja"))) {
    const items = regions[area];

    // ★ 区域を出す条件：
    // ① 警報以上（解除含む）
    const hasWarningOrAbove = items.some(it => {
      const lv = levelFromName(it.kind);
      return lv >= 3; // 警報以上
    });

    // ② 「警報から注意報」を含む
    const hasWarnToAdv = items.some(it =>
      it.status.includes("警報から注意報")
    );

    // ★ どちらも満たさない区域は削除
    if (!hasWarningOrAbove && !hasWarnToAdv) continue;

    // ★ 最大レベル判定（解除はレベル1扱い）
    let maxLevel = 1;
    for (const it of items) {
      if (it.status.includes("解除")) continue;
      const lv = levelFromName(it.kind);
      if (lv > maxLevel) maxLevel = lv;
    }

    const emoji = {
      1: "⚪️",
      2: "🟡",
      3: "🔴",
      4: "🟣",
      5: "⚫️"
    }[maxLevel];

    const text = items
      .map(it => `[${it.status}]${it.kind}`)
      .join("、");

    blocks.push(`${emoji}${area}：${text}`);
  }

  return blocks;
}

function shouldSendMessage(body) {
  const municipal = ensureArray(body.Warning)
    .filter(w => w["@_type"] === "気象警報・注意報（市町村等）")
    .flatMap(w => ensureArray(w.Item));

  const regions = ensureArray(body.Warning)
    .filter(w => w["@_type"] === "気象警報・注意報（市町村等をまとめた地域等）")
    .flatMap(w => ensureArray(w.Item));

  // -------------------------
  // パターン1：市区町村で判定
  // -------------------------
  for (const it of municipal) {
    const name = it.Kind?.Name || "";
    const status = it.Kind?.Status || "";

    // 危険警報 or 特別警報の発表
    const lv = levelFromName(name);
    if (status.includes("発表") && lv >= 4) return true;

    // 特別警報から○○ / 危険警報から○○
    if (status.includes("特別警報から") || status.includes("危険警報から")) {
      return true;
    }
  }

  // -------------------------
  // パターン2：区域まとめで判定
  // -------------------------
  for (const it of regions) {
    const name = it.Kind?.Name || "";
    const status = it.Kind?.Status || "";

    // 発表警報・注意報はなし → 無視
    if (status.includes("発表警報・注意報はなし")) continue;

    const lv = levelFromName(name);

    // 警報以上の発表
    if (status.includes("発表") && lv >= 3) return true;

    // 警報から注意報
    if (status.includes("警報から注意報")) return true;
  }

  return false;
}

// -------------------------------
async function postUpdatedVPWW() {
  const last = loadLastUpdated();
  const entries = await fetchVPWWFeed();

  const newEntries = entries.filter(e => e.updated > last);
  if (!newEntries.length) return;

  newEntries.sort((a, b) => a.updated.localeCompare(b.updated));

  let newest = last;

  for (const entry of newEntries) {
    const msgs = await buildMessagesFromEntry(entry);
    for (const m of msgs) await postToDiscord(m);
    if (entry.updated > newest) newest = entry.updated;
  }

  saveLastUpdated(newest);
}

// -------------------------------
client.once("clientReady", () => {
  console.log("vpww-bot 起動完了");
  postAllOnStartup();
  setInterval(postUpdatedVPWW, 20000);
});

// -------------------------------
client.login(DISCORD_TOKEN);
