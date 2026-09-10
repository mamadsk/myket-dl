/* ============================================================================
 *  Myket APK Downloader — Cloudflare Worker  (v5.2 · Hybrid)
 *  --------------------------------------------------------------------------
 *    GET  /                                رابط کاربری وب (با دارک‌مود)
 *    GET  /api/resolve?pkg=X               مشخصات کامل + لینک دانلود
 *           &engine=api|web                 اجبار موتور خاص (پیش‌فرض: هیبرید)
 *    GET  /api/download?pkg=X              استریم APK از طریق ورکر
 *    GET  /api/debug?pkg=X                 گزارش مرحله‌به‌مرحله (عیب‌یابی)
 *    GET  /healthz                         سلامت سرویس
 *
 *  معماری هیبرید (تست‌شده روی ورکر واقعی):
 *    ۱) API رسمی موبایل (apiserver.myket.ir) — auth + v2 info + v1/uri →
 *       لینک واقعی CDN با کد نسخه.
 *    ۲) fallback وب: زنجیره‌ی ریدایرکت myket.ir/dl — هشدار: /dl همیشه به‌جای
 *       APK واقعی، «اپلیکیشن مایکت» (myket-app-XXXX.apk) را با نام جعلی
 *       می‌دهد؛ این تله با pattern تشخیص داده و رد می‌شود.
 *    ۳) مشخصات کامل از اسکرپ JSON-LD صفحه‌ی عمومی برنامه.
 *
 *  تغییرات v5.2: تم رنگی (انتخاب رنگ اصلی) اضافه شد · زیرنویس به‌روز شد ·
 *  باکس مشخصات بازطراحی شد · دارک‌مود با ذخیره‌سازی اضافه شد.
 * ==========================================================================*/

"use strict";

const SITE = "https://myket.ir";
const API_SERVER = "https://apiserver.myket.ir";
const AUTH_URL = API_SERVER + "/v1/devices/authorize/";
const V1_BASE = API_SERVER + "/v1/applications";
const V2_BASE = API_SERVER + "/v2/applications";
const MYKET_VERSION_H = "914";
const ANDROID_API = "29";
const WORKER_VERSION = "5.2.0";

const DEVICE_UA =
  "Dalvik/2.1.0 (Linux; U; Android 10; Nokia 7 plus Build/QP1A.190711.020)";
const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

const PAGE_TTL = 30 * 60 * 1000;
const TOKEN_TTL = 10 * 24 * 60 * 60 * 1000;
const API_BREAKER_TTL = 30 * 60 * 1000;

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status || 502;
    this.code = code || "UPSTREAM";
  }
}

function browserHeaders(extra) {
  return Object.assign(
    {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7",
      "Upgrade-Insecure-Requests": "1",
    },
    extra || {}
  );
}

/* ------------------------------ استخراج نام بسته --------------------------- */

const PKG_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

function extractPackage(input) {
  const q = (input || "").trim();
  if (!q) return null;
  if (PKG_RE.test(q)) return q;
  try {
    const u = new URL(q.indexOf("://") === -1 ? "https://" + q : q);
    const pn = u.searchParams.get("packageName") || u.searchParams.get("id");
    if (pn && PKG_RE.test(pn)) return pn;
    const m = u.pathname.match(/\/apps?\/([^/?#]+)/i);
    if (m) {
      const seg = decodeURIComponent(m[1]);
      if (PKG_RE.test(seg)) return seg;
    }
  } catch (e) { /* URL معتبر نبود */ }
  return null;
}

/* --------------------------- ابزارهای اسکرپ HTML --------------------------- */

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(Number(d)); })
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripTags(s) {
  return decodeEntities(
    String(s || "")
      .replace(/<[^>]*>/g, " ")
      // پاک‌سازی کاراکترهای جهت‌دهنده و نامرئی یونیکد
      .replace(/[‎‏‪-‮⁦-⁩]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function pickMeta(html, prop) {
  const re1 = new RegExp(
    "<meta[^>]+(?:property|name)=[\"']" + prop + "[\"'][^>]+content=[\"']([^\"']+)[\"']",
    "i"
  );
  const re2 = new RegExp(
    "<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+(?:property|name)=[\"']" + prop + "[\"']",
    "i"
  );
  const m = html.match(re1) || html.match(re2);
  return m ? decodeEntities(m[1]) : null;
}

function absolute(u) {
  if (!u) return null;
  if (u.indexOf("http") === 0) return u;
  if (u.indexOf("//") === 0) return "https:" + u;
  return SITE + (u.indexOf("/") === 0 ? u : "/" + u);
}

function pickJsonLd(html, type) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const d = JSON.parse(decodeEntities(m[1]));
      if (d && d["@type"] === type) return d;
    } catch (e) { /* بلاک معیوب */ }
  }
  return null;
}

/* ------------------------- اسکرپ صفحه‌ی عمومی برنامه ----------------------- */

const pageCache = new Map();

async function scrapeAppPage(pkg) {
  const hit = pageCache.get(pkg);
  if (hit && Date.now() - hit.at < PAGE_TTL) return hit.data;

  const res = await fetch(SITE + "/app/" + pkg, {
    headers: browserHeaders({ Accept: "text/html" }),
    signal: AbortSignal.timeout(9000),
  });
  if (res.status === 404) {
    throw new ApiError("برنامه‌ای با این نام بسته در مایکت پیدا نشد.", 404, "NOT_FOUND");
  }
  if (!res.ok) return null;
  const html = await res.text();

  const out = {
    title: null, tagline: null, description: null, icon: null,
    screenshots: [], category: null, developer: null,
    specs: [], changelog: [], ld: null,
  };

  const ld = pickJsonLd(html, "SoftwareApplication");
  if (ld) {
    out.ld = {
      name: ld.name || null,
      description: ld.description || null,
      fileSizeKB: typeof ld.FileSize === "number" ? ld.FileSize : null,
      softwareVersion: typeof ld.softwareVersion === "string" ? ld.softwareVersion.trim() : null,
      category: ld.applicationCategory || null,
      datePublished: ld.datePublished || null,
      dateModified: ld.dateModified || null,
      rating:
        ld.aggregateRating && typeof ld.aggregateRating === "object"
          ? {
              value: Number(ld.aggregateRating.ratingValue) || null,
              count: Number(ld.aggregateRating.ratingCount) || null,
              best: Number(ld.aggregateRating.bestRating) || 5,
            }
          : null,
      price: ld.offers && ld.offers.price != null ? String(ld.offers.price) : null,
    };
    out.title = ld.name || null;
    out.description = ld.description || null;
    if (ld.image) out.icon = absolute(ld.image);
  }

  const bc = pickJsonLd(html, "BreadcrumbList");
  if (bc && Array.isArray(bc.itemListElement) && bc.itemListElement.length > 1) {
    const it = bc.itemListElement[1] && bc.itemListElement[1].item;
    if (it && it.name) out.category = { name: it.name, url: absolute(it["@id"] || "") };
  }

  const head = html.match(
    /<span[^>]*class="app-title"[^>]*>([^<]+)<\/span>\s*<span[^>]*class="app-tag-line"[^>]*>([^<]*)<\/span>/i
  );
  if (head) {
    out.title = out.title || decodeEntities(head[1]).trim();
    out.tagline = decodeEntities(head[2]).trim() || null;
  }

  const ogImg = pickMeta(html, "og:image");
  if (ogImg) out.icon = absolute(ogImg);
  if (!out.icon) {
    const ic = html.match(/(app-icon\/[^"'\s>]+)/i);
    if (ic) out.icon = absolute(ic[1]);
  }
  out.description = out.description || pickMeta(html, "og:description");

  const pairs = [];
  const rowRe = /<td[^>]*>([^<]{1,60})<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  let rm;
  while ((rm = rowRe.exec(html))) {
    const label = stripTags(rm[1]);
    const cellHtml = rm[2];
    const value = stripTags(cellHtml);
    if (!label || !value) continue;
    const link = cellHtml.match(/href="([^"]+)"/);
    pairs.push([label, value]);
    if (label === "سازنده") out.developer = { name: value, url: link ? absolute(link[1]) : null };
    if (label === "دسته‌بندی" && !out.category) out.category = { name: value, url: link ? absolute(link[1]) : null };
  }
  const seen = {};
  out.specs = pairs
    .filter(function (p) {
      if (seen[p[0]]) return false;
      seen[p[0]] = true;
      return true;
    })
    .slice(0, 24);

  const rawShots = html.match(/asset-files\/screenshots\/[^"'\s>]+\.(?:png|jpg|webp)/gi) || [];
  const byFile = {};
  const order = [];
  rawShots.forEach(function (s) {
    const file = s.split("/").pop();
    if (!(file in byFile)) {
      byFile[file] = s;
      order.push(file);
    } else if (s.indexOf("xlarge") !== -1 && byFile[file].indexOf("xlarge") === -1) {
      byFile[file] = s;
    }
  });
  out.screenshots = order.slice(0, 12).map(function (f) { return absolute(byFile[f]); }).filter(Boolean);

  const ci = html.indexOf("نسخه جدید");
  if (ci !== -1) {
    const end = html.indexOf("نظرات و امتیازها", ci);
    const chunk = stripTags(html.slice(ci, end > ci ? end : ci + 4000));
    out.changelog = chunk
      .split("●")
      .map(function (s) { return s.trim(); })
      .filter(function (s) {
        return s.length > 2 && s.length < 320 && s.indexOf("تغییرات") === -1 && s.indexOf("نسخه جدید") === -1;
      })
      .slice(0, 8);
  }

  // -- توزیع امتیاز: پنج درصدِ مربوط به ستاره‌های ۵ تا ۱ بعد از «نظرات و امتیازها» --
  out.ratingBars = null;
  const ri = html.indexOf("نظرات و امتیازها");
  if (ri !== -1) {
    const seg = html.slice(ri, ri + 4000);
    const barRe = /width:\s*(\d+(?:\.\d+)?)%/g;
    const bars = [];
    let bm;
    while ((bm = barRe.exec(seg)) && bars.length < 5) bars.push(Number(bm[1]));
    if (bars.length >= 3) {
      out.ratingBars = {};
      [5, 4, 3, 2, 1].forEach(function (star, idx) {
        if (bars[idx] != null) out.ratingBars[star] = bars[idx];
      });
    }
  }

  // -- برنامه‌های مشابه/مرتبط --
  out.related = [];
  const relRe = /<a[^>]+class="app-detail-link"[^>]*data-package-name="([a-zA-Z][a-zA-Z0-9_.]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let rm2;
  const relSeen = {};
  while ((rm2 = relRe.exec(html)) && out.related.length < 8) {
    const rpkg = rm2[1];
    if (!PKG_RE.test(rpkg) || relSeen[rpkg] || rpkg === pkg) continue;
    relSeen[rpkg] = true;
    const inner = rm2[2];
    const pm = inner.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || inner.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
    const title = pm ? stripTags(pm[1]) : null;
    const im = inner.match(/src="([^"]*(?:icons|app-icon)[^"]*)"/i);
    if (title) {
      out.related.push({ pkg: rpkg, title: title.slice(0, 48), icon: absolute(im && im[1]) });
    }
  }

  pageCache.set(pkg, { at: Date.now(), data: out });
  return out;
}

/* ------------------------- کلاینت API رسمی موبایل -------------------------- */

let cachedToken = "";
let tokenFetchedAt = 0;
let apiDownUntil = 0; // circuit breaker

function authBody() {
  return {
    acId: "", acKey: "",
    adId: "82d8810f-e83c-46c0-8bf5-080a83d635c6",
    andId: "82ee24cd7aad5173",
    api: ANDROID_API, brand: "Nokia",
    cpuAbis: ["armeabi-v7a", "armeabi"], dens: 2.625,
    deviceModel: "Nokia 7 plus", deviceName: "B2N_sprout",
    deviceType: "normal", dsize: "300",
    hsh: "4e9118e410d75e2ef80aac45357493e397037940",
    imei: "", imsi: "", manufacturer: "HMD Global",
    product: "Onyx_00WW",
    supportedAbis: ["arm64-v8a", "armeabi-v7a", "armeabi"],
    uuid: "235f746f-3a40-44b7-97b4-01cac934df6d",
  };
}

function apiHeaders(token) {
  return {
    "Content-Type": "application/json", Accept: "application/json",
    "Myket-Version": MYKET_VERSION_H, Authorization: token || "", "User-Agent": DEVICE_UA,
  };
}

async function getToken(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && cachedToken && now - tokenFetchedAt < TOKEN_TTL) return cachedToken;
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: apiHeaders(""),
    body: JSON.stringify(authBody()),
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) {
    let msg = "احراز هویت در مایکت ناموفق بود (کد " + res.status + ")";
    try {
      const j = await res.json();
      if (j && j.translatedMessage) msg = j.translatedMessage;
    } catch (e) { /* */ }
    throw new ApiError(msg, 502, "AUTH_FAILED");
  }
  const data = await res.json();
  cachedToken = data.token;
  tokenFetchedAt = now;
  return cachedToken;
}

async function apiFetch(url) {
  let res = await fetch(url, {
    headers: apiHeaders(await getToken(false)),
    signal: AbortSignal.timeout(7000),
  });
  if (res.status === 401) {
    res = await fetch(url, {
      headers: apiHeaders(await getToken(true)),
      signal: AbortSignal.timeout(7000),
    });
  }
  return res;
}

async function apiAppInfo(pkg) {
  const res = await apiFetch(V2_BASE + "/" + pkg + "/");
  if (res.status === 404) {
    throw new ApiError("برنامه‌ای با این نام بسته در مایکت پیدا نشد.", 404, "NOT_FOUND");
  }
  if (!res.ok) throw new ApiError("دریافت اطلاعات از API ناموفق بود (کد " + res.status + ")", 502);
  return res.json();
}

async function apiDownloadUri(pkg, versionCode) {
  const url =
    V1_BASE + "/" + pkg + "/uri/?" +
    new URLSearchParams({
      action: "start",
      requestedVersion: String(versionCode),
      fileType: "App",
      lang: "fa",
    }).toString();
  const res = await apiFetch(url);
  if (!res.ok) {
    let msg = "ساخت لینک دانلود از API ناموفق بود (کد " + res.status + ")";
    try {
      const j = await res.json();
      if (j && j.translatedMessage) msg = j.translatedMessage;
    } catch (e) { /* */ }
    throw new ApiError(msg, 502, "URI_FAILED");
  }
  const data = await res.json();
  if (!data.uriPath || !Array.isArray(data.uriServers) || !data.uriServers.length) {
    throw new ApiError("API لینک دانلودی برنگرداند.", 502, "URI_FAILED");
  }
  const server = data.uriServers[Math.floor(Math.random() * data.uriServers.length)];
  return server + data.uriPath;
}

// زنجیره‌ی کامل API: info + uri → {directUrl, versionCode, isFree, info}
async function apiChain(pkg, force) {
  if (!force && Date.now() < apiDownUntil) {
    throw new ApiError("API موبایل موقتاً از مدار خارج است (circuit breaker).", 502, "API_DOWN");
  }
  try {
    const info = await apiAppInfo(pkg);
    const version = info.version || {};
    const price = info.price || {};
    const size = info.size || {};
    const versionCode = version.code != null ? String(version.code) : null;

    if (price.isFree === false) {
      throw new ApiError("این برنامه پولی است؛ دانلود فقط برای برنامه‌های رایگان ممکن است.", 403, "PAID");
    }
    let directUrl = null;
    if (versionCode) directUrl = await apiDownloadUri(pkg, versionCode);

    apiDownUntil = 0; // سالم است — مدار بسته
    return {
      directUrl: directUrl,
      versionCode: versionCode,
      isFree: true,
      sizeText: typeof size.actual === "string" ? size.actual : null,
      icon: info.icon || null,
      apiName: info.name || null,
    };
  } catch (e) {
    const isNotFound = e instanceof ApiError && e.code === "NOT_FOUND";
    const isPaid = e instanceof ApiError && e.code === "PAID";
    if (!isNotFound && !isPaid) {
      // خطای شبکه/تایم‌اوت/۵xx → مدار را باز کن تا درخواست‌های بعدی کند نشوند
      apiDownUntil = Date.now() + API_BREAKER_TTL;
    }
    throw e;
  }
}

/* ---------------- فالبک وب: زنجیره‌ی /dl (با تشخیص تله) -------------------- */
/*  هشدار تست‌شده: myket.ir/dl تقریباً همیشه به‌جای APK واقعی، فایل             */
/*  myket-app-XXXX.apk (اپلیکیشن فروشگاه مایکت) را با نام جعلی برنامه می‌دهد.   */

const TRAP_RE = /myket-app-\d+\.apk/i;

async function webDl(pkg) {
  let url = SITE + "/dl?packageName=" + encodeURIComponent(pkg);
  const jar = {};
  let res = null;

  for (let hop = 0; hop < 5; hop++) {
    const headers = browserHeaders({ Referer: SITE + "/app/" + pkg });
    const ck = Object.keys(jar).map(function (k) { return k + "=" + jar[k]; }).join("; ");
    if (ck) headers["Cookie"] = ck;

    res = await fetch(url, { redirect: "manual", headers: headers, signal: AbortSignal.timeout(9000) });

    try {
      const sc = res.headers.get("set-cookie");
      if (sc) {
        const re = /([^\s=;,]+)=([^;]*)/g;
        let m;
        while ((m = re.exec(sc))) jar[m[1]] = m[2];
      }
    } catch (e) { /* */ }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("Location");
      try { if (res.body) await res.body.cancel(); } catch (e) { /* OK */ }
      if (!loc) throw new ApiError("پاسخ نامعتبر از سرور دانلود مایکت.", 502, "DL_FAILED");
      const next = new URL(loc, url);
      if (next.protocol === "http:" || next.protocol === "https:") {
        url = next.toString();
        continue;
      }
      throw new ApiError("لینک دانلود تحت وب در دسترس نیست.", 502, "DL_FAILED");
    }
    break;
  }
  if (!res) throw new ApiError("زنجیره‌ی دانلود کامل نشد.", 502, "DL_FAILED");

  const ct = (res.headers.get("Content-Type") || "").toLowerCase();
  const cd = res.headers.get("Content-Disposition") || "";
  let fileName = null;
  const fm = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  if (fm) {
    try { fileName = decodeURIComponent(fm[1].trim()); } catch (e) { fileName = fm[1].trim(); }
  }

  const isFile =
    ct.indexOf("application/vnd.android.package-archive") !== -1 ||
    ct.indexOf("application/octet-stream") !== -1 ||
    cd.toLowerCase().indexOf("attachment") !== -1 ||
    /\.apk(\?|#|$)/i.test(url);

  if (!res.ok) {
    try { if (res.body) await res.body.cancel(); } catch (e) { /* OK */ }
    if (res.status === 404) throw new ApiError("برنامه پیدا نشد.", 404, "NOT_FOUND");
    throw new ApiError("دریافت لینک دانلود ناموفق بود (کد " + res.status + ")", 502, "DL_FAILED");
  }

  if (isFile && TRAP_RE.test(url)) {
    try { if (res.body) await res.body.cancel(); } catch (e) { /* OK */ }
    throw new ApiError(
      "مایکت در /dl به‌جای فایل واقعی برنامه، APK فروشگاه خودش را می‌فرستد (myket-app) — این لینک رد شد. از موتور API استفاده می‌شود.",
      502, "TRAP"
    );
  }

  if (isFile) {
    try { if (res.body) await res.body.cancel(); } catch (e) { /* OK */ }
    return { url: url, fileName: fileName };
  }

  let text = "";
  try { text = await res.text(); } catch (e) { /* OK */ }
  if (/پولی|خرید نسخه|قیمت/.test(text)) {
    throw new ApiError("این برنامه پولی است؛ دانلود فقط برای برنامه‌های رایگان ممکن است.", 403, "PAID");
  }
  throw new ApiError("لینک دانلود برای این برنامه در دسترس نیست.", 502, "DL_FAILED");
}

/* ------------------------------ ادغام نهایی -------------------------------- */

function specValue(specs, label) {
  for (let i = 0; i < specs.length; i++) if (specs[i][0] === label) return specs[i][1];
  return null;
}

async function resolveApp(pkg, opts) {
  opts = opts || {};
  const engine = opts.engine || "hybrid";

  // ۱) موازی: اسکرپ صفحه + زنجیره‌ی API (مگر engine=web)
  const jobs = { page: scrapeAppPage(pkg) };
  jobs.api =
    engine === "web"
      ? Promise.resolve({ skipped: true })
      : apiChain(pkg, engine === "api" && opts.force).then(
          function (v) { return { ok: v }; },
          function (e) { return { err: e }; }
        );
  const page = await jobs.page;
  const apiRes = await jobs.api;
  const api = apiRes && apiRes.ok ? apiRes.ok : null;
  const apiErr = apiRes && apiRes.err ? apiRes.err : null;

  // پولی بودن با اعتبار API
  if (apiErr instanceof ApiError && apiErr.code === "PAID" && engine !== "web") {
    return paidResult(pkg, page, api && api.apiName);
  }
  if (apiErr instanceof ApiError && apiErr.code === "NOT_FOUND" && engine !== "web" && !page) {
    throw apiErr;
  }

  const priceTxt = page && page.ld && page.ld.price != null ? String(page.ld.price).replace(/[٬,\s]/g, "") : null;
  const priceNum = priceTxt !== null ? Number(priceTxt) : NaN;
  const ldSaysPaid = !isNaN(priceNum) && priceNum > 0;
  if (ldSaysPaid && !api) return paidResult(pkg, page, null);

  const result = {
    ok: true,
    v: WORKER_VERSION,
    engine: null,
    packageName: pkg,
    pageUrl: SITE + "/app/" + pkg,

    title: (page && page.title) || (api && api.apiName) || pkg,
    tagline: (page && page.tagline) || null,
    description: (page && page.description) || null,
    icon: (page && page.icon) || (api && api.icon) || null,
    screenshots: (page && page.screenshots) || [],
    category: (page && page.category) || null,
    developer: (page && page.developer) || null,

    versionText:
      (page && specValue(page.specs || [], "نسخه")) ||
      (page && page.ld && page.ld.softwareVersion) || null,
    versionCode: api ? api.versionCode : null,
    sizeText:
      (page && specValue(page.specs || [], "حجم")) ||
      (api && api.sizeText) || null,

    rating: (page && page.ld && page.ld.rating) || null,
    ratingCountText: (page && specValue(page.specs || [], "تعداد نظرات")) || null,
    installsText: (page && specValue(page.specs || [], "تعداد دانلود")) || null,
    lastUpdateText: (page && specValue(page.specs || [], "آخرین بروزرسانی")) || null,
    appType: (page && specValue(page.specs || [], "نوع")) || null,
    datePublished: (page && page.ld && page.ld.datePublished) || null,
    dateModified: (page && page.ld && page.ld.dateModified) || null,

    changelog: (page && page.changelog) || [],
    specs: (page && page.specs) || [],
    ratingBars: (page && page.ratingBars) || null,
    related: (page && page.related) || [],

    isFree: true,
    fileName: pkg + ".apk",
    directUrl: null,
    proxyUrl: null,
  };

  // ۲) لینک دانلود — اولویت با API
  const apiLink = api && api.directUrl && engine !== "web";
  if (apiLink) {
    result.directUrl = api.directUrl;
    result.engine = "api";
    if (api.versionCode) result.fileName = pkg + "-v" + api.versionCode + ".apk";
    result.proxyUrl = "/api/download?pkg=" + encodeURIComponent(pkg) + "&engine=api";
    return result;
  }

  // ۳) فالبک وب (مگر engine=api) — با تشخیص تله
  if (engine !== "api") {
    try {
      const dl = await webDl(pkg);
      result.directUrl = dl.url;
      result.engine = "web";
      if (dl.fileName) result.fileName = dl.fileName;
      result.proxyUrl = "/api/download?pkg=" + encodeURIComponent(pkg) + "&engine=web";
      return result;
    } catch (e) {
      if (e instanceof ApiError && e.code === "PAID") return paidResult(pkg, page, result.title);
      if (e instanceof ApiError && e.code === "NOT_FOUND") throw e;
      result.downloadError =
        e instanceof ApiError && e.code === "TRAP"
          ? e.message
          : "ساخت لینک دانلود ناموفق بود." + (apiErr && apiErr.message ? " (API: " + apiErr.message + ")" : "");
      return result;
    }
  }

  // engine=api ولی API لینک نداد
  if (!result.directUrl) {
    result.downloadError =
      apiErr && apiErr.message ? "API: " + apiErr.message : "API لینک دانلودی برای این برنامه برنگرداند.";
  }
  return result;
}

function paidResult(pkg, page, altTitle) {
  return {
    ok: false,
    code: "PAID",
    message: "این برنامه پولی است؛ دانلود فقط برای برنامه‌های رایگان ممکن است.",
    packageName: pkg,
    pageUrl: SITE + "/app/" + pkg,
    title: (page && page.title) || altTitle || pkg,
    icon: (page && page.icon) || null,
    isFree: false,
  };
}

/* --------------------------------- مسیریاب --------------------------------- */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status, extra) {
  const headers = Object.assign(
    { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    CORS_HEADERS,
    extra || {}
  );
  return new Response(JSON.stringify(data, null, 2), { status: status || 200, headers: headers });
}

function errJson(err) {
  const status = err instanceof ApiError ? err.status : 500;
  const code = err instanceof ApiError ? err.code : "INTERNAL";
  return json(
    {
      ok: false,
      code: code,
      message: err && err.message ? String(err.message) : "خطای غیرمنتظره در ورکر رخ داد. دوباره تلاش کنید.",
    },
    status
  );
}

function contentDisposition(name) {
  const safe = String(name || "app.apk");
  const ascii = safe.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  return "attachment; filename=\"" + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(safe);
}

async function handleResolve(url) {
  const pkg = extractPackage(url.searchParams.get("pkg"));
  if (!pkg) {
    return json(
      { ok: false, code: "BAD_PACKAGE", message: "نام بسته یا لینک مایکت معتبر نیست. مثال: com.digikala" },
      400
    );
  }
  const engine = (url.searchParams.get("engine") || "hybrid").toLowerCase();
  try {
    const result = await resolveApp(pkg, {
      engine: ["api", "web"].indexOf(engine) !== -1 ? engine : "hybrid",
      force: url.searchParams.get("force") === "1",
    });
    return json(result, 200);
  } catch (err) {
    return errJson(err);
  }
}

async function handleDownload(url) {
  const pkg = extractPackage(url.searchParams.get("pkg"));
  if (!pkg) return json({ ok: false, code: "BAD_PACKAGE", message: "نام بسته معتبر نیست." }, 400);
  const engine = (url.searchParams.get("engine") || "").toLowerCase();

  try {
    let target = null;
    let fileName = pkg + ".apk";

    // اول API (مگر engine=web)
    if (engine !== "web") {
      try {
        const api = await apiChain(pkg, engine === "api");
        if (api && api.directUrl) {
          target = api.directUrl;
          if (api.versionCode) fileName = pkg + "-v" + api.versionCode + ".apk";
        }
      } catch (e) {
        if (engine === "api") throw e;
        if (e instanceof ApiError && (e.code === "PAID" || e.code === "NOT_FOUND")) throw e;
        // در حالت هیبرید، به فالبک وب می‌رویم
      }
    }
    // فالبک وب (بدون تله)
    if (!target) {
      const dl = await webDl(pkg);
      target = dl.url;
      if (dl.fileName) fileName = dl.fileName;
    }

    const upstream = await fetch(target, {
      headers: { "User-Agent": DEVICE_UA, Referer: SITE + "/app/" + pkg },
    });
    if (!upstream.ok || !upstream.body) {
      throw new ApiError("دانلود فایل از سرور مایکت ناموفق بود (کد " + upstream.status + ")", 502);
    }
    const headers = new Headers();
    headers.set("Content-Type", "application/vnd.android.package-archive");
    headers.set("Content-Disposition", contentDisposition(fileName));
    headers.set("Cache-Control", "no-store");
    const len = upstream.headers.get("Content-Length");
    if (len) headers.set("Content-Length", len);
    return new Response(upstream.body, { status: 200, headers: headers });
  } catch (err) {
    return errJson(err);
  }
}

/* ------------------------- عیب‌یابی مرحله‌به‌مرحله -------------------------- */

async function timedStep(fn) {
  const t0 = Date.now();
  try {
    const v = await fn();
    return { ok: true, ms: Date.now() - t0, value: v };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String((e && e.message) || e), code: e && e.code };
  }
}

async function handleDebug(url) {
  const pkg = extractPackage(url.searchParams.get("pkg")) || "com.digikala";
  const report = { v: WORKER_VERSION, pkg: pkg, at: new Date().toISOString(), steps: [] };

  // ۱) صفحه‌ی برنامه
  const s1 = await timedStep(async function () {
    const res = await fetch(SITE + "/app/" + pkg, {
      headers: browserHeaders({ Accept: "text/html" }),
      signal: AbortSignal.timeout(9000),
    });
    try { if (res.body) await res.body.cancel(); } catch (e) { /* OK */ }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return "HTTP " + res.status;
  });
  report.steps.push({ step: "app_page", ok: s1.ok, ms: s1.ms, detail: s1.ok ? s1.value : s1.error });

  // ۲) API موبایل — auth
  const s2 = await timedStep(async function () {
    const t = await getToken(false);
    return "token ok (" + String(t).slice(0, 8) + "…)";
  });
  report.steps.push({ step: "api_auth", ok: s2.ok, ms: s2.ms, detail: s2.ok ? s2.value : s2.error });

  // ۳) زنجیره‌ی کامل API
  const s3 = await timedStep(async function () {
    const a = await apiChain(pkg, true);
    return a.directUrl ? "OK · v" + a.versionCode + " · " + String(a.directUrl).slice(0, 60) : "بدون لینک";
  });
  report.steps.push({ step: "api_chain", ok: s3.ok, ms: s3.ms, detail: s3.ok ? s3.value : (s3.code ? "[" + s3.code + "] " : "") + s3.error });

  // ۴) فالبک وب + بررسی تله
  const s4 = await timedStep(async function () {
    const d = await webDl(pkg);
    return "OK · " + (d.fileName || String(d.url).slice(0, 60));
  });
  report.steps.push({
    step: "web_dl",
    ok: s4.ok,
    ms: s4.ms,
    detail: s4.ok ? s4.value : (s4.code ? "[" + s4.code + "] " : "") + s4.error,
    note: s4.code === "TRAP" ? "انتظار می‌رود: /dl فایل جعلی می‌دهد" : undefined,
  });

  report.ok = s1.ok && (s3.ok || s4.ok);
  return json(report, 200);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== "GET") {
      return json({ ok: false, code: "METHOD", message: "فقط متد GET پشتیبانی می‌شود." }, 405);
    }

    if (path === "/api/resolve") return handleResolve(url);
    if (path === "/api/download") return handleDownload(url);
    if (path === "/api/debug") return handleDebug(url);
    if (path === "/healthz") return json({ ok: true, v: WORKER_VERSION, engine: "hybrid" });
    if (path === "/favicon.ico") return new Response(null, { status: 204 });

    if (path === "/") {
      return new Response(PAGE, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" },
      });
    }
    return json({ ok: false, code: "NOT_FOUND", message: "مسیر پیدا نشد." }, 404);
  },
};

/* ============================== رابط کاربری وب ============================== */
/*  نکته: به‌خاطر اجرا داخل template literal، در اسکریپت این صفحه از backtick  */
/*  و از الگوی ${} استفاده نشده و رشته‌ها با + به هم چسبانده شده‌اند.          */

const PAGE = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#F5F1E6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#161712" media="(prefers-color-scheme: dark)">
<title>مایکت‌باکس — دانلود APK با مشخصات کامل</title>
<meta name="description" content="دانلود مستقیم APK برنامه‌های رایگان مایکت + مشخصات کامل — موتور هیبرید روی Cloudflare Workers">
<script>try{var t=localStorage.getItem("mk_theme");if(t!=="dark"&&t!=="light"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t;var a=localStorage.getItem("mk_accent");if(/^#[0-9a-fA-F]{6}$/.test(a||""))document.documentElement.style.setProperty("--acc",a)}catch(e){}</script>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='4' y='4' width='56' height='56' rx='14' fill='%2300C781' stroke='%23151610' stroke-width='5'/%3E%3Cpath d='M32 16v20m0 0l-9-9m9 9l9-9' stroke='%23151610' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M20 47h24' stroke='%23151610' stroke-width='6' stroke-linecap='round'/%3E%3C/svg%3E">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css">
<style>
  :root{
    --bg:#F5F1E6; --paper:#FFFDF7; --ink:#151610; --mut:#6F6A5B; --mut2:#98927F; --body:#3A382E;
    --acc:#00C781; --yellow:#FFD23F; --coral:#FF7A66;
    --sky:#9BD6FF; --lilac:#E8C8FF; --pink:#FFC4D6;
    --onbright:#151610;
    --line:rgba(21,22,16,.12); --track:#C9C2AE; --sk:#E7E1CF; --dotc:rgba(21,22,16,.14);
    --codebg:#191A13; --codefg:#9DF0C0; --codedim:#7EA98F;
    --bd:2.5px solid var(--ink); --sh:-5px 5px 0 var(--ink); --sh-sm:-3px 3px 0 var(--ink);
    --r:16px; --r-lg:22px;
  }
  html[data-theme="dark"]{
    --bg:#161712; --paper:#20221A; --ink:#EFECE0; --mut:#AAA494; --mut2:#6E6A5C; --body:#CDC8B6;
    --line:rgba(239,236,224,.14); --track:#3A3B30; --sk:#2A2C22; --dotc:rgba(239,236,224,.10);
  }
  *{box-sizing:border-box;margin:0;padding:0}
  @media (prefers-reduced-motion: reduce){ *{ animation-duration:.01ms !important; transition-duration:.01ms !important } }
  ::selection{ background:var(--yellow); color:#151610 }
  body{
    font-family:Vazirmatn,system-ui,Tahoma,sans-serif; background:var(--bg); color:var(--ink);
    min-height:100vh; display:flex; flex-direction:column; align-items:center;
    background-image:radial-gradient(var(--dotc) 1.2px,transparent 1.2px);
    background-size:26px 26px;
    transition:background-color .3s ease,color .3s ease;
  }
  #bar{ position:fixed; top:0; right:0; left:0; height:4px; z-index:100; background:transparent }
  #bar span{ display:block; height:100%; width:0; background:var(--acc); border-inline-end:2.5px solid var(--ink); transition:width .3s ease }

  .wrap{ width:100%; max-width:680px; padding:22px 16px 80px }
  @keyframes pop{ from{ opacity:0; transform:translateY(14px) scale(.98) } to{ opacity:1; transform:none } }

  /* ---------- تاپ‌بار ---------- */
  .topbar{ display:flex; align-items:center; gap:12px; margin-bottom:30px; animation:pop .45s both }
  .logo{ width:52px;height:52px;border-radius:15px;flex:none;display:grid;place-items:center;
    background:var(--acc); color:var(--onbright); border:var(--bd); box-shadow:var(--sh) }
  .topbar .tt{ font-size:19px; font-weight:900; line-height:1.3 }
  .topbar .ts{ font-size:11px; color:var(--mut); margin-top:2px; font-weight:600 }
  .topbar .side{ margin-inline-start:auto; display:flex; align-items:center; gap:8px }
  .srv{ font-size:11px; font-weight:800; border:var(--bd); border-radius:999px;
    padding:6px 13px; display:flex; align-items:center; gap:7px; background:var(--paper); box-shadow:var(--sh-sm);
    color:var(--mut); transition:all .25s; white-space:nowrap }
  .srv i{ width:8px;height:8px;border-radius:50%;border:2px solid currentColor;background:var(--mut2) }
  .srv.on{ background:var(--acc); color:var(--onbright) }
  .srv.on i{ background:#fff; border-color:var(--onbright); animation:blink 1.6s infinite }
  .srv.off{ background:var(--coral); color:var(--onbright) }
  .srv.off i{ background:#fff; border-color:var(--onbright) }
  @keyframes blink{ 50%{ opacity:.3 } }
  .theme-btn{ width:40px;height:40px;flex:none;border:var(--bd);border-radius:12px;
    background:var(--ink); color:var(--bg); cursor:pointer; display:grid; place-items:center;
    box-shadow:var(--sh-sm); transition:transform .12s, box-shadow .12s, background-color .3s, color .3s }
  .theme-btn:hover{ transform:translate(-1px,1px) rotate(-8deg); box-shadow:-4px 4px 0 var(--ink) }
  .theme-btn:active{ transform:translate(-3px,3px); box-shadow:0 0 0 var(--ink) }

  /* ---------- تم رنگی ---------- */
  .accent-wrap{ position:relative; flex:none }
  .accent-btn{ background:var(--acc); color:var(--onbright); transition:transform .12s, box-shadow .12s, background-color .3s }
  .accent-pop{ position:absolute; top:calc(100% + 10px); inset-inline-end:0; z-index:60; display:none; gap:8px;
    background:var(--paper); border:var(--bd); border-radius:16px; padding:10px; box-shadow:var(--sh) }
  .accent-pop.on{ display:flex; animation:pop .18s both }
  .accent-dot{ width:26px; height:26px; border-radius:50%; border:2.5px solid var(--ink); cursor:pointer; flex:none;
    box-shadow:-2px 2px 0 var(--ink); transition:transform .12s, box-shadow .12s; padding:0 }
  .accent-dot:hover{ transform:translate(-1px,1px) }
  .accent-dot.cur{ box-shadow:inset 0 0 0 3px var(--paper), -2px 2px 0 var(--ink); transform:scale(1.08) }

  /* ---------- هیرو ---------- */
  .hero{ text-align:center; margin-bottom:22px; animation:pop .45s .06s both; position:relative }
  .hero h1{ font-size:clamp(26px,6vw,38px); font-weight:900; line-height:1.45; letter-spacing:-.5px }
  .hero h1 mark{ background:linear-gradient(transparent 62%, var(--acc) 62%, var(--acc) 92%, transparent 92%); color:inherit; padding:0 4px }
  .hero p{ color:var(--mut); font-size:13.5px; line-height:2.1; margin-top:10px; font-weight:600 }
  .hero p b{ color:var(--ink) }

  /* ---------- کارت‌ها ---------- */
  .card{
    background:var(--paper); border:var(--bd); border-radius:var(--r-lg); padding:18px;
    box-shadow:var(--sh); animation:pop .45s both;
    transition:background-color .3s ease,border-color .3s ease;
  }
  .card + .card{ margin-top:16px }

  .search-row{ display:flex; flex-direction:column; gap:10px }
  @media(min-width:560px){ .search-row{ flex-direction:row } }
  .input-wrap{ position:relative; flex:1 }
  .input-wrap .ic{ position:absolute; top:50%; inset-inline-start:14px; transform:translateY(-50%); opacity:.5; pointer-events:none; display:flex }
  input[type=text]{
    width:100%; background:var(--bg); border:var(--bd); border-radius:14px; color:var(--ink);
    padding:14px 42px 14px 14px; font-size:14.5px; font-family:inherit; font-weight:700; outline:none;
    transition:box-shadow .15s, background .15s; direction:ltr; text-align:left;
  }
  input[type=text]:focus{ background:var(--paper); box-shadow:var(--sh-sm) }
  input[type=text]::placeholder{ color:var(--mut2); font-weight:600; direction:rtl; text-align:right }
  .btn{
    border:var(--bd); cursor:pointer; font-family:inherit; font-weight:900; border-radius:14px;
    display:inline-flex; align-items:center; justify-content:center; gap:8px;
    box-shadow:var(--sh-sm); transition:transform .12s, box-shadow .12s, background-color .2s; text-decoration:none; color:var(--ink);
    background:var(--paper); padding:14px 22px; font-size:14.5px; white-space:nowrap;
  }
  .btn:hover{ transform:translate(-1px,1px); box-shadow:-4px 4px 0 var(--ink) }
  .btn:active{ transform:translate(-3px,3px); box-shadow:0 0 0 var(--ink) }
  .btn-primary{ background:var(--acc); color:var(--onbright) }
  .btn-yellow{ background:var(--yellow); color:var(--onbright) }
  .btn[disabled]{ opacity:.45; cursor:not-allowed; transform:none; box-shadow:var(--sh-sm) }
  .btn-sm{ padding:10px 16px; font-size:12.5px; border-radius:12px }
  .spin{ width:16px;height:16px;border-radius:50%;border:3px solid rgba(21,22,16,.25);border-top-color:#151610; animation:rot .65s linear infinite; flex:none }
  @keyframes rot{ to{ transform:rotate(360deg) } }

  .chips{ display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; align-items:center }
  .chips>span.t{ font-size:11px; color:var(--mut); font-weight:800 }
  .chip{
    direction:ltr; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; font-weight:700; cursor:pointer;
    color:var(--ink); background:var(--paper); border:2px solid var(--ink); border-radius:10px; padding:6px 11px;
    transition:all .15s; display:inline-flex; align-items:center; gap:6px; box-shadow:-2px 2px 0 var(--ink);
  }
  .chip:hover{ transform:translate(-1px,1px); box-shadow:-3px 3px 0 var(--ink); background:var(--yellow); color:var(--onbright) }
  .chip.cur{ background:var(--bg); border-style:dashed; box-shadow:none }
  .chip.cur:hover{ background:var(--yellow); border-style:solid }
  .chip img{ width:15px;height:15px;border-radius:4px;border:1.5px solid var(--ink) }
  .chip-clear{ background:none;border:none;color:var(--mut);font-size:10.5px;cursor:pointer;padding:4px 6px;border-radius:7px;font-family:inherit;font-weight:800 }
  .chip-clear:hover{ color:#B3261E; background:rgba(255,122,102,.3) }

  /* ---------- استپر ---------- */
  .stepper{ display:none; margin-top:16px }
  .stepper.on{ display:block; animation:pop .25s both }
  .steps{ display:flex; gap:6px; align-items:center; justify-content:space-between }
  .st{ display:flex; align-items:center; gap:7px; font-size:11px; font-weight:800; color:var(--mut2); transition:color .25s; flex:none }
  .st .dot{ width:24px;height:24px;border-radius:50%; border:2.5px solid var(--ink); background:var(--bg); color:var(--mut2);
    display:grid;place-items:center; font-size:11px; font-weight:900; transition:all .25s }
  .st.on{ color:var(--ink) } .st.on .dot{ background:var(--yellow); color:var(--onbright) }
  .st.done{ color:var(--mut) } .st.done .dot{ background:var(--acc); color:var(--onbright) }
  .st-line{ flex:1; height:0; border-top:2.5px dashed var(--track); min-width:10px; transition:border-color .25s }

  /* ---------- اسکلت ---------- */
  .sk{ border:2px solid var(--ink); border-radius:12px; background:var(--sk); animation:pulseSk 1.1s ease-in-out infinite }
  @keyframes pulseSk{ 50%{ opacity:.45 } }

  /* ---------- نتیجه ---------- */
  #out{ margin-top:18px }
  .blk-t{ font-size:13px; font-weight:900; margin-bottom:15px; display:flex; align-items:center; gap:9px }
  .blk-t::before{ content:""; width:16px; height:16px; border-radius:5px; background:var(--acc); border:2.5px solid var(--ink); flex:none }
  .blk-t small{ color:var(--mut); font-weight:600 }

  .p-head{ display:flex; gap:15px; align-items:flex-start }
  .p-icon{ width:88px;height:88px;border-radius:20px;flex:none;object-fit:cover;background:var(--paper);
    border:var(--bd); box-shadow:var(--sh-sm) }
  .p-icon.ph{ display:grid;place-items:center;color:var(--onbright);background:var(--lilac) }
  .p-main{ min-width:0; flex:1; padding-top:2px }
  .p-title{ font-size:19px; font-weight:900; line-height:1.55; display:flex; align-items:center; gap:8px; flex-wrap:wrap }
  .vbadge{ font-size:10.5px; font-weight:900; background:var(--yellow); color:var(--onbright); border:2px solid var(--ink); border-radius:8px; padding:2px 8px; direction:ltr }
  .src-chip{ font-size:10px; font-weight:900; border:2px solid var(--ink); border-radius:8px; padding:2.5px 9px; display:inline-flex; align-items:center; gap:5px; color:var(--onbright) }
  .src-chip.api{ background:var(--acc) }
  .src-chip.web{ background:var(--sky) }
  .p-tag{ color:var(--mut); font-size:12.5px; margin-top:4px; line-height:1.9; font-weight:600 }
  .p-pkg{ direction:ltr; display:inline-block; margin-top:8px; font-family:ui-monospace,Menlo,Consolas,monospace;
    font-size:10.5px; font-weight:700; color:var(--ink); background:var(--bg); border:2px solid var(--ink); border-radius:8px; padding:4px 9px }
  .p-links{ margin-top:10px; display:flex; flex-wrap:wrap; gap:6px }
  .p-links a{ font-size:11.5px; font-weight:800; color:var(--ink); background:var(--paper); border:2px solid var(--ink);
    border-radius:9px; padding:4px 10px; text-decoration:none; transition:all .15s; display:inline-flex; align-items:center; gap:5px }
  .p-links a:hover{ background:var(--lilac); color:var(--onbright); transform:translate(-1px,1px) }
  .rate-side{ flex:none; display:flex; flex-direction:column; align-items:center; gap:4px;
    background:var(--yellow); color:var(--onbright); border:var(--bd); border-radius:16px; padding:11px 15px; box-shadow:var(--sh-sm) }
  .rate-num{ font-size:22px; font-weight:900; line-height:1; font-variant-numeric:tabular-nums }
  .stars{ position:relative; direction:ltr; display:inline-block; font-size:14px; line-height:1; letter-spacing:2px }
  .stars .s-bg{ color:rgba(21,22,16,.22) } .stars .s-fg{ position:absolute; inset:0 auto 0 0; overflow:hidden; color:#151610; white-space:nowrap }
  .rate-cnt{ font-size:9.5px; font-weight:800; color:rgba(21,22,16,.7) }

  .p-actions{ display:flex; gap:10px; flex-wrap:wrap; margin-top:18px }
  .btn-dl{ flex:1; min-width:190px; flex-direction:column; gap:3px; padding:13px 18px }
  .btn-dl small{ font-weight:700; font-size:11px; opacity:.75 }
  .note{ font-size:11.5px; color:var(--mut); margin-top:12px; line-height:2; font-weight:600 }
  .note b{ color:var(--ink) }

  .dl-err{ flex:1; min-width:190px; border-radius:14px; border:var(--bd); background:var(--yellow); color:var(--onbright); font-size:12.5px;
    font-weight:800; padding:13px 16px; line-height:1.95; display:flex; align-items:center; gap:9px; box-shadow:var(--sh-sm) }
  .dl-err a{ color:inherit }

  /* ---------- آمار ---------- */
  .stats{ display:grid; grid-template-columns:repeat(auto-fit,minmax(135px,1fr)); gap:10px }
  .stat{ border:var(--bd); border-radius:14px; padding:12px 13px; color:var(--onbright); transition:transform .15s }
  .stat:hover{ transform:translate(-2px,2px) }
  .stat:nth-child(4n+1){ background:var(--acc) } .stat:nth-child(4n+2){ background:var(--yellow) }
  .stat:nth-child(4n+3){ background:var(--sky) } .stat:nth-child(4n+4){ background:var(--pink) }
  .stat .k{ display:flex; align-items:center; gap:6px; font-size:10.5px; font-weight:800; color:rgba(21,22,16,.72); margin-bottom:6px }
  .stat .v{ font-size:15px; font-weight:900 }
  .stat .s{ font-size:9.5px; font-weight:700; color:rgba(21,22,16,.6); margin-top:2px }

  /* ---------- تب‌ها ---------- */
  .tabs{ display:flex; gap:6px; background:var(--bg); border:var(--bd); border-radius:15px; padding:5px; margin-bottom:16px }
  .tab{ flex:1; border:2.5px solid transparent; background:none; color:var(--mut); font-family:inherit; font-size:12px; font-weight:900;
    padding:8px 6px; border-radius:10px; cursor:pointer; transition:all .15s }
  .tab:hover{ color:var(--ink) }
  .tab.on{ background:var(--ink); color:var(--bg) }
  .pane{ display:none; animation:pop .3s both } .pane.on{ display:block }

  .desc p{ font-size:13px; color:var(--body); line-height:2.25; font-weight:600 }
  .cl{ list-style:none; margin-top:4px; display:flex; flex-direction:column; gap:9px }
  .cl li{ position:relative; padding-inline-start:22px; font-size:12.5px; color:var(--body); line-height:1.95; font-weight:700 }
  .cl li::before{ content:""; position:absolute; inset-inline-start:0; top:.6em; width:11px; height:11px; border-radius:50%;
    background:var(--acc); border:2.5px solid var(--ink) }
  .divider{ height:0; border-top:2.5px dashed var(--track); margin:17px 0 15px }

  .shots{ display:flex; gap:12px; overflow-x:auto; padding:4px 2px 14px; direction:ltr;
    scroll-snap-type:x mandatory; scrollbar-width:none; cursor:grab }
  .shots.grabbing{ cursor:grabbing; scroll-snap-type:none }
  .shots::-webkit-scrollbar{ display:none }
  .shots img{ height:270px; border-radius:16px; border:var(--bd); box-shadow:-4px 4px 0 var(--ink); scroll-snap-align:center;
    background:var(--paper); flex:none; transition:transform .2s; user-select:none }
  .shots img:hover{ transform:scale(1.02) rotate(-.5deg) }

  /* ---------- باکس مشخصات (بازطراحی‌شده) ---------- */
  .spec-wrap{ border:var(--bd); border-radius:14px; overflow:hidden; box-shadow:var(--sh-sm); overflow-x:auto }
  .spec-table{ width:100%; border-collapse:collapse; font-size:12.5px }
  .spec-table td{ padding:11px 14px; border-bottom:2px solid var(--line); vertical-align:middle; background:var(--paper); transition:background-color .2s }
  .spec-table tr:nth-child(even) td{ background:var(--bg) }
  .spec-table tr:last-child td{ border-bottom:0 }
  .spec-table tr:hover td{ background:var(--line) }
  .spec-table .l{ color:var(--mut); width:128px; min-width:110px; white-space:nowrap; font-weight:900; border-inline-end:2px solid var(--line) }
  .spec-table .v{ color:var(--ink); font-weight:700; line-height:1.9 }
  .spec-table .v.mono{ direction:ltr; text-align:left; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11.5px }

  /* میله‌های توزیع امتیاز */
  .bar-row{ display:flex; align-items:center; gap:10px; margin-bottom:9px }
  .bar-row:last-child{ margin-bottom:0 }
  .bar-l{ width:24px; font-weight:900; text-align:center; flex:none; font-size:12px }
  .bar-track{ flex:1; height:14px; border:2px solid var(--ink); border-radius:8px; overflow:hidden; background:var(--bg) }
  .bar-fill{ display:block; height:100%; background:var(--acc); border-inline-end:2px solid var(--ink); transition:width .6s cubic-bezier(.2,.8,.2,1) }
  .bar-row:nth-child(2) .bar-fill{ background:var(--sky) }
  .bar-p{ width:48px; text-align:left; font-size:11px; font-weight:800; direction:ltr; flex:none; color:var(--mut); font-variant-numeric:tabular-nums }

  /* چیپ برنامه‌های مشابه */
  .chip.rel{ direction:rtl; font-family:inherit; font-size:12px; font-weight:800; padding:6px 12px 6px 9px }

  pre.rawj, .console{ direction:ltr; text-align:left; background:var(--codebg); color:var(--codefg); border:var(--bd);
    border-radius:15px; padding:15px; box-shadow:var(--sh-sm);
    font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; line-height:1.9 }
  pre.rawj{ max-height:320px; overflow:auto }

  /* ---------- لایت‌باکس ---------- */
  .lb{ position:fixed; inset:0; z-index:200; background:rgba(21,22,16,.85); display:none; align-items:center; justify-content:center; padding:24px }
  .lb.on{ display:flex; animation:pop .2s both }
  .lb img{ max-width:100%; max-height:100%; border-radius:18px; border:3px solid #FFFDF7; box-shadow:-8px 8px 0 rgba(255,253,247,.25) }
  .lb .x{ position:absolute; top:20px; inset-inline-end:22px; width:44px;height:44px; border-radius:50%;
    border:2.5px solid #151610; background:var(--yellow); color:#151610; font-size:22px; font-weight:900; cursor:pointer; display:grid; place-items:center; box-shadow:-3px 3px 0 #151610 }

  /* ---------- توست ---------- */
  #toasts{ position:fixed; top:16px; right:50%; transform:translateX(50%); z-index:300; display:flex; flex-direction:column; gap:8px; pointer-events:none }
  .toast{ background:var(--paper); border:var(--bd); color:var(--ink); font-size:12.5px; font-weight:800;
    border-radius:13px; padding:11px 17px; box-shadow:var(--sh-sm); animation:pop .25s both; display:flex; align-items:center; gap:9px; transition:opacity .35s }
  .toast i{ width:10px;height:10px;border-radius:50%;border:2px solid var(--ink);flex:none }
  .toast.ok i{ background:var(--acc) } .toast.err i{ background:var(--coral) }

  /* ---------- پیام‌ها ---------- */
  .alert{ border-radius:18px; padding:17px; font-size:13.5px; line-height:2.05; border:var(--bd); font-weight:700; animation:pop .35s both; box-shadow:var(--sh); color:var(--onbright) }
  .alert.err{ background:var(--coral) }
  .alert.warn{ background:var(--yellow) }
  .alert .t{ font-weight:900; display:flex; align-items:center; gap:8px; margin-bottom:4px }
  .alert a{ color:inherit; text-decoration:underline; font-weight:900 }
  .alert .btn{ margin-top:11px }

  /* ---------- حالت خالی ---------- */
  .empty{ text-align:center; padding:30px 18px 28px; color:var(--mut); animation:pop .5s .2s both }
  .empty .art{ margin:0 auto 15px; width:92px; height:92px; border-radius:24px; display:grid; place-items:center;
    background:var(--lilac); border:var(--bd); box-shadow:var(--sh); color:var(--onbright); transform:rotate(-4deg) }
  .empty p{ font-size:12.5px; line-height:2.2; font-weight:700 }

  /* ---------- دیباگ ---------- */
  #debug{ margin-top:16px; display:none }
  #debug.on{ display:block; animation:pop .3s both }
  .dbg-row{ display:flex; align-items:center; gap:10px; padding:10px 12px; border-bottom:2px dashed var(--line); font-size:12px }
  .dbg-row:last-child{ border-bottom:0 }
  .dbg-dot{ width:12px;height:12px;border-radius:50%;flex:none;border:2.5px solid var(--ink) }
  .dbg-dot.ok{ background:var(--acc) } .dbg-dot.no{ background:var(--coral) } .dbg-dot.mid{ background:var(--yellow) }
  .dbg-name{ color:var(--ink); font-weight:900; min-width:92px; flex:none }
  .dbg-info{ color:var(--mut); font-size:10.5px; direction:ltr; text-align:left; font-family:ui-monospace,monospace; word-break:break-all; font-weight:600 }

  footer{ margin-top:42px; color:var(--mut); font-size:11.5px; line-height:2.3; font-weight:700; animation:pop .5s .3s both }
  .lab-out{ direction:ltr; text-align:left; margin-top:14px; background:var(--codebg); color:var(--codefg);
    border:var(--bd); border-radius:13px; padding:11px 14px; box-shadow:var(--sh-sm);
    font-family:ui-monospace,Menlo,Consolas,monospace; font-size:11px; line-height:2; word-break:break-all; animation:pop .25s both }
  .lab-out .dim{ color:var(--codedim) }
  footer code{ direction:ltr; display:inline-block; background:var(--paper); border:2px solid var(--ink); border-radius:8px; padding:2px 9px; font-size:10.5px; color:var(--ink); font-weight:800 }
  footer a{ color:var(--ink); text-decoration:none; border-bottom:2px solid var(--acc); font-weight:900 }
  .foot-note{ margin-top:12px; font-size:10.5px; color:var(--mut); font-weight:700 }
  .foot-note b{ direction:ltr; display:inline-block; color:var(--ink) }
  .fbtns{ display:flex; gap:8px; justify-content:flex-start; flex-wrap:wrap }
  .fbtn{ font-size:11px; font-weight:900; color:var(--ink); background:var(--paper); border:2.5px solid var(--ink); border-radius:11px;
    padding:8px 14px; cursor:pointer; font-family:inherit; transition:all .15s; display:inline-flex; align-items:center; gap:6px; box-shadow:-2px 2px 0 var(--ink) }
  .fbtn:hover{ background:var(--yellow); color:var(--onbright); transform:translate(-1px,1px); box-shadow:-3px 3px 0 var(--ink) }

  @media(max-width:480px){
    .p-head{ flex-wrap:wrap }
    .rate-side{ flex-direction:row; width:100%; justify-content:flex-start; gap:12px }
    .shots img{ height:220px }
    .st span{ display:none } .st.on span{ display:inline }
  }
</style>
</head>
<body>
<div id="bar"><span></span></div>
<div class="wrap">
  <div class="topbar">
    <div class="logo">
      <svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/><path d="m7.5 10 4.5 4.5L16.5 10"/><path d="M5 20.5h14"/></svg>
    </div>
    <div>
      <div class="tt">مایکت‌باکس</div>
      <div class="ts">Cloudflare Worker · v${WORKER_VERSION}</div>
    </div>
    <div class="side">
      <span class="srv" id="srv"><i></i>بررسی…</span>
      <div class="accent-wrap">
        <button class="theme-btn accent-btn" id="accent-btn" type="button" title="تم رنگی" aria-label="انتخاب رنگ اصلی">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.6 6 11a6 6 0 1 1-12 0c0-4.4 6-11 6-11z"/></svg>
        </button>
        <div class="accent-pop" id="accent-pop">
          <button type="button" class="accent-dot" data-c="#00C781" style="background:#00C781" title="سبز مایکت" aria-label="سبز مایکت"></button>
          <button type="button" class="accent-dot" data-c="#B18CFF" style="background:#B18CFF" title="بنفش" aria-label="بنفش"></button>
          <button type="button" class="accent-dot" data-c="#FF9F43" style="background:#FF9F43" title="نارنجی" aria-label="نارنجی"></button>
          <button type="button" class="accent-dot" data-c="#3FA7FF" style="background:#3FA7FF" title="آبی" aria-label="آبی"></button>
          <button type="button" class="accent-dot" data-c="#FF6FA5" style="background:#FF6FA5" title="صورتی" aria-label="صورتی"></button>
        </div>
      </div>
      <button class="theme-btn" id="theme-btn" type="button" title="حالت شب / روز" aria-label="تغییر حالت شب و روز"></button>
    </div>
  </div>

  <div class="hero">
    <h1>APK مایکت، <mark>مستقیم و کامل</mark></h1>
    <p>نام بسته یا لینک برنامه را بنویس — <b>مشخصات کامل + لینک واقعی APK</b><br>با مشخص ساختن منبع لینک، بدون فایل جعلی.</p>
  </div>

  <div class="card">
    <form class="search-row" id="f">
      <div class="input-wrap">
        <span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></span>
        <input type="text" id="q" autocomplete="off" spellcheck="false" autofocus
          placeholder="com.digikala یا لینک مایکت">
      </div>
      <button class="btn btn-primary" id="go" type="submit">
        <svg id="ic-go" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/><path d="m7.5 10 4.5 4.5L16.5 10"/><path d="M5 20.5h14"/></svg>
        <span id="go-t">بگیر!</span>
      </button>
    </form>

    <div class="chips">
      <span class="t">نمونه:</span>
      <button type="button" class="chip" data-p="com.digikala">com.digikala</button>
      <button type="button" class="chip" data-p="cab.snapp.passenger">cab.snapp.passenger</button>
      <button type="button" class="chip" data-p="org.telegram.messenger">org.telegram.messenger</button>
      <button type="button" class="chip" data-p="com.zoodfood.android">com.zoodfood.android</button>
    </div>
    <div class="chips" id="recent-wrap" style="display:none">
      <span class="t">اخیراً:</span><span id="recent" style="display:contents"></span>
      <button type="button" class="chip-clear" id="recent-clear">پاک‌کردن</button>
    </div>

    <div class="stepper" id="stepper">
      <div class="steps">
        <span class="st" data-s="0"><i class="dot">۱</i><span>اتصال</span></span><i class="st-line"></i>
        <span class="st" data-s="1"><i class="dot">۲</i><span>مشخصات</span></span><i class="st-line"></i>
        <span class="st" data-s="2"><i class="dot">۳</i><span>لینک</span></span><i class="st-line"></i>
        <span class="st" data-s="3"><i class="dot">۴</i><span>آماده</span></span>
      </div>
    </div>
  </div>

  <div id="out">
    <div class="empty">
      <div class="art">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2.5" width="16" height="19" rx="3.5"/><circle cx="12" cy="10.5" r="3.5"/><path d="M9.5 17.5h5"/></svg>
      </div>
      <p>صندوق برنامه‌های مایکت —<br>همه‌چیز درباره‌ی هر اپ + لینک APK واقعی.</p>
    </div>
  </div>

  <div id="debug" class="card"></div>

  <footer>
    <div class="card" style="text-align:start">
      <div class="blk-t">کنسول API <small>تست زنده‌ی اندپوینت‌ها از همین صفحه</small></div>
      <div class="fbtns">
        <button class="fbtn" id="lab-resolve" type="button">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z"/></svg>
          ‌/api/resolve
        </button>
        <button class="fbtn" id="lab-download" type="button">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7.5 11 4.5 4.5L16.5 11"/><path d="M5 21h14"/></svg>
          ‌/api/download
        </button>
        <button class="fbtn" id="lab-health" type="button">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-6 4 12L16 12h5"/></svg>
          ‌/api/healthz
        </button>
        <button class="fbtn" id="dbg-btn" type="button">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20v-6M12 4v2"/><circle cx="12" cy="12" r="3"/><path d="M5 12H3m18 0h-2M6.3 6.3 4.9 4.9m14.2 1.4-1.4 1.4m0 11.4 1.4 1.4M4.9 19.1l1.4-1.4"/></svg>
          ‌/api/debug
        </button>
        <button class="fbtn" id="share-btn" type="button">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a5 5 0 0 0 7.5 4.9l1.5-1.5a5 5 0 0 0 0-7.1z"/><path d="M14 10a5 5 0 0 0-7.5-4.9L5 6.6a5 5 0 0 0 0 7.1z"/></svg>
          کپی لینک این صفحه
        </button>
      </div>
      <div id="lab-out" class="lab-out" style="display:none"></div>
      <div class="foot-note">
        نسخه‌ی ورکر: <b>v${WORKER_VERSION}</b> · هر نتیجه با کلیک روی نام بسته قابل اشتراک‌گذاری است (<span dir="ltr">?p=</span>)
      </div>
    </div>
  </footer>
</div>

<div class="lb" id="lb"><button class="x" type="button" id="lb-x">×</button><img id="lb-img" alt="" referrerpolicy="no-referrer"></div>
<div id="toasts"></div>

<script>
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var form = $('#f'), input = $('#q'), out = $('#out'), dbgBox = $('#debug');
  var go = $('#go'), goT = $('#go-t'), icGo = $('#ic-go'), barSpan = $('#bar span');
  var stepTimer = null, currentPkg = '';
  var FAD = '۰۱۲۳۴۵۶۷۸۹';
  var STEP_LABELS = ['اتصال', 'مشخصات', 'لینک', 'آماده'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fa(s) { return String(s == null ? '' : s).replace(/[0-9]/g, function (d) { return FAD[+d]; }); }
  function faNum(n) {
    try { return new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 }).format(n); }
    catch (e) { return fa(n); }
  }
  function icon(name, size) {
    var s = size || 14;
    var p = {
      dl: '<path d="M12 3v12"/><path d="m7.5 11 4.5 4.5L16.5 11"/><path d="M5 21h14"/>',
      chat: '<path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z"/>',
      box: '<path d="M21 8.5 12 3 3 8.5v7L12 21l9-5.5v-7z"/><path d="M3.5 9 12 14l8.5-5"/><path d="M12 14v7"/>',
      cal: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/>',
      tag: '<path d="m3 3 9 1 9 9-9 9-9-9z"/><circle cx="8" cy="8" r="1.4"/>',
      user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-5.5 8-5.5s6.5 1.5 8 5.5"/>',
      mob: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
      hist: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
      copy: '<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H15"/>',
      ext: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 14v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
      warn: '<path d="M12 3 2.5 20h19z"/><path d="M12 9.5V14"/><circle cx="12" cy="17" r=".4"/>',
      err: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v6"/><circle cx="12" cy="16.5" r=".4"/>',
      bolt: '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z"/>',
      web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 2.6 4 5.6 4 9s-1.2 6.4-4 9c-2.8-2.6-4-5.6-4-9s1.2-6.4 4-9z"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
      moon: '<path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5z"/>'
    }[name] || '';
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  }
  function starBar(value, best) {
    var pct = Math.max(0, Math.min(100, (Number(value) / (best || 5)) * 100));
    return '<span class="stars"><span class="s-bg">★★★★★</span><span class="s-fg" style="width:' + pct + '%">★★★★★</span></span>';
  }
  function phIcon(cls) { return '<div class="' + cls + ' ph">' + icon('box', 32) + '</div>'; }
  function toast(msg, type) {
    var t = document.createElement('div');
    t.className = 'toast ' + (type || 'ok');
    t.innerHTML = '<i></i>' + esc(msg);
    $('#toasts').appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; }, 2300);
    setTimeout(function () { t.remove(); }, 2750);
  }
  function setProgress(p) { barSpan.style.width = Math.max(0, Math.min(100, p)) + '%'; }
  function isoDate(iso) {
    try {
      var dt = new Date(iso);
      return fa(dt.getFullYear()) + '/' + fa(('0' + (dt.getMonth() + 1)).slice(-2)) + '/' + fa(('0' + dt.getDate()).slice(-2));
    } catch (e) { return String(iso); }
  }
  function countUp(el, target, dur, fmt) {
    var t0 = null;
    function tick(ts) {
      if (!t0) t0 = ts;
      var k = Math.min(1, (ts - t0) / (dur || 850));
      var e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(target * e);
      if (k < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* دارک‌مود — دکمه‌ی تغییر حالت شب/روز */
  var themeBtn = $('#theme-btn');
  function syncThemeIcon() {
    themeBtn.innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 18);
    themeBtn.title = document.documentElement.dataset.theme === 'dark' ? 'حالت روز' : 'حالت شب';
  }
  themeBtn.addEventListener('click', function () {
    var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('mk_theme', next); } catch (e) {}
    syncThemeIcon();
    toast(next === 'dark' ? 'حالت شب فعال شد' : 'حالت روز فعال شد', 'ok');
  });
  syncThemeIcon();

  /* تم رنگی — انتخاب رنگ اصلی */
  var accentBtn = $('#accent-btn'), accentPop = $('#accent-pop');
  var accentDots = accentPop.querySelectorAll('.accent-dot');
  function currentAccent() {
    return (document.documentElement.style.getPropertyValue('--acc') || '#00C781').trim().toLowerCase();
  }
  function syncAccentDots() {
    var cur = currentAccent();
    for (var i = 0; i < accentDots.length; i++) {
      var on = (accentDots[i].getAttribute('data-c') || '').toLowerCase() === cur;
      accentDots[i].className = 'accent-dot' + (on ? ' cur' : '');
    }
  }
  function setAccent(c) {
    document.documentElement.style.setProperty('--acc', c);
    try { localStorage.setItem('mk_accent', c); } catch (e) {}
    syncAccentDots();
    toast('تم رنگی تغییر کرد', 'ok');
  }
  accentBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    accentPop.className = accentPop.className.indexOf('on') === -1 ? 'accent-pop on' : 'accent-pop';
  });
  accentPop.addEventListener('click', function (e) {
    e.stopPropagation();
    var d = e.target.closest ? e.target.closest('.accent-dot') : null;
    if (d && d.getAttribute('data-c')) {
      setAccent(d.getAttribute('data-c'));
      accentPop.className = 'accent-pop';
    }
  });
  document.addEventListener('click', function () {
    if (accentPop.className.indexOf('on') !== -1) accentPop.className = 'accent-pop';
  });
  syncAccentDots();

  /* وضعیت سرویس */
  (function ping() {
    var chip = $('#srv');
    try {
    fetch('/healthz')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function () { chip.className = 'srv on'; chip.innerHTML = '<i></i>آنلاین'; })
      .catch(function () { chip.className = 'srv off'; chip.innerHTML = '<i></i>قطع'; });
    } catch (e) {
      chip.className = 'srv off';
      chip.innerHTML = '<i></i>قطع';
    }
  })();

  /* استپر */
  function stepperShow(idx) {
    var box = $('#stepper');
    box.className = 'stepper on';
    var nodes = box.querySelectorAll('.st'), lines = box.querySelectorAll('.st-line');
    for (var i = 0; i < nodes.length; i++) nodes[i].className = 'st' + (i < idx ? ' done' : i === idx ? ' on' : '');
    for (var j = 0; j < lines.length; j++) lines[j].style.borderColor = j < idx ? 'var(--ink)' : 'var(--track)';
  }
  function stepperHide() { $('#stepper').className = 'stepper'; clearInterval(stepTimer); }

  /* جستجوهای اخیر */
  var RK = 'mk_recent_v2';
  function getRecent() { try { return JSON.parse(localStorage.getItem(RK) || '[]'); } catch (e) { return []; } }
  function setRecentUp(list) { try { localStorage.setItem(RK, JSON.stringify(list)); } catch (e) {} }
  function pushRecent(pkg, title, iconUrl) {
    var list = getRecent().filter(function (r) { return r.p !== pkg; });
    list.unshift({ p: pkg, t: title || '', i: iconUrl || '' });
    setRecentUp(list.slice(0, 6));
    renderRecent();
  }
  function renderRecent() {
    var list = getRecent();
    var wrap = $('#recent-wrap');
    if (!list.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';
    $('#recent').innerHTML = list.map(function (r) {
      var im = r.i ? '<img src="' + esc(r.i) + '" alt="" referrerpolicy="no-referrer" onerror="this.remove()">' : icon('hist', 12);
      return '<button type="button" class="chip cur" data-p="' + esc(r.p) + '" title="' + esc(r.t || r.p) + '">' + im + esc(r.p) + '</button>';
    }).join('');
  }
  $('#recent-clear').addEventListener('click', function () { setRecentUp([]); renderRecent(); });
  renderRecent();

  /* لودینگ */
  function setLoading(on) {
    go.disabled = !!on;
    goT.textContent = on ? 'صبر کن…' : 'بگیر!';
    icGo.outerHTML = on
      ? '<span class="spin" id="ic-go"></span>'
      : '<svg id="ic-go" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/><path d="m7.5 10 4.5 4.5L16.5 10"/><path d="M5 20.5h14"/></svg>';
    icGo = $('#ic-go');
    clearInterval(stepTimer);
    if (on) {
      var i = 0;
      stepperShow(0); setProgress(15);
      stepTimer = setInterval(function () {
        i = Math.min(i + 1, STEP_LABELS.length - 1);
        stepperShow(i); setProgress(18 + (i + 1) * 20);
      }, 720);
      out.innerHTML =
        '<div class="card"><div style="display:flex;gap:15px">' +
        '<div class="sk" style="width:88px;height:88px;border-radius:20px"></div>' +
        '<div style="flex:1;display:flex;flex-direction:column;gap:11px;padding-top:6px">' +
        '<div class="sk" style="height:20px;width:52%"></div><div class="sk" style="height:12px;width:78%"></div><div class="sk" style="height:12px;width:36%"></div></div></div></div>' +
        '<div class="card"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:10px">' +
        '<div class="sk" style="height:64px"></div><div class="sk" style="height:64px"></div><div class="sk" style="height:64px"></div><div class="sk" style="height:64px"></div></div></div>' +
        '<div class="card"><div class="sk" style="height:40px;margin-bottom:14px"></div><div class="sk" style="height:150px"></div></div>';
    } else {
      stepperHide(); setProgress(100);
      setTimeout(function () { setProgress(0); }, 450);
    }
  }

  /* رندرها */
  function renderError(msg, q) {
    out.innerHTML =
      '<div class="alert err"><span class="t">' + icon('err', 17) + 'خطا</span>' + esc(msg) +
      '<br><button class="btn btn-sm" type="button" id="retry">تلاش دوباره</button>' +
      '<button class="btn btn-sm btn-yellow" type="button" id="dbg-run" style="margin-inline-start:8px">عیب‌یابی</button></div>';
    $('#retry').addEventListener('click', function () { run(q || input.value.trim()); });
    var d = $('#dbg-run');
    if (d) d.addEventListener('click', function () { runDebug(q || currentPkg || 'com.digikala'); });
  }
  function renderPaid(d) {
    out.innerHTML =
      '<div class="alert warn"><span class="t">' + icon('warn', 17) + 'برنامه‌ی پولی</span>' +
      esc(d.message || 'دانلود فقط برای برنامه‌های رایگان ممکن است.') +
      '<br><a href="' + esc(d.pageUrl) + '" target="_blank" rel="noopener">مشاهده در مایکت ←</a></div>';
  }
  function stat(k, v, sub, ic) {
    if (!v) return '';
    return '<div class="stat"><div class="k">' + icon(ic, 13) + esc(k) + '</div><div class="v">' + esc(v) + '</div>' +
      (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function renderOk(d) {
    var H = '';
    H += '<div class="card">';
    H += '<div class="p-head">';
    H += d.icon
      ? '<img class="p-icon" src="' + esc(d.icon) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML=window.__ph(this)">'
      : phIcon('p-icon');
    H += '<div class="p-main">';
    H += '<div class="p-title">' + esc(d.title);
    if (d.versionText) H += '<span class="vbadge">' + esc(fa(d.versionText)) + '</span>';
    if (d.engine === 'api') H += '<span class="src-chip api">' + icon('bolt', 11) + 'API رسمی</span>';
    else if (d.engine === 'web') H += '<span class="src-chip web">' + icon('web', 11) + 'موتور وب</span>';
    H += '</div>';
    if (d.tagline) H += '<div class="p-tag">' + esc(d.tagline) + '</div>';
    H += '<span class="p-pkg">' + esc(d.packageName) + '</span>';
    H += '<div class="p-links">';
    if (d.developer && d.developer.name) H += '<a href="' + esc(d.developer.url || d.pageUrl) + '" target="_blank" rel="noopener">' + icon('user', 12) + esc(d.developer.name) + '</a>';
    if (d.category && d.category.name) H += '<a href="' + esc(d.category.url || d.pageUrl) + '" target="_blank" rel="noopener">' + icon('tag', 12) + esc(d.category.name) + '</a>';
    if (d.appType) H += '<a href="' + esc(d.pageUrl) + '" target="_blank" rel="noopener">' + icon('mob', 12) + esc(d.appType) + '</a>';
    H += '</div></div>';
    if (d.rating && d.rating.value) {
      H += '<div class="rate-side">';
      H += '<span class="rate-num" id="rn">' + fa(0) + '</span>';
      H += starBar(d.rating.value, d.rating.best);
      var rc = d.ratingCountText || (d.rating.count ? faNum(d.rating.count) : null);
      H += '<span class="rate-cnt">' + esc(rc ? fa(rc) + ' نظر' : '') + '</span>';
      H += '</div>';
    }
    H += '</div>';

    H += '<div class="p-actions">';
    if (d.directUrl) {
      H += '<a class="btn btn-primary btn-dl" href="' + esc(d.proxyUrl) + '">' + icon('dl', 17) +
        'دانلود مستقیم APK' + (d.sizeText ? '<small>حجم: ' + esc(d.sizeText) + '</small>' : '') + '</a>';
      H += '<button class="btn" type="button" id="copy">' + icon('copy', 15) + 'کپی لینک</button>';
    } else {
      H += '<div class="dl-err">' + icon('warn', 15) + '<span>' + esc(d.downloadError || 'لینک دانلود در دسترس نیست.') +
        ' <a href="javascript:void 0" id="dbg-run2">(عیب‌یابی)</a></span></div>';
    }
    H += '<a class="btn" href="' + esc(d.pageUrl) + '" target="_blank" rel="noopener">' + icon('ext', 15) + 'مایکت</a>';
    H += '</div>';
    H += '<p class="note">' + (d.directUrl
      ? 'فایل با نام <b>' + esc(d.fileName || (d.packageName + '.apk')) + '</b> ذخیره می‌شود — لینک واقعی APK، نه اپلیکیشن مایکت.'
      : 'مشخصات خوانده شد اما لینک دانلود ساخته نشد — دوباره تلاش کن یا از صفحه‌ی مایکت بگیر.') + '</p>';
    H += '</div>';

    var statsHtml =
      stat('تعداد دانلود', d.installsText, null, 'dl') +
      stat('حجم', d.sizeText, null, 'box') +
      stat('نظرات', d.ratingCountText, null, 'chat') +
      stat('آخرین بروزرسانی', d.lastUpdateText, d.dateModified ? isoDate(d.dateModified) : null, 'cal') +
      stat('نسخه', d.versionText ? fa(d.versionText) : null, d.versionCode ? 'کد نسخه: ' + fa(d.versionCode) : null, 'tag') +
      stat('دسته‌بندی', d.category && d.category.name, d.appType, 'mob');
    if (statsHtml) H += '<div class="card" style="animation-delay:.06s"><div class="blk-t">آمار برنامه</div><div class="stats">' + statsHtml + '</div></div>';

    /* ---- میله‌های توزیع امتیاز ---- */
    if (d.ratingBars) {
      var starsLbl = { 5: '۵', 4: '۴', 3: '۳', 2: '۲', 1: '۱' };
      H += '<div class="card" style="animation-delay:.09s"><div class="blk-t">توزیع امتیاز کاربران</div>';
      [5, 4, 3, 2, 1].forEach(function (st) {
        var pct = d.ratingBars[st] || 0;
        H += '<div class="bar-row"><span class="bar-l">' + starsLbl[st] + '★</span>' +
          '<span class="bar-track"><span class="bar-fill" data-w="' + pct + '" style="width:0%"></span></span>' +
          '<span class="bar-p">' + esc(fa(pct)) + '٪</span></div>';
      });
      H += '</div>';
    }

    /* ---- برنامه‌های مشابه ---- */
    if (d.related && d.related.length) {
      H += '<div class="card" style="animation-delay:.1s"><div class="blk-t">شاید بپسندی <small>برنامه‌های مشابه</small></div>' +
        '<div class="chips" style="margin-top:0">';
      for (var rl = 0; rl < d.related.length; rl++) {
        var r2 = d.related[rl];
        H += '<button type="button" class="chip rel" data-p="' + esc(r2.pkg) + '">' +
          (r2.icon ? '<img src="' + esc(r2.icon) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : '') +
          esc(r2.title) + '</button>';
      }
      H += '</div></div>';
    }

    var hasDesc = d.description, hasCl = d.changelog && d.changelog.length, hasShots = d.screenshots && d.screenshots.length, hasSpecs = d.specs && d.specs.length;
    if (hasDesc || hasCl || hasShots || hasSpecs) {
      H += '<div class="card" style="animation-delay:.12s">';
      H += '<div class="tabs" id="tabs">';
      H += '<button type="button" class="tab on" data-tab="ov">نمای کلی</button>';
      if (hasShots) H += '<button type="button" class="tab" data-tab="shots">گالری (' + fa(d.screenshots.length) + ')</button>';
      if (hasSpecs) H += '<button type="button" class="tab" data-tab="spec">مشخصات</button>';
      H += '<button type="button" class="tab" data-tab="raw">JSON</button>';
      H += '</div>';

      H += '<div class="pane on" data-pane="ov">';
      if (hasDesc) H += '<div class="blk-t">درباره‌ی برنامه</div><div class="desc"><p>' + esc(d.description) + '</p></div>';
      if (hasCl) {
        if (hasDesc) H += '<div class="divider"></div>';
        H += '<div class="blk-t">تغییرات نسخه‌ی جدید</div><ul class="cl">';
        for (var c = 0; c < d.changelog.length; c++) H += '<li>' + esc(d.changelog[c]) + '</li>';
        H += '</ul>';
      }
      if (!hasDesc && !hasCl) H += '<div class="desc"><p style="color:var(--mut2)">توضیحی ثبت نشده است.</p></div>';
      H += '</div>';

      if (hasShots) {
        H += '<div class="pane" data-pane="shots"><div class="shots" id="shots">';
        for (var i = 0; i < d.screenshots.length; i++) {
          H += '<img src="' + esc(d.screenshots[i]) + '" alt="screenshot" loading="lazy" draggable="false" referrerpolicy="no-referrer" data-i="' + i + '" onerror="this.remove()">';
        }
        H += '</div></div>';
      }

      if (hasSpecs) {
        H += '<div class="pane" data-pane="spec"><div class="spec-wrap"><table class="spec-table"><tbody>';
        for (var s = 0; s < d.specs.length; s++) {
          var lbl = d.specs[s][0];
          var val = lbl === 'نسخه' || lbl === 'حجم' ? fa(d.specs[s][1]) : d.specs[s][1];
          H += '<tr><td class="l">' + esc(lbl) + '</td><td class="v">' + esc(val) + '</td></tr>';
        }
        if (d.datePublished) H += '<tr><td class="l">انتشار اولیه</td><td class="v">' + esc(isoDate(d.datePublished)) + '</td></tr>';
        if (d.versionCode) H += '<tr><td class="l">کد نسخه (API)</td><td class="v mono">' + esc(fa(d.versionCode)) + '</td></tr>';
        H += '</tbody></table></div></div>';
      }

      H += '<div class="pane" data-pane="raw"><pre class="rawj">' + esc(JSON.stringify(d, null, 2)) + '</pre></div>';
      H += '</div>';
    }

    out.innerHTML = H;

    if (d.rating && d.rating.value) {
      var rn = $('#rn');
      if (rn) countUp(rn, d.rating.value, 850, function (v) { return fa(Math.round(v * 10) / 10); });
    }

    /* پرکردن میله‌های امتیاز با انیمیشن */
    var fills = out.querySelectorAll('.bar-fill');
    setTimeout(function () {
      for (var fi = 0; fi < fills.length; fi++) {
        fills[fi].style.width = (fills[fi].getAttribute('data-w') || 0) + '%';
      }
    }, 120);

    var tabsBox = $('#tabs');
    if (tabsBox) tabsBox.addEventListener('click', function (e) {
      var t = e.target.closest('.tab');
      if (!t) return;
      var key = t.getAttribute('data-tab');
      var all = tabsBox.querySelectorAll('.tab');
      for (var i = 0; i < all.length; i++) all[i].className = 'tab' + (all[i] === t ? ' on' : '');
      var panes = out.querySelectorAll('.pane');
      for (var j = 0; j < panes.length; j++) panes[j].className = 'pane' + (panes[j].getAttribute('data-pane') === key ? ' on' : '');
    });

    var shots = $('#shots');
    if (shots) dragScroll(shots);

    var copyBtn = $('#copy');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      var payload = d.directUrl;
      var done = function () { toast('لینک مستقیم کپی شد', 'ok'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(payload).then(done, function () { fallbackCopy(payload); done(); });
      } else { fallbackCopy(payload); done(); }
    });

    var dbg2 = $('#dbg-run2');
    if (dbg2) dbg2.addEventListener('click', function () { runDebug(d.packageName); });
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  window.__ph = function (el) { return phIcon(typeof el === 'string' ? el : (el && el.className) || 'p-icon'); };

  function dragScroll(el) {
    var down = false, startX = 0, startL = 0, moved = false;
    el.addEventListener('pointerdown', function (e) {
      down = true; moved = false; startX = e.clientX; startL = el.scrollLeft;
      el.className = 'shots grabbing';
    });
    window.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - startX;
      if (Math.abs(dx) > 6) moved = true;
      el.scrollLeft = startL - dx;
    });
    window.addEventListener('pointerup', function () {
      if (!down) return;
      down = false; el.className = 'shots';
    });
    el.addEventListener('click', function (e) {
      if (moved) return;
      var img = e.target.closest('img');
      if (img) openLb(img.getAttribute('src'));
    });
  }

  function openLb(src) {
    $('#lb-img').src = src;
    $('#lb').className = 'lb on';
    document.body.style.overflow = 'hidden';
  }
  function closeLb() { $('#lb').className = 'lb'; document.body.style.overflow = ''; }
  $('#lb').addEventListener('click', function (e) { if (e.target.id !== 'lb-img') closeLb(); });
  $('#lb-x').addEventListener('click', closeLb);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLb(); });

  /* دیباگ */
  var STEP_NAMES = { app_page: 'صفحه‌ی برنامه', api_auth: 'احراز API', api_chain: 'زنجیره‌ی API', web_dl: 'فالبک وب', dl_chain: 'لینک دانلود', mobile_api: 'API موبایل' };
  function runDebug(pkg) {
    dbgBox.className = 'card on';
    dbgBox.id = 'debug';
    dbgBox.classList.add('on');
    dbgBox.innerHTML = '<div class="blk-t">عیب‌یابی اتصال <small>از داخل خود ورکر</small></div>' +
      '<div class="dbg-row"><i class="dbg-dot mid"></i><span class="dbg-name">در حال اجرا…</span></div>';
    fetch('/api/debug?pkg=' + encodeURIComponent(pkg))
      .then(function (r) { return r.json(); })
      .then(function (rep) {
        var H = '<div class="blk-t">عیب‌یابی اتصال <small>' + esc(rep.pkg) + ' · v' + esc(rep.v || '') + '</small></div>';
        var steps = rep.steps || [];
        for (var i = 0; i < steps.length; i++) {
          var s = steps[i];
          var dot = s.ok ? 'ok' : (s.note ? 'mid' : 'no');
          var info = s.detail || (s.ok ? 'ok' : 'ناموفق');
          H += '<div class="dbg-row"><i class="dbg-dot ' + dot + '"></i>' +
            '<span class="dbg-name">' + esc(STEP_NAMES[s.step] || s.step) + '</span>' +
            '<span class="dbg-info">' + esc((s.ms != null ? s.ms + 'ms · ' : '') + info) + '</span></div>';
        }
        dbgBox.innerHTML = H;
        dbgBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      })
      .catch(function () {
        dbgBox.innerHTML = '<div class="blk-t">عیب‌یابی</div><div class="dbg-row"><i class="dbg-dot no"></i><span class="dbg-name">خطا</span><span class="dbg-info">fetch failed</span></div>';
      });
  }
  $('#dbg-btn').addEventListener('click', function () { runDebug(currentPkg || 'com.digikala'); });

  /* ---------- کنسول API (فوتر) ---------- */
  function labLine(html) {
    var box = $('#lab-out');
    box.style.display = 'block';
    box.innerHTML = html;
  }
  function labBusy(pathHtml) {
    labLine('<span class="dim">$</span> ' + pathHtml + ' <span class="dim">… در حال اجرا</span>');
  }
  function labTime(t0) {
    var ms = Date.now() - t0;
    return ms >= 1000 ? (Math.round(ms / 100) / 10) + 's' : ms + 'ms';
  }
  function labPkg() {
    if (currentPkg) return currentPkg;
    var v = input.value.trim();
    return v || 'com.digikala';
  }

  $('#lab-resolve').addEventListener('click', function () {
    var pkg = labPkg();
    var path = '/api/resolve?pkg=' + encodeURIComponent(pkg);
    var t0 = Date.now();
    labBusy('GET ' + path);
    fetch(path)
      .then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); })
      .then(function (x) {
        labLine(
          '<span class="dim">$</span> GET ' + path + ' <span class="dim">·</span> ' + x.s + ' <span class="dim">·</span> ' + labTime(t0) + '<br>' +
          '<span class="dim">→</span> ok: ' + (x.d.ok ? 'true' : 'false') +
          (x.d.engine ? ' · engine: ' + x.d.engine : '') +
          (x.d.title ? ' · title: ' + esc(x.d.title) : '') +
          (x.d.directUrl ? ' · link: OK' : x.d.downloadError ? ' · ' + esc(x.d.downloadError) : (x.d.message ? ' · ' + esc(x.d.message) : ''))
        );
      })
      .catch(function () { labLine('<span class="dim">$</span> GET ' + path + ' <span class="dim">· fetch failed</span>'); });
  });

  $('#lab-download').addEventListener('click', function () {
    var pkg = labPkg();
    var path = '/api/download?pkg=' + encodeURIComponent(pkg);
    labBusy('GET ' + path);
    var w = window.open(path, '_blank');
    setTimeout(function () {
      labLine('<span class="dim">$</span> GET ' + path + '<br><span class="dim">→</span> دانلود در تب جدید شروع شد — فایل APK واقعی با نام درست می‌آید.' + (w ? '' : ' (پاپ‌آپ مسدود شد؛ دوباره کلیک کنید)'));
    }, 600);
  });

  $('#lab-health').addEventListener('click', function () {
    var t0 = Date.now();
    labBusy('GET /healthz');
    fetch('/healthz')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        labLine('<span class="dim">$</span> GET /healthz <span class="dim">·</span> 200 <span class="dim">·</span> ' + labTime(t0) + '<br><span class="dim">→</span> ' + esc(JSON.stringify(d)));
        var chip = $('#srv');
        if (d && d.ok) { chip.className = 'srv on'; chip.innerHTML = '<i></i>آنلاین'; }
        toast('سرویس سالم است — v' + (d.v || '?'), 'ok');
      })
      .catch(function () { labLine('<span class="dim">$</span> GET /healthz <span class="dim">· fetch failed</span>'); });
  });

  $('#share-btn').addEventListener('click', function () {
    var url = location.href;
    var done = function () { toast('لینک این صفحه کپی شد', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { fallbackCopy(url); done(); });
    } else { fallbackCopy(url); done(); }
  });

  /* اجرای اصلی */
  var aborter = null;
  function run(q) {
    if (!q) { renderError('نام بسته یا لینک مایکت را وارد کن.', q); return; }
    currentPkg = q;
    if (aborter) { try { aborter.abort(); } catch (e) {} }
    aborter = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timed = setTimeout(function () { if (aborter) aborter.abort(); }, 28000);

    setLoading(true);
    try { history.replaceState(null, '', '?p=' + encodeURIComponent(q)); } catch (e) {}
    fetch('/api/resolve?pkg=' + encodeURIComponent(q), aborter ? { signal: aborter.signal } : {})
      .then(function (r) { return r.json(); })
      .then(function (d) {
        clearTimeout(timed);
        setLoading(false);
        if (d && d.ok) { renderOk(d); pushRecent(d.packageName, d.title, d.icon); if (d.directUrl) toast('لینک دانلود آماده شد', 'ok'); return; }
        if (d && d.code === 'PAID') { renderPaid(d); pushRecent(d.packageName, d.title, d.icon); return; }
        renderError((d && d.message) || 'خطای نامشخص رخ داد.', q);
      })
      .catch(function (err) {
        clearTimeout(timed);
        setLoading(false);
        if (err && err.name === 'AbortError') renderError('بیش از ۲۸ ثانیه طول کشید — از «عیب‌یابی» علت را ببین.', q);
        else renderError('ارتباط با ورکر برقرار نشد. اینترنت را چک کن.', q);
      });
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); run(input.value.trim()); });

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('.chip') : null;
    if (t && t.getAttribute('data-p')) {
      input.value = t.getAttribute('data-p');
      run(input.value);
    }
  });

  try {
    var p = new URLSearchParams(location.search).get('p');
    if (p) { currentPkg = p; input.value = p; run(p); }
  } catch (e) {}
})();
</script>
</body>
</html>`;
