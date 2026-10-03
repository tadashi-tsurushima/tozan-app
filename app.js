/*
 * 登山エネルギー計算（計画モード）UIロジック。
 *
 * ここには表示・入出力だけを書く。単位換算・パラメータ検証・シミュレーション
 * などの数値を扱う処理はすべて Python 側（tozan/api.py, tozan/params.py）に
 * 置く（作業指示書 docs/05_ §1「ロジックは Python に置く」）。
 */

const VERSIONS = ["0.28.0", "0.27.7", "0.27.5", "0.27.2", "0.26.4", "0.25.1"];
const CDN = v => `https://cdn.jsdelivr.net/pyodide/v${v}/full/`;
const STORAGE_KEY = "tozan_params_v1";
// 「現在の値を規定値に設定」で保存する、ユーザー自身のカスタム既定値。
// STORAGE_KEY（入力するたびに自動保存される最後の入力値）とは別物で、
// 「既定値に戻す」ボタンが戻る先をこちらに変える。
const CUSTOM_DEFAULTS_KEY = "tozan_custom_defaults_v1";

const statusEl = document.getElementById("status");
const outEl = document.getElementById("out");
const fileEl = document.getElementById("gpxFile");
const runBtn = document.getElementById("run");
const resetBtn = document.getElementById("resetParams");
const saveAsDefaultBtn = document.getElementById("saveAsDefault");
const userFieldsEl = document.getElementById("userFields");
const advancedFieldsEl = document.getElementById("advancedFields");
const dayTabsEl = document.getElementById("dayTabs");
const dayStatsEl = document.getElementById("dayStats");
const waypointsEl = document.getElementById("waypoints");
const chartsEl = document.getElementById("charts");
const supplyPlanEl = document.getElementById("supplyPlan");
const sampleGpxEl = document.getElementById("sampleGpx");

// 「夜明けの稜線」テーマは常時ダーク固定の1配色なので、Chart.js の既定文字色・
// グリッド色も app.css の --chart-fg / --text-muted に合わせて固定でよい
// （旧ライト/ダーク切り替え時にあった動的な読み直しは不要になった）。
if (window.Chart) {
  Chart.defaults.color = getComputedStyle(document.documentElement).getPropertyValue("--chart-fg").trim();
  Chart.defaults.borderColor = "rgba(255, 255, 255, 0.08)";
  // スマホ縦画面に3グラフ入るよう高さを縮めた（app.css .chart-wrap）ぶん、
  // 目盛り・軸タイトルの文字も少し小さくして余白を稼ぐ（依頼者確認・2026-09-19）。
  Chart.defaults.font.size = 10;
}

// 手元にGPXが無い人向けのお試しサンプル。samples.json は配布先によって
// 同梱の有無が変わる（開発用ビルドには無い）ので、無ければ何も表示しない。
// クリックしたらダウンロードさせるのではなく、その場でファイル選択欄に
// 読み込ませる（＝自分でファイルを選んだのと同じ状態にする）。
async function loadSampleGpx() {
  if (!sampleGpxEl) return;
  try {
    const res = await fetch("samples.json");
    if (!res.ok) return;
    const samples = await res.json();
    if (!Array.isArray(samples) || !samples.length) return;
    const links = samples
      .map((s, i) => `<a href="#" data-sample-index="${i}">${s.name}</a>`)
      .join(" ・ ");
    sampleGpxEl.innerHTML = `<span class="hint">GPXをお持ちでない場合はサンプルをどうぞ: ${links}</span>`;
    sampleGpxEl.hidden = false;

    sampleGpxEl.querySelectorAll("a[data-sample-index]").forEach((a) => {
      a.addEventListener("click", async (ev) => {
        ev.preventDefault();
        const sample = samples[parseInt(a.dataset.sampleIndex, 10)];
        try {
          const gpxRes = await fetch(sample.file);
          const blob = await gpxRes.blob();
          const file = new File([blob], sample.file, { type: "application/gpx+xml" });
          const dt = new DataTransfer();
          dt.items.add(file);
          fileEl.files = dt.files;
          fileEl.dispatchEvent(new Event("change"));
        } catch (err) {
          setStatus(`サンプルの読み込みに失敗しました: ${err}`, "ng");
        }
      });
    });
  } catch (e) {
    // samples.json が無い/読めない環境では何も表示しない
  }
}
loadSampleGpx();

function setStatus(msg, cls) {
  statusEl.innerHTML = msg;
  statusEl.className = cls || "";
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = () => resolve(url);
    s.onerror = () => reject(new Error("読み込み失敗: " + url));
    document.head.appendChild(s);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

// Pyodide 側で定義する関数群。/core を sys.path に追加してコアを import する。
const DRIVER_SRC = `
import sys, json
if "/core" not in sys.path:
    sys.path.append("/core")

from tozan.api import simulate, default_params, validate_params
from tozan.params import PARAMS_CONTRACT
from tozan.derived import (plan_summary, supply_plan, ui_series, waypoint_table,
                           weather_request_plan, weather_from_responses)
from loaders.gpx import parse_gpx

def form_spec_json():
    """条件入力フォーム用に、tier が user/advanced の項目を返す。

    default/min/max は display_scale があれば表示単位に変換済み
    （例: RH は内部 0.6 -> 表示 60）。internal tier の項目はここに出てこない。
    """
    fields = []
    for key, spec in PARAMS_CONTRACT.items():
        if spec["tier"] not in ("user", "advanced"):
            continue
        entry = dict(spec)
        entry["key"] = key
        scale = spec.get("display_scale")
        if scale:
            for f in ("default", "min", "max"):
                if f in entry and isinstance(entry[f], (int, float)):
                    entry[f] = entry[f] * scale
        fields.append(entry)
    return json.dumps(fields)

def _split_error(e):
    sep = e.find(": ")
    if sep == -1:
        return {"key": None, "message": e}
    return {"key": e[:sep], "message": e[sep + 2:]}

def _build_params(route, form_values_json):
    """フォーム値（表示単位）から params を作り、検査する。(params, errors) を返す。"""
    form_values = json.loads(form_values_json)
    params = default_params()
    for key, value in form_values.items():
        spec = PARAMS_CONTRACT.get(key)
        if spec is None:
            continue
        scale = spec.get("display_scale")
        if scale and isinstance(value, (int, float)):
            value = value / scale
        params[key] = value

    # 登山口の標高は GPX の最初の点から自動で入れる（2026-10-03、作者の判断で
    # 詳細設定から外した）。以前の保存値がフォームに残っていても、こちらで上書きする。
    params["T_air_elevation"] = max(0.0, float(route.points[0].ele))

    errors = validate_params(params)
    if errors:
        return params, errors
    return params, []

def _parse_route(gpx_text):
    try:
        route = parse_gpx(gpx_text)
    except Exception as e:
        return None, f"GPXの読み込みに失敗しました: {e}"
    if not route.points:
        return None, "GPXファイルに位置データ（trkpt）が見つかりません。"
    return route, None

def weather_plan_from_form(gpx_text, form_values_json, start_date, today):
    """計画モードの天気（2026-10-03）: いったん計算して日ごとの出発時刻と所要時間を出し、
    Open-Meteo への問い合わせ（日ごとの出発地点・日付・時間帯と URL）を返す。"""
    route, err = _parse_route(gpx_text)
    if err:
        return json.dumps({"ok": False, "errors": [{"key": None, "message": err}]})
    params, errors = _build_params(route, form_values_json)
    if errors:
        return json.dumps({"ok": False, "errors": [_split_error(e) for e in errors]})
    result = simulate(route, params)
    return json.dumps({"ok": True, "plan": weather_request_plan(result, route, params, start_date, today)})

def weather_apply(plan_json, responses_json):
    """Open-Meteo の応答から日ごとの気温・湿度を出す。"""
    return json.dumps(weather_from_responses(json.loads(plan_json), json.loads(responses_json)))

def run_simulation_from_form(gpx_text, form_values_json, start_date=""):
    """GPXテキストとフォーム値（表示単位）から計算する。

    戻り値は常に JSON 文字列で、成功なら {"ok": true, "result": {...}}、
    失敗なら {"ok": false, "errors": [{"key": ..., "message": ...}, ...]}。
    例外を投げて JS 側でメッセージ文字列を解析させると、Pyodide が例外を
    どう JS に渡すか（トレースバックの形式）に依存して脆くなるため、
    構造化した戻り値にした。

    params は default_params() から作り、フォームに出ている項目だけ
    上書きする（internal tier の項目は既定値のまま）。
    """
    try:
        route = parse_gpx(gpx_text)
    except Exception as e:
        return json.dumps({"ok": False, "errors": [
            {"key": None, "message": f"GPXの読み込みに失敗しました: {e}"}]})

    if not route.points:
        return json.dumps({"ok": False, "errors": [
            {"key": None, "message": "GPXファイルに位置データ（trkpt）が見つかりません。"}]})

    params, errors = _build_params(route, form_values_json)
    if errors:
        return json.dumps({"ok": False, "errors": [_split_error(e) for e in errors]})

    result = simulate(route, params)
    # 天気の欄の出発日が入っていれば、表示する日付を「出発日 + 日数」にする（2026-10-03）。
    # 空なら GPX の日付のまま。計算そのもの（時刻・所要時間）は変わらない。
    if start_date:
        import datetime
        d0 = datetime.date.fromisoformat(start_date)
        for i, day in enumerate(result.days):
            day.date = d0 + datetime.timedelta(days=i)
    summary = plan_summary(result, params)
    series = ui_series(result, pace_smooth_minutes=15)
    plan = supply_plan(result, params)
    waypoints = waypoint_table(result, route, params)
    return json.dumps({"ok": True, "result": result.to_dict(), "summary": summary,
                        "series": series, "plan": plan, "waypoints": waypoints})
`;

let pyodide = null;
let runSimulationFromForm = null;
let weatherPlanFromForm = null;
let weatherApply = null;
// 計画モードの天気（2026-10-03）。日ごとの {day, date, kind, T_air, RH, elevation_m}。
// 保存する入力値には含めない（別の GPX を選ぶと消える）。
let dayWeather = null;
let formFields = [];  // form_spec_json() の内容

async function boot() {
  try {
    const wanted = new URLSearchParams(location.search).get("v");
    const candidates = wanted ? [wanted, ...VERSIONS] : VERSIONS;

    let version = null;
    for (const v of candidates) {
      setStatus(`Pyodide ${v} を読み込んでいます...`);
      try {
        await loadScript(CDN(v) + "pyodide.js");
        version = v;
        break;
      } catch (e) { /* 次の候補へ */ }
    }
    if (!version) throw new Error("どのバージョンの Pyodide も読み込めませんでした。ネットワークをご確認ください。");

    setStatus(`Pyodide ${version} を初期化しています...<br>Python 本体をダウンロード中です。`);
    pyodide = await loadPyodide({ indexURL: CDN(version) });

    setStatus("計算コアを取得しています...");
    const zipResp = await fetch("core.zip", { cache: "no-store" });
    if (!zipResp.ok) throw new Error(`core.zip が取得できません (HTTP ${zipResp.status})。`
                                   + ` web/dist/ を HTTP サーバー経由で開いていますか？`);
    const zipBuf = await zipResp.arrayBuffer();
    pyodide.unpackArchive(zipBuf, "zip", { extractDir: "/core" });

    await pyodide.runPythonAsync(DRIVER_SRC);
    runSimulationFromForm = pyodide.globals.get("run_simulation_from_form");
    weatherPlanFromForm = pyodide.globals.get("weather_plan_from_form");
    weatherApply = pyodide.globals.get("weather_apply");

    const formSpecFn = pyodide.globals.get("form_spec_json");
    formFields = JSON.parse(formSpecFn());
    formSpecFn.destroy();

    buildForm(formFields);
    applyDefaultsToForm(loadCustomDefaults());
    restoreFormValues();

    fileEl.disabled = false;
    setStatus("GPXファイルを選んでください。", "ok");
  } catch (err) {
    setStatus(`<span class="ng">エラー: ${err.message}</span>`);
  }
}

// ---------------- フォーム生成 ----------------

// 「VO2使用率」は一般の利用者には意味が伝わらないため、フォーム上だけ
// ペースの4段階選択にする（依頼者指定・2026-09-19）。値そのもの（%）は
// contract/params.json の vo2_usage_ratio のまま、UIの見せ方だけを変える。
const VO2_PACE_OPTIONS = [
  { value: 70, label: "速い (200%)" },
  { value: 65, label: "かなり速い (175%)" },
  { value: 60, label: "やや速い (150%)" },
  { value: 55, label: "ちょっと速い (125%)" },
  { value: 52, label: "気持ち速い (110%)" },
  { value: 50, label: "普通 (100%)" },
  { value: 45, label: "のんびり (80-90%)" },
];

// 出発時のグリコーゲン充填率（Phase 4b-0）も同様に3択にする。数値そのものは
// contract/params.json の既定値のまま（display_scale は無いのでJS側も0.53等の生値）。
// 下りの速さ（Phase 6-6）。下り区間だけ歩行の上限に掛ける係数を百分率で選ぶ。
// 100% が作者の位置（v_flat_gait = 1.06 m/s、実測9本の平均）。10%刻みのセレクトに
// してあるのは、スマホでホイールとして回せて、一度実績に合わせたらそれを
// 「現在の値を規定値に設定」で覚えられるようにするため（作者の判断・2026-09-23）。
// params.json 側は 0.5〜2.0 の係数で、display_scale = 100 で百分率に変換される。
const DESCENT_SPEED_OPTIONS = [];
for (let pct = 50; pct <= 150; pct += 10) {
  DESCENT_SPEED_OPTIONS.push({ value: pct, label: pct === 100 ? "100%（基準）" : `${pct}%` });
}

// 天気（Phase 7-5、2026-09-29）。日射の値（W/m²）を選ぶ。日射が効くのは森林限界より上だけ。
// 値は ERA5 の山行日の実データから（contract/params.json の solar_W_m2 の説明を参照）。
const WEATHER_SOLAR_OPTIONS = [
  { value: 600, label: "晴れ" },
  { value: 300, label: "曇り" },
];

const GLYCOGEN_FILL_OPTIONS = [
  { value: 0.53, label: "通常食" },
  { value: 0.8, label: "軽いローディング" },
  { value: 1.0, label: "本格ローディング" },
];

function fieldInputHtml(spec) {
  const id = `f_${spec.key}`;
  if (spec.type === "boolean") {
    const checked = spec.default ? "checked" : "";
    return `<label><input type="checkbox" id="${id}" data-key="${spec.key}" ${checked}> `
         + `${spec.label_ja}</label>`;
  }
  if (spec.key === "vo2_usage_ratio") {
    const opts = VO2_PACE_OPTIONS.map(o =>
      `<option value="${o.value}" ${Math.round(spec.default) === o.value ? "selected" : ""}>`
      + `${o.label}</option>`).join("");
    return `<label for="${id}">${spec.label_ja}</label>`
         + `<select id="${id}" data-key="${spec.key}">${opts}</select>`;
  }
  if (spec.key === "descent_gait_factor") {
    // spec.default は display_scale 適用後（＝100）で届く
    const opts = DESCENT_SPEED_OPTIONS.map(o =>
      `<option value="${o.value}" ${Math.round(spec.default) === o.value ? "selected" : ""}>`
      + `${o.label}</option>`).join("");
    return `<label for="${id}">${spec.label_ja}</label>`
         + `<select id="${id}" data-key="${spec.key}">${opts}</select>`;
  }
  if (spec.key === "solar_W_m2") {
    const opts = WEATHER_SOLAR_OPTIONS.map(o =>
      `<option value="${o.value}" ${Math.round(spec.default) === o.value ? "selected" : ""}>`
      + `${o.label}</option>`).join("");
    return `<label for="${id}">${spec.label_ja}</label>`
         + `<select id="${id}" data-key="${spec.key}">${opts}</select>`;
  }
  if (spec.key === "glycogen_fill_ratio_init") {
    const opts = GLYCOGEN_FILL_OPTIONS.map(o =>
      `<option value="${o.value}" ${spec.default === o.value ? "selected" : ""}>`
      + `${o.label} (${o.value})</option>`).join("");
    return `<label for="${id}">${spec.label_ja}</label>`
         + `<select id="${id}" data-key="${spec.key}">${opts}</select>`;
  }
  if (spec.type === "string" && spec.enum) {
    const opts = spec.enum.map(v =>
      `<option value="${v}" ${v === spec.default ? "selected" : ""}>${v}</option>`).join("");
    return `<label for="${id}">${spec.label_ja}</label>`
         + `<select id="${id}" data-key="${spec.key}">${opts}</select>`;
  }
  // number（このフォームに array 型は出てこない。local_muscle_shares は internal tier）
  const min = spec.min != null ? ` min="${spec.min}"` : "";
  const max = spec.max != null ? ` max="${spec.max}"` : "";
  const unitLabel = spec.display_unit || spec.unit;
  const unit = unitLabel ? ` <span class="unit">[${unitLabel}]</span>` : "";
  return `<label for="${id}">${spec.label_ja}${unit}</label>`
       + `<input type="number" id="${id}" data-key="${spec.key}" `
       + `value="${spec.default}"${min}${max} step="any">`;
}

function fieldHtml(spec) {
  const cls = spec.type === "boolean" ? "field field-checkbox" : "field";
  // モデル化の根拠などの説明文は一般の利用者には伝わらないため表示しない
  // （作者指定・2026-09-22、実機確認のフィードバック）。ラベル横の単位表記は残す。
  return `<div class="${cls}" data-field="${spec.key}">`
       + fieldInputHtml(spec)
       + `<div class="err-msg" id="err_${spec.key}"></div>`
       + `</div>`;
}

function buildForm(fields) {
  userFieldsEl.innerHTML = fields.filter(f => f.tier === "user").map(fieldHtml).join("");
  advancedFieldsEl.innerHTML = fields.filter(f => f.tier === "advanced").map(fieldHtml).join("");
}

function collectFormValues() {
  const values = {};
  for (const spec of formFields) {
    const el = document.getElementById(`f_${spec.key}`);
    if (!el) continue;
    if (spec.type === "boolean") values[spec.key] = el.checked;
    else if (spec.type === "number") values[spec.key] = parseFloat(el.value);
    else values[spec.key] = el.value;
  }
  return values;
}

function clearFieldErrors() {
  document.querySelectorAll(".err-msg").forEach(e => e.textContent = "");
  document.querySelectorAll(".field input, .field select").forEach(e => e.classList.remove("err"));
}

function showFieldErrors(errors) {
  clearFieldErrors();
  for (const { key, message } of errors) {
    const msgEl = key && document.getElementById(`err_${key}`);
    if (msgEl) {
      msgEl.textContent = message;
      const input = document.getElementById(`f_${key}`);
      if (input) input.classList.add("err");
    }
  }
}

function saveFormValues() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collectFormValues()));
  } catch (e) { /* プライベートモード等では諦める */ }
}

function restoreFormValues() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch (e) {
    saved = {};
  }
  const validKeys = new Set(formFields.map(f => f.key));
  for (const [key, value] of Object.entries(saved)) {
    if (!validKeys.has(key)) continue;  // 廃止されたパラメータの古い保存値は捨てる
    const el = document.getElementById(`f_${key}`);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = value;
    else el.value = value;
  }
}

function loadCustomDefaults() {
  try {
    return JSON.parse(localStorage.getItem(CUSTOM_DEFAULTS_KEY) || "{}");
  } catch (e) {
    return {};
  }
}

// ユーザーが「現在の値を規定値に設定」で保存したカスタム既定値があれば
// そちらを優先し、無い項目はアプリ本来の既定値（contract/params.json）を使う。
// 初期表示（restoreFormValuesで最後の入力値が上書きされる前のベース）と
// 「既定値に戻す」の両方から使う共通処理。
function applyDefaultsToForm(customDefaults) {
  for (const spec of formFields) {
    const el = document.getElementById(`f_${spec.key}`);
    if (!el) continue;
    const hasCustom = Object.prototype.hasOwnProperty.call(customDefaults, spec.key);
    const value = hasCustom ? customDefaults[spec.key] : spec.default;
    if (spec.type === "boolean") el.checked = !!value;
    else el.value = value;
  }
}

function resetFormToDefaults() {
  applyDefaultsToForm(loadCustomDefaults());
  clearFieldErrors();
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
}

// 現在の入力値をカスタム既定値として保存する。1回のクリックで既定値が
// 書き変わってしまうと危険なため、確認ダイアログを必ず挟む
// （依頼者指定・2026-09-20）。
function saveCurrentAsDefault() {
  const ok = confirm(
    "現在の入力値を、今後「既定値に戻す」で戻る先の値として保存します。\n" +
    "よろしいですか？"
  );
  if (!ok) return;
  try {
    localStorage.setItem(CUSTOM_DEFAULTS_KEY, JSON.stringify(collectFormValues()));
    alert("現在の値を規定値として保存しました。");
  } catch (e) {
    alert("保存に失敗しました（ブラウザの設定でlocalStorageが使えない可能性があります）。");
  }
}

document.addEventListener("input", (e) => {
  if (e.target.closest("#userFields, #advancedFields")) saveFormValues();
});
document.addEventListener("change", (e) => {
  if (e.target.closest("#userFields, #advancedFields")) saveFormValues();
});

resetBtn.addEventListener("click", resetFormToDefaults);
saveAsDefaultBtn.addEventListener("click", saveCurrentAsDefault);

fileEl.addEventListener("change", async () => {
  runBtn.disabled = !fileEl.files.length;
  fetchWeatherBtn.disabled = !fileEl.files.length;
  // 別の GPX を選んだら日ごとの天気は消し、GPX に日付があれば出発日の初期値にする
  setDayWeather(null);
  const file = fileEl.files[0];
  if (!file) return;
  try {
    const m = /<trkpt[\s\S]*?<time>([^<]+)<\/time>/.exec(await readFileAsText(file));   // metadata の作成日時を拾わない
    if (m) {
      const t = new Date(m[1]);
      if (!isNaN(t)) startDateEl.value = localDateIso(t);
    }
  } catch (e) { /* 日付が読めなければ空のまま */ }
});

// ---------------------------------------------------------------- 計画モードの天気
const startDateEl = document.getElementById("startDate");
const fetchWeatherBtn = document.getElementById("fetchWeather");
const clearWeatherBtn = document.getElementById("clearWeather");
const weatherTableEl = document.getElementById("weatherTable");
const WEATHER_KIND_JA = { forecast: "予報", climate: "過去10年の平均", past: "当日の記録" };

function localDateIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function setDayWeather(days) {
  dayWeather = days;
  // 取得した値を覚えておく。1日目を直したら、その差を2日目以降（個別に直していない日）にも
  // 足す（作者の要望 2026-10-03: 「もっと暑い」は縦走の全日に効かせる）。
  if (days) days.forEach(d => {
    if (d.T_fetched === undefined) { d.T_fetched = d.T_air; d.RH_fetched = d.RH; d.T_own = false; d.RH_own = false; }
  });
  clearWeatherBtn.hidden = !days;
  if (!days) {
    weatherTableEl.innerHTML = "";
    return;
  }
  let html = `<div class="table-scroll"><table class="daily-table weather-table"><tr>`
    + `<th>日</th><th>日付</th><th>出発地点<br><span class="unit">(m)</span></th>`
    + `<th>気温<br><span class="unit">(℃)</span></th><th>湿度<br><span class="unit">(%)</span></th><th>情報</th></tr>`;
  days.forEach((d, i) => {
    const t = d.T_air == null ? "" : d.T_air;
    const rh = d.RH == null ? "" : Math.round(d.RH * 100);
    html += `<tr><td>${i + 1}日目</td><td>${shortDate(d.date)}</td><td class="num">${d.elevation_m}</td>`
      + `<td><input type="number" step="0.1" id="wT_${i}" data-i="${i}" data-k="T_air" value="${t}"></td>`
      + `<td><input type="number" step="1" min="0" max="100" id="wRH_${i}" data-i="${i}" data-k="RH" value="${rh}"></td>`
      + `<td>${WEATHER_KIND_JA[d.kind] ?? d.kind}</td></tr>`;
  });
  html += `</table></div>`;
  weatherTableEl.innerHTML = html;
  weatherTableEl.querySelectorAll("input").forEach(el => {
    el.addEventListener("change", () => {
      const i = parseInt(el.dataset.i, 10);
      const v = parseFloat(el.value);
      if (isNaN(v)) return;
      if (i === 0) {
        setDay1Weather(el.dataset.k, el.dataset.k === "T_air" ? v : v / 100);
        return;
      }
      const d = dayWeather[i];
      if (el.dataset.k === "T_air") { d.T_air = v; d.T_own = true; }
      else { d.RH = v / 100; d.RH_own = true; }
    });
  });
  syncFieldsFromDay1();
}

// 日ごとの表の1日目と、条件入力の「行動中の平均気温（登山口）」・詳細設定の「湿度」を連動させる
// （作者の要望 2026-10-03: 取得した値が入力欄に見えるように。1日目は表の値が計算に
// 使われるので、欄だけ直しても効かない状態を作らない）。
function syncFieldsFromDay1() {
  if (!dayWeather || !dayWeather.length) return;
  const d = dayWeather[0];
  const t = document.getElementById("f_T_air");
  const rh = document.getElementById("f_RH");
  if (t && d.T_air != null) t.value = d.T_air;
  if (rh && d.RH != null) rh.value = Math.round(d.RH * 100);
  saveFormValues();
}

// 1日目の気温か湿度を直したとき: 取得した値との差を、個別に直していない日すべてに足す。
function setDay1Weather(key, value) {
  const d0 = dayWeather[0];
  if (key === "T_air") {
    const offset = d0.T_fetched == null ? 0 : value - d0.T_fetched;
    dayWeather.forEach((d, i) => {
      if (i === 0) d.T_air = value;
      else if (!d.T_own && d.T_fetched != null) d.T_air = Math.round((d.T_fetched + offset) * 10) / 10;
      const cell = document.getElementById(`wT_${i}`);
      if (cell) cell.value = d.T_air ?? "";
    });
  } else {
    const offset = d0.RH_fetched == null ? 0 : value - d0.RH_fetched;
    dayWeather.forEach((d, i) => {
      if (i === 0) d.RH = value;
      else if (!d.RH_own && d.RH_fetched != null) d.RH = Math.min(1, Math.max(0.01, Math.round((d.RH_fetched + offset) * 100) / 100));
      const cell = document.getElementById(`wRH_${i}`);
      if (cell) cell.value = d.RH == null ? "" : Math.round(d.RH * 100);
    });
  }
  syncFieldsFromDay1();
}

document.addEventListener("change", (e) => {
  if (!dayWeather || !dayWeather.length) return;
  const v = parseFloat(e.target.value);
  if (isNaN(v)) return;
  if (e.target.id === "f_T_air") setDay1Weather("T_air", v);
  else if (e.target.id === "f_RH") setDay1Weather("RH", v / 100);
});

// 計算に渡す日ごとの天気。気温が空の日は null（その日は「行動中の平均気温（登山口）」を使う）。
function weatherFormValues() {
  if (!dayWeather) return {};
  return {
    day_T_air: dayWeather.map(d => d.T_air),
    day_RH: dayWeather.map(d => d.RH),
    day_T_air_elevation: dayWeather.map(d => d.elevation_m),
  };
}

clearWeatherBtn.addEventListener("click", () => setDayWeather(null));

fetchWeatherBtn.addEventListener("click", async () => {
  const file = fileEl.files[0];
  if (!file) return;
  if (!startDateEl.value) {
    setStatus(`<span class="ng">出発日を入れてください。</span>`);
    return;
  }
  fetchWeatherBtn.disabled = true;
  setStatus("天気を取得しています...");
  try {
    const gpxText = await readFileAsText(file);
    const planResp = JSON.parse(weatherPlanFromForm(gpxText, JSON.stringify(collectFormValues()),
                                                    startDateEl.value, localDateIso(new Date())));
    if (!planResp.ok) {
      showFieldErrors(planResp.errors);
      setStatus(`<span class="ng">入力内容を確認してください。</span>`);
      return;
    }
    const responses = [];
    for (const req of planResp.plan.requests) {
      const r = await fetch(req.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      responses.push(await r.json());
    }
    const result = JSON.parse(weatherApply(JSON.stringify(planResp.plan), JSON.stringify(responses)));
    setDayWeather(result.days);
    setStatus("天気を取得しました。計算しています...");
    runBtn.click();
  } catch (err) {
    setStatus(`<span class="ng">天気を取得できませんでした（通信を確認してください）: ${err.message || err}</span>`);
  } finally {
    fetchWeatherBtn.disabled = !fileEl.files.length;
  }
});

runBtn.addEventListener("click", async () => {
  const file = fileEl.files[0];
  if (!file) return;

  runBtn.disabled = true;
  fileEl.disabled = true;
  outEl.innerHTML = "";
  clearFieldErrors();
  setStatus(`${file.name} を計算しています...`);

  try {
    const gpxText = await readFileAsText(file);
    const formValues = { ...collectFormValues(), ...weatherFormValues() };
    const t0 = performance.now();
    const responseJson = runSimulationFromForm(gpxText, JSON.stringify(formValues), startDateEl.value);
    const elapsedMs = performance.now() - t0;
    const response = JSON.parse(responseJson);

    if (!response.ok) {
      showFieldErrors(response.errors);
      const generic = response.errors.filter(e => !e.key).map(e => e.message);
      setStatus(generic.length
        ? `<span class="ng">エラー: ${generic.join(" / ")}</span>`
        : `<span class="ng">入力内容を確認してください。</span>`);
      dayTabsEl.hidden = true;
      chartsEl.hidden = true;
      waypointsEl.hidden = true;
      supplyPlanEl.innerHTML = "";
    } else {
      render(response.summary, file.name, elapsedMs);
      currentSeries = response.series;
      currentSummary = response.summary;
      currentWaypoints = response.waypoints;
      chartsEl.hidden = false;
      buildDayTabs(currentSeries.days);
      showDay(0);
      renderSupplyPlan(response.plan, currentSeries.days);
      setStatus(`<span class="ok">計算が完了しました。</span>（${elapsedMs.toFixed(0)} ms）`);
    }
  } catch (err) {
    // ここに来るのは予期しない内部エラー（Python側のバグ等）。
    setStatus(`<span class="ng">エラー: ${err.message || err}</span>`);
    dayTabsEl.hidden = true;
    chartsEl.hidden = true;
    waypointsEl.hidden = true;
    supplyPlanEl.innerHTML = "";
  } finally {
    runBtn.disabled = false;
    fileEl.disabled = false;
  }
});

// tozan/derived.py の plan_summary() が返す集計値をそのまま表示する。
// 単位換算・合計計算はすべて Python 側で済んでいる。
function render(summary, fileName) {
  const days = summary.days;
  const total = summary.total;
  let html = `<h2>${fileName} の結果</h2>`;

  // 山行全体のトータルは、YAMAPの表示にならい「タイム・距離・のぼり・くだり」の
  // 1行4列だけにする（作者指定・2026-09-22、実機確認のフィードバック）。
  // 消費エネルギー・発汗量は合計を見ても意味が薄く、日ごとの値（day-stats・
  // 日別内訳）のほうが大事なのでここには出さない。
  html += `<div class="day-stats cols-4">
    <div class="day-stat"><span class="day-stat-label">タイム</span>`
      + `<span class="day-stat-value">${formatHoursJa(total.duration_h)}</span></div>
    <div class="day-stat"><span class="day-stat-label">距離</span>`
      + `<span class="day-stat-value">${total.distance_km.toFixed(1)} km</span></div>
    <div class="day-stat"><span class="day-stat-label">のぼり</span>`
      + `<span class="day-stat-value">↑${total.up_m.toFixed(0)} m</span></div>
    <div class="day-stat"><span class="day-stat-label">くだり</span>`
      + `<span class="day-stat-value">↓${total.down_m.toFixed(0)} m</span></div>
  </div>`;

  if (days.length > 1) {
    html += `<h3>日別内訳</h3>`;
    html += `<div class="table-scroll"><table class="daily-table"><tr><th>日</th>`
          + `<th>距離<br><span class="unit">(km)</span></th>`
          + `<th>登り<br><span class="unit">(m)</span></th>`
          + `<th>下り<br><span class="unit">(m)</span></th>`
          + `<th>所要時間</th>`
          + `<th>消費<br><span class="unit">(kcal)</span></th>`
          + `<th>発汗<br><span class="unit">(kg)</span></th></tr>`;
    for (const d of days) {
      html += `<tr><td>${shortDate(d.date)}</td>`
            + `<td class="num">${d.distance_km.toFixed(1)}</td>`
            + `<td class="num">${d.up_m.toFixed(0)}</td>`
            + `<td class="num">${d.down_m.toFixed(0)}</td>`
            + `<td class="num">${formatHoursJa(d.duration_h)}</td>`
            + `<td class="num">${d.kcal.toFixed(0)}</td>`
            + `<td class="num">${d.sweat_kg.toFixed(2)}</td></tr>`;
    }
    html += `</table></div>`;
  }

  html += `<p class="hint">必要な水・行動食は仮の計算式です`
        + `（水=発汗量の合計、行動食=消費kcal−初期グリコーゲン量）。`
        + `モデル作成者が式を確定したら精度が上がります。</p>`;

  outEl.innerHTML = html;
}

// ---------------- 結果グラフ（Step 5-4） ----------------
// tozan/derived.py の ui_series() が返す系列をそのまま描画する。
// 系列の計算（ペース・累積値など）はすべて Python 側で済んでいる。

let currentSeries = null;
let currentSummary = null;
let currentWaypoints = null;  // waypoint_table() の結果（計画モード、2026-10-02）
let charts = {};

// 日別内訳テーブルの「日」列は "2025-08-15" のままだと幅を取りすぎるので、
// 表示だけ "8/15" に短縮する（年は同じ登山で変わらないため省略しても情報は落ちない）。
function shortDate(dateStr) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(dateStr || "");
  return m ? `${parseInt(m[1], 10)}/${parseInt(m[2], 10)}` : (dateStr ?? "-");
}

function formatHM(hours) {
  const totalMin = Math.round(hours * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${hh}:${String(mm).padStart(2, "0")}`;
}

// 所要時間・休憩時間の表示形式。「X.XX h」だと分かりにくいので「X時間XX分」に
// する（作者指定・2026-09-22、実機確認のフィードバック）。
function formatHoursJa(hours) {
  const totalMin = Math.round(hours * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${hh}時間${String(mm).padStart(2, "0")}分`;
}

function toPoints(xs, ys) {
  return xs.map((x, i) => ({ x, y: ys[i] }));
}

function destroyCharts() {
  for (const key of Object.keys(charts)) {
    charts[key].destroy();
    delete charts[key];
  }
}

// 標高を灰色の塗りつぶしで背景に敷くための共通データセット（YAMAP 風）。
// datasets 配列の先頭に置くことで、他の系列より先に（＝背面に）描画される。
// yElevation は右側の第2軸として目盛り・軸ラベルを表示する
// （makeLineChart の既定スケール設定）。標高の値の大小は他の軸のスケールに影響しない。
function elevationBackdrop(s) {
  return {
    label: "標高",
    data: toPoints(s.elapsed_h, s.elevation_m),
    borderColor: "rgba(148, 163, 184, 0.55)",
    backgroundColor: "rgba(148, 163, 184, 0.30)",
    fill: "start",
    yAxisID: "yElevation",
    pointRadius: 0,
    borderWidth: 1,
    tension: 0.1,
  };
}

// 肝グリコーゲンを「満タンに対する %」にする（Phase 6-5、2026-09-23）。
// 容量（liver_capacity_kcal）は tozan/derived.py が体表面積から計算して返す。
function liverCapacity() {
  const cap = currentSummary && currentSummary.liver_capacity_kcal;
  return cap && cap > 0 ? cap : 0;
}

function liverPercent(s) {
  const cap = liverCapacity();
  if (!cap) return s.glycogen_liver_kcal.map(() => null);
  return s.glycogen_liver_kcal.map((v) => (v == null ? null : 100 * v / cap));
}

// 大腿も満タン比（%）で描く。kcal のままだと容量が全身の半分ほどで、
// グラフの下のほうを這って読めない（作者の指摘・2026-09-25）。
function thighCapacity() {
  const cap = currentSummary && currentSummary.glycogen_A_capacity_kcal;
  return cap && cap > 0 ? cap : 0;
}

function thighPercent(s) {
  const cap = thighCapacity();
  if (!cap) return s.glycogen_A_kcal.map(() => null);
  return s.glycogen_A_kcal.map((v) => (v == null ? null : 100 * v / cap));
}

function makeLineChart(canvasId, datasets, yTitle, extraScales, legendCount) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  const shown = legendCount != null ? legendCount : datasets.length;
  return new Chart(ctx, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      spanGaps: false,
      elements: { point: { radius: 0 }, line: { borderWidth: 2 } },
      scales: Object.assign({
        x: {
          type: "linear",
          title: { display: true, text: "経過時間" },
          ticks: { callback: formatHM },
        },
        y: { title: { display: !!yTitle, text: yTitle } },
        yElevation: {
          position: "right",
          title: { display: true, text: "標高 [m]" },
          grid: { drawOnChartArea: false },
          // 富士山を除けば国内の登山道はここまで（依頼者指定・2026-09-19）。
          // 日ごとの自動スケーリングをやめ、グラフ間で標高の見た目の比率を揃える。
          min: 0, max: 3200,
        },
      }, extraScales || {}),
      plugins: {
        // データセットが tooltipFormat を持つときだけ独自の書式にする。
        // 持たないものは Chart.js の既定（"ラベル: 値"）と同じ文字列を返す。
        tooltip: {
          callbacks: {
            label: (ctx) => (typeof ctx.dataset.tooltipFormat === "function"
              ? ctx.dataset.tooltipFormat(ctx.parsed.y)
              : `${ctx.dataset.label}: ${ctx.formattedValue}`),
          },
        },
        legend: {
          display: shown > 1,
          // グラフ外に凡例を置くとその分プロット部分の縦幅が縮むため、
          // グラフ内左上に重ねて表示する（依頼者指定・2026-09-19）。
          position: "chartArea",
          align: "start",
          labels: {
            filter: (item) => item.text !== "標高",
            // 既定は中抜きの□。データセットと同じ線で示す。
            usePointStyle: true,
            pointStyle: "line",
          },
        },
      },
    },
  });
}

function buildDayTabs(days) {
  if (days.length <= 1) {
    dayTabsEl.hidden = true;
    dayTabsEl.innerHTML = "";
    return;
  }
  dayTabsEl.hidden = false;
  dayTabsEl.innerHTML = days.map((d, i) =>
    `<button type="button" data-day="${i}" class="${i === 0 ? "active" : ""}">`
    + `${d.date ?? `${i + 1}日目`}</button>`).join("");
  dayTabsEl.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      dayTabsEl.querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      showDay(parseInt(btn.dataset.day, 10));
    });
  });
}

function renderDayStats(dayIndex) {
  const d = currentSummary.days[dayIndex];
  dayStatsEl.hidden = false;
  // 2行3列（左上→右下の順）。作者指定・2026-09-22、実機確認のフィードバック。
  dayStatsEl.innerHTML = `
    <div class="day-stat"><span class="day-stat-label">行動時間(TOTAL)</span>`
      + `<span class="day-stat-value">${formatHoursJa(d.duration_h)}</span></div>
    <div class="day-stat"><span class="day-stat-label">休憩時間</span>`
      + `<span class="day-stat-value">${formatHoursJa(d.rest_h)}</span></div>
    <div class="day-stat"><span class="day-stat-label">移動距離</span>`
      + `<span class="day-stat-value">${d.distance_km.toFixed(1)} km</span></div>
    <div class="day-stat"><span class="day-stat-label">消費カロリー</span>`
      + `<span class="day-stat-value consume">${d.kcal.toFixed(0)} kcal</span></div>
    <div class="day-stat"><span class="day-stat-label">発汗量</span>`
      + `<span class="day-stat-value supply">${d.sweat_kg.toFixed(2)} L</span></div>
    <div class="day-stat"><span class="day-stat-label">累積標高</span>`
      + `<span class="day-stat-value day-stat-value-elev">↑${d.up_m.toFixed(0)}m<br>↓${d.down_m.toFixed(0)}m</span></div>`;
}

// tozan/derived.py の waypoint_table() が返す地点ごとの表（計画モード、2026-10-02）。
// 地点名のある GPX（Yamareco の計画など）でだけ出す。到着時刻はその日の出発時刻に
// モデルの時間を足したもので、GPX に書いてある計画の通過時刻ではない。
// 「出発から」と「区間」の切り替え（作者の要望・2026-10-02）。既定は「出発から」。選んだほうを覚えておく。
const WAYPOINT_MODE_KEY = "tozan_waypoint_mode_v1";
let waypointMode = "cum";
try { if (localStorage.getItem(WAYPOINT_MODE_KEY) === "leg") waypointMode = "leg"; } catch (e) { /* 使えなければ出発からのまま */ }
let waypointDay = 0;

function renderWaypoints(dayIndex) {
  waypointDay = dayIndex;
  const day = currentWaypoints && currentWaypoints.days[dayIndex];
  if (!day || !day.rows.some(r => r.kind === "point")) {
    waypointsEl.hidden = true;
    waypointsEl.innerHTML = "";
    return;
  }
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const label = r => r.name ? esc(r.name) : (r.kind === "start" ? "出発地点" : "到着地点");
  const cum = waypointMode === "cum";
  const basis = cum ? "出発から" : "前の地点から";
  let html = `<h2>地点ごとの予定</h2>`
    + `<div class="wp-mode" role="group" aria-label="表示の切り替え">`
    + `<button type="button" data-mode="cum" class="${cum ? "active" : ""}" aria-pressed="${cum}">出発から</button>`
    + `<button type="button" data-mode="leg" class="${cum ? "" : "active"}" aria-pressed="${!cum}">区間</button></div>`
    + `<span class="wp-basis">時間・距離・登り下り・消費・汗は${basis}の値</span>`
    + `<div class="table-scroll"><table class="daily-table waypoint-table"><tr>`
    + `<th class="wp-name">地点</th><th>到着</th><th>時間</th>`
    + `<th>距離<br><span class="unit">(km)</span></th>`
    + `<th>登り／下り<br><span class="unit">(m)</span></th>`
    + `<th>消費<br><span class="unit">(kcal)</span></th>`
    + `<th>汗<br><span class="unit">(L)</span></th></tr>`;
  for (const r of day.rows) {
    const start = r.kind === "start";
    const h = cum ? r.arrival_h : r.leg_h;
    const km = cum ? r.cum_km : r.leg_km;
    const up = cum ? r.cum_up_m : r.leg_up_m;
    const down = cum ? r.cum_down_m : r.leg_down_m;
    const kcal = cum ? r.cum_kcal : r.leg_kcal;
    const sweat = cum ? r.sweat_kg_cum : r.leg_sweat_kg;
    html += `<tr class="${start ? "wp-start" : ""}"><td class="wp-name">${label(r)}</td>`
      + `<td class="num">${r.arrival_clock ?? formatHM(r.arrival_h)}${start ? " 発" : ""}</td>`
      + `<td class="num">${start ? "" : formatHM(h)}</td>`
      + `<td class="num">${start ? "" : km.toFixed(2)}</td>`
      + `<td class="num">${start ? "" : `+${up.toFixed(0)} / −${down.toFixed(0)}`}</td>`
      + `<td class="num consume">${start ? "" : kcal.toFixed(0)}</td>`
      + `<td class="num supply">${start ? "" : sweat.toFixed(2)}</td></tr>`;
  }
  html += `</table></div>`
    + `<p class="wp-note">到着時刻は出発時刻にモデルの時間を足したものです（GPX の計画の時刻ではありません）。`
    + `時間は途中の補給の休憩を含みます。距離は水平距離です。</p>`;
  waypointsEl.innerHTML = html;
  waypointsEl.hidden = false;
  waypointsEl.querySelectorAll(".wp-mode button").forEach(btn => {
    btn.addEventListener("click", () => {
      waypointMode = btn.dataset.mode;
      try { localStorage.setItem(WAYPOINT_MODE_KEY, waypointMode); } catch (e) { /* 保存できなくても表示は切り替える */ }
      renderWaypoints(waypointDay);
    });
  });
}

function showDay(dayIndex) {
  const s = currentSeries.days[dayIndex];
  renderDayStats(dayIndex);
  renderWaypoints(dayIndex);
  destroyCharts();

  // 標高を灰色の背景として敷き、右側の第2軸に目盛りを出す（YAMAP 風）。
  charts.hr = makeLineChart("chartHr",
    [
      elevationBackdrop(s),
      { label: "心拍", data: toPoints(s.elapsed_h, s.hr_bpm), borderColor: "#D9584F" },
    ],
    null,
    // 心拍数の生理的な範囲で固定（依頼者指定・2026-09-19）。
    { y: { title: { display: true, text: "心拍 [bpm]" }, min: 50, max: 200 } }, 1);

  charts.pace = makeLineChart("chartPace",
    [
      elevationBackdrop(s),
      { label: "スピード", data: toPoints(s.elapsed_h, s.pace_min_per_km), borderColor: "#63A6A0" },
    ],
    null,
    // 相対速度(%)表示（2026-09-19）から分/km表示に戻した（依頼者指定・2026-09-20）。
    { y: { title: { display: true, text: "ペース [分/km]" }, min: 0, max: 50 } }, 1);

  // エネルギー消費量・発汗量のグラフは削除（作者指定・2026-09-22、実機確認の
  // フィードバック。最終値は day-stats に表示済みなのでグラフは不要）。

  charts.glycogen = makeLineChart("chartGlycogen",
    [
      elevationBackdrop(s),
      // 部位別（A/B/C）は表示しない。全身合計と肝臓のみ（依頼者指定・2026-09-19、
      // 肝臓は2026-09-22追加。しゃりばては肝が空になることで起きるため）。
      { label: "全身", data: toPoints(s.elapsed_h, s.glycogen_kcal),
        borderColor: "#E98450", borderWidth: 3, yAxisID: "y" },
      // 大腿（部位A）。急登でも下りでも最初に減る部位で、多くの場合ここを見れば
      // よい（作者の観察。docs/06_ Phase 4b-3）。肝と同じく満タン比の右軸に乗せる。
      { label: "大腿", data: toPoints(s.elapsed_h, thighPercent(s)),
        borderColor: "#9B8CC7", borderWidth: 2, yAxisID: "y1",
        tooltipFormat: (v) => `大腿: ${v.toFixed(0)}%（${Math.round(v / 100 * thighCapacity())} kcal）` },
      // 肝臓は容量が全身（約3600kcal）とは桁が違うため、右の第2軸に置く。
      // しゃりばて（Phase 4b-2）は肝が空になったときに起きるので、ゼロに近づく
      // 様子がグラフの高さいっぱいで読めるようにする（作者指定・2026-09-22）。
      // 軸は kcal ではなく容量に対する % にする（Phase 6-5、2026-09-23）。肝の容量は
      // 体表面積から決まり体格で変わる（作者 343 kcal、小柄な人は 278 kcal）ので、
      // 「残り何割か」＝しゃりばてまでの余裕を、誰が見ても同じ読み方にする。
      { label: "肝臓", data: toPoints(s.elapsed_h, liverPercent(s)),
        borderColor: "#63A6A0", borderWidth: 2, yAxisID: "y1",
        tooltipFormat: (v) => `肝臓: ${v.toFixed(0)}%（${Math.round(v / 100 * liverCapacity())} kcal）` },
    ],
    null,
    {
      // 左の軸の上限は全身の容量（体重・体脂肪率から決まる。tozan/derived.py の
      // plan_summary が返す glycogen_capacity_kcal）に合わせて切り上げる。
      // 以前は旧仕様の1800kcal固定容量を前提に2000で固定していた（Phase 4b-0でUI側が
      // 追従していなかった分。2026-09-22）。
      y: { position: "left", title: { display: true, text: "全身 [kcal]" }, min: 0,
           max: Math.ceil(currentSummary.glycogen_capacity_kcal / 500) * 500 },
      y1: { position: "right", title: { display: true, text: "肝臓・大腿 [% 満タン比]" },
            grid: { drawOnChartArea: false },
            min: 0, max: 100 },
      // このグラフだけ軸が3本になりプロット部分が他グラフより狭くなるため、
      // 標高軸は目盛り非表示にする（背景の塗りつぶし自体は残す。旧エネルギー
      // グラフと同じ扱い・依頼者指定 2026-09-19）。
      yElevation: { display: false, min: 0, max: 3200 },
    }, 3);

  charts.efficiency = makeLineChart("chartEfficiency",
    [
      elevationBackdrop(s),
      { label: "筋効率", data: toPoints(s.elapsed_h, s.muscle_eff), borderColor: "#63A6A0" },
    ],
    null,
    // efficiency_up/down の既定値0.25が理論上の最大（依頼者指定・2026-09-19）。
    { y: { title: { display: true, text: "筋効率" }, min: 0, max: 0.25 } }, 1);
}

// ---------------- 補給計画（Step 5-5） ----------------
// tozan/derived.py の supply_plan() が返す値をそのまま表示する。
// 補給タイミング・閾値判定の計算はすべて Python 側で済んでいる。

function dayLabel(days, dayIndex) {
  const d = days[dayIndex];
  return (d && d.date) ? shortDate(d.date) : `${dayIndex + 1}日目`;
}

function fmtDist(km) { return km == null ? "-" : `${km.toFixed(1)} km`; }
function fmtEle(m) { return m == null ? "-" : `${m.toFixed(0)} m`; }

// tozan/local_glycogen.py の部位分配（A=大腿、B=下腿、C=体幹・腕）に対応する表示名。
const MUSCLE_PART_NAMES = { A: "大腿", B: "下腿", C: "体幹・腕" };
function musclePartName(which) { return MUSCLE_PART_NAMES[which] ?? which; }

function renderSupplyPlan(plan, days) {
  let html = `<h2>補給計画</h2>`;

  if (plan.warnings.length) {
    html += `<div class="warning-box"><b>グリコーゲン枯渇の警告</b><ul>`;
    for (const w of plan.warnings) {
      html += `<li>${dayLabel(days, w.day)} 出発${formatHM(w.elapsed_h)}後`
            + `（${fmtDist(w.distance_km)} / 標高${fmtEle(w.elevation_m)}）: `
            + `${musclePartName(w.which)}のグリコーゲンが残り${(w.ratio * 100).toFixed(0)}%まで低下</li>`;
    }
    html += `</ul></div>`;
  }

  // しゃりばて（肝が空かつ吸収なし。Phase 4b-2）の発火地点。上の警告（筋の
  // グリコーゲン枯渇）とは別の現象なので別枠で示す。
  if (plan.hypoglycemic && plan.hypoglycemic.length) {
    html += `<div class="warning-box"><b>しゃりばての警告</b><ul>`;
    for (const h of plan.hypoglycemic) {
      html += `<li>${dayLabel(days, h.day)} 出発${formatHM(h.elapsed_h)}後`
            + `（${fmtDist(h.distance_km)} / 標高${fmtEle(h.elevation_m)}）: `
            + `血糖の供給源が尽き、出せる力が大きく落ちています。補給が必要です</li>`;
    }
    html += `</ul></div>`;
  }

  // 個々の補給タイミングではなく、1日ごとの合計だけを表示する
  // （依頼者指定・2026-09-19）。
  if (plan.daily.length) {
    html += `<div class="table-scroll"><table class="supply-table"><tr><th>日</th>`
          + `<th>Glycogen<br><span class="unit">(kcal)</span></th>`
          + `<th>脂肪燃焼<br><span class="unit">(kcal)</span></th>`
          + `<th>行動食<br><span class="unit">(kcal)</span></th>`
          + `<th>まとまった補給<br><span class="unit">(kcal)</span></th></tr>`;
    for (const d of plan.daily) {
      html += `<tr><td>${dayLabel(days, d.day)}</td>`
            + `<td class="num consume">${d.glycogen_consumed_kcal.toFixed(0)}</td>`
            + `<td class="num consume">${d.fat_burned_kcal.toFixed(0)}</td>`
            + `<td class="num supply">${d.periodic_food_kcal.toFixed(0)}</td>`
            + `<td class="num supply">${d.meal_food_kcal.toFixed(0)}</td></tr>`;
    }
    html += `</table></div>`;
  } else {
    html += `<p class="hint">このルートでは行動食の補給タイミングがありません。</p>`;
  }

  // まとまった補給（休憩つき。Phase 4b-2）の個々の地点。歩行 meal_interval_minutes
  // ごとに立ち止まって meal_kcal を食べる計画そのものなので、「どこで食べるか」を
  // 一覧で示す（山頂での決め打ちをやめた代わりに、地点をここで提示する）。
  const meals = plan.supplies.filter(s => s.kind === "meal");
  if (meals.length) {
    html += `<h3>まとまった補給の地点</h3>`
          + `<div class="table-scroll"><table class="supply-table"><tr><th>日</th>`
          + `<th>経過時間</th><th>距離</th><th>標高</th>`
          + `<th>補給量<br><span class="unit">(kcal)</span></th></tr>`;
    for (const m of meals) {
      html += `<tr><td>${dayLabel(days, m.day)}</td>`
            + `<td>${formatHM(m.elapsed_h)}</td>`
            + `<td class="num">${fmtDist(m.distance_km)}</td>`
            + `<td class="num">${fmtEle(m.elevation_m)}</td>`
            + `<td class="num supply">${m.kcal.toFixed(0)}</td></tr>`;
    }
    html += `</table></div>`;
  }

  html += `<p class="hint">補給タイミング・警告の閾値は仮の計算式です。`
        + `モデル作成者が式を確定したら精度が上がります。</p>`;

  supplyPlanEl.innerHTML = html;
}

boot();
