<div align="center">

# 📦 myket-dl

**دانلود مستقیم APK برنامه‌های رایگان مایکت — با مشخصات کامل هر برنامه**

<a href="https://myket-dl.mmdbots.workers.dev/">
  <img src="https://img.shields.io/badge/LIVE%20DEMO-myket--dl.mmdbots.workers.dev-00C781?style=for-the-badge&logo=cloudflare&logoColor=white&labelColor=161712" alt="Live Demo">
</a>

<p>
  <img src="https://img.shields.io/badge/version-5.2.0-00C781?style=flat-square&labelColor=161712" alt="version">
  <img src="https://img.shields.io/badge/engine-hybrid-FFD23F?style=flat-square&labelColor=161712" alt="engine">
  <img src="https://img.shields.io/badge/platform-cloudflare%20workers-F38020?style=flat-square&logo=cloudflare&logoColor=white&labelColor=161712" alt="platform">
  <img src="https://img.shields.io/badge/dependencies-0-9BD6FF?style=flat-square&labelColor=161712" alt="deps">
  <img src="https://img.shields.io/badge/UI-dark%20mode%20%2B%20themes-B18CFF?style=flat-square&labelColor=161712" alt="theme">
</p>

<sub>کل پروژه همین یک فایله: <code>worker.js</code> — نه وابستگی داره، نه بیلد‌تول</sub>

</div>

---

## 🌐 نسخه‌ی زنده

**https://myket-dl.mmdbots.workers.dev/**

تست سریع بدون نصب:

```text
https://myket-dl.mmdbots.workers.dev/api/resolve?pkg=com.digikala
https://myket-dl.mmdbots.workers.dev/api/download?pkg=com.digikala
https://myket-dl.mmdbots.workers.dev/healthz
```

## ⚡ چطوری کار می‌کنه

دو تا موتور داره. اول می‌ره سراغ API رسمی موبایل مایکت (همونی که خود اپ مایکت
باهاش کار می‌کنه) و لینک واقعی CDN رو همراه با کد نسخه می‌گیره. اگر جواب نداد،
fallback وب فعال می‌شه و زنجیره‌ی ریدایرکت `myket.ir/dl` رو دنبال می‌کنه.

> [!CAUTION]
> مسیر `/dl` بیشتر مواقع به‌جای فایل برنامه، APK فروشگاه خود مایکت رو با اسم
> جعلی می‌فرسته. اینجا اون فایل با پترن تشخیص داده و رد می‌شه — دریافتش یعنی
> کاربر یه فایل کاملاً اشتباه نصب می‌کنه.

مشخصات برنامه (توضیحات، اسکرین‌شات، امتیاز، تغییرات نسخه، توزیع ستاره‌ها و
برنامه‌های مشابه) از JSON-LD و جدول مشخصات صفحه‌ی عمومی خونده می‌شه.

## ✨ چی داخلشه؟

- 🧠 **موتور هیبرید** — اولویت با API رسمی، fallback خودکار روی وب
- 🕵️ **تشخیص تله** — فایل جعلی myket-app هیچ‌وقت به کاربر نمی‌رسه
- 📊 **مشخصات کامل** — امتیاز، حجم، نسخه، چنج‌لاگ، اسکرین‌شات و برنامه‌های مشابه
- 🌙 **دارک‌مود + تم رنگی** — ۵ رنگ اصلی، ذخیره توی `localStorage`
- 🔗 **اشتراک نتیجه** — هر نتیجه با `?p=` لینک مستقیم داره
- 🧪 **کنسول تست داخلی** — اندپوینت‌ها رو از خود صفحه تست کن

## 📡 API

| مسیر | چکار می‌کنه |
|---|---|
| `GET /api/resolve?pkg=X` | مشخصات کامل + لینک دانلود |
| `GET /api/download?pkg=X` | استریم خود فایل APK با اسم درست |
| `GET /api/debug?pkg=X` | گزارش مرحله‌به‌مرحله، برای وقتی که چیزی کار نمی‌کنه |
| `GET /healthz` | سلامت سرویس |

> [!TIP]
> به‌جای `X` می‌تونی لینک صفحه‌ی برنامه رو هم بذاری، خودش اسم بسته رو از توش
> درمیاره. پارامتر `engine` هم هست: `api` / `web` / `hybrid` (پیش‌فرض hybrid)
> و با `force=1` می‌تونی circuit breaker رو دور بزنی.

فقط برنامه‌های رایگان رو سرو می‌کنه. برنامه‌ی پولی باشه با کد `PAID` برمی‌گرده.

## 🚀 نصب

**راه ساده:** توی داشبورد کلادفلر یه Worker بساز، محتوای `worker.js` رو
جایگذاری کن و Deploy بزن. همین.

**با wrangler:**

```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

`wrangler.toml` آماده‌ست. قبلش `wrangler login` یادت نره.

## 🎨 رابط کاربری

صفحه‌ی `/` یه UI فارسی داره:

- روی هر نتیجه مشخصه لینک از کدوم موتور اومده (چیپ API یا وب)
- گالری اسکرین‌شات با لایت‌باکس
- نمودار توزیع امتیاز کاربران
- دکمه‌ی «عیب‌یابی» که دقیقاً می‌گه کدوم مرحله گیر کرده (صفحه، auth، ساخت لینک و…)

## 📄 لایسنس

هر استفاده‌ای می‌خوای بکن. مسئولیت نحوه‌ی استفاده با خودته.

---

<div align="center">
  <sub>اگه بدردت خورد، یه ⭐ به ریپو بزن</sub>
</div>
