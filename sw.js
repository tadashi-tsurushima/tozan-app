// Service Worker（Step 6-2）: アプリ本体を丸ごとキャッシュし、2回目以降は
// オフラインで起動できるようにする。要件1（山中は圏外）の実現手段。
//
// アプリを更新したら CACHE_VERSION を上げること。古いキャッシュは activate 時に破棄する。
const CACHE_VERSION = "v6";
const CACHE_NAME = `tozan-app-shell-${CACHE_VERSION}`;

// 必須のアプリ本体一式。1つでも取得できなければ install 自体を失敗させ、
// 中途半端なキャッシュで動かないよりは新しいSWへの切り替えを諦めさせる。
const REQUIRED_ASSETS = [
  "index.html",
  "app.js",
  "app.css",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-512-maskable.png",
  "icons/apple-touch-icon.png",
  "img/hero.jpg",
  "vendor/chart.umd.js",
  "core.zip",
];

// あれば使う付随ファイル（Step 4-5 の検証ページ verify.html と cases.json）。
// 配布先（開発用 web/dist / 友人向け配布リポジトリ）によって同梱の有無が
// 変わるため、無くても install 全体を失敗させない。
const OPTIONAL_ASSETS = ["verify.html", "cases.json"];

async function cacheIfAvailable(cache, url) {
  try {
    const res = await fetch(url);
    if (res && res.ok) await cache.put(url, res);
  } catch (err) {
    // 無くてもよい
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(REQUIRED_ASSETS);

      for (const url of OPTIONAL_ASSETS) await cacheIfAvailable(cache, url);

      try {
        const cached = await cache.match("cases.json");
        if (cached) {
          const cases = await cached.clone().json();
          for (const c of cases) {
            await cacheIfAvailable(cache, c.gpx);
            await cacheIfAvailable(cache, c.summary);
          }
        }
      } catch (err) {
        // cases.json が壊れていてもアプリ本体のキャッシュ自体は成立させる
      }

      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;

      // ホーム画面から起動した際は "/" 宛てのナビゲーションになることがある。
      // アプリ本体は index.html なので、それをシェルとして返す。
      if (req.mode === "navigate") {
        const shell = await caches.match("index.html");
        if (shell) return shell;
      }

      try {
        const res = await fetch(req);
        // Pyodide本体・Google Fonts（Space Grotesk / IBM Plex）はCDN
        // （別オリジン）から読み込んでいる。オフライン対応のためにはこれも
        // キャッシュする必要があるので、opaqueレスポンス
        // （CORS未許可のクロスオリジン応答）も含めて保存する。
        if (res && (res.ok || res.type === "opaque")) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, res.clone());
        }
        return res;
      } catch (err) {
        throw err;
      }
    })()
  );
});
