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

const statusEl = document.getElementById("status");
const outEl = document.getElementById("out");
const fileEl = document.getElementById("gpxFile");
const runBtn = document.getElementById("run");
const resetBtn = document.getElementById("resetParams");
const userFieldsEl = document.getElementById("userFields");
const advancedFieldsEl = document.getElementById("advancedFields");
const dayTabsEl = document.getElementById("dayTabs");
const dayStatsEl = document.getElementById("dayStats");
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
from tozan.derived import plan_summary, supply_plan, ui_series
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

def run_simulation_from_form(gpx_text, form_values_json):
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

    errors = validate_params(params)
    if errors:
        return json.dumps({"ok": False, "errors": [_split_error(e) for e in errors]})

    result = simulate(route, params)
    summary = plan_summary(result, params)
    series = ui_series(result, pace_smooth_window=5)
    plan = supply_plan(result, params)
    return json.dumps({"ok": True, "result": result.to_dict(), "summary": summary,
                        "series": series, "plan": plan})
`;

let pyodide = null;
let runSimulationFromForm = null;
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

    const formSpecFn = pyodide.globals.get("form_spec_json");
    formFields = JSON.parse(formSpecFn());
    formSpecFn.destroy();

    buildForm(formFields);
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
  { value: 70, label: "速い" },
  { value: 60, label: "やや速い" },
  { value: 50, label: "普通" },
  { value: 45, label: "のんびり" },
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
  const desc = spec.description_ja ? `<div class="desc">${spec.description_ja}</div>` : "";
  return `<div class="${cls}" data-field="${spec.key}">`
       + fieldInputHtml(spec)
       + desc
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

function resetFormToDefaults() {
  for (const spec of formFields) {
    const el = document.getElementById(`f_${spec.key}`);
    if (!el) continue;
    if (spec.type === "boolean") el.checked = !!spec.default;
    else el.value = spec.default;
  }
  clearFieldErrors();
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
}

document.addEventListener("input", (e) => {
  if (e.target.closest("#userFields, #advancedFields")) saveFormValues();
});
document.addEventListener("change", (e) => {
  if (e.target.closest("#userFields, #advancedFields")) saveFormValues();
});

resetBtn.addEventListener("click", resetFormToDefaults);

fileEl.addEventListener("change", () => {
  runBtn.disabled = !fileEl.files.length;
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
    const formValues = collectFormValues();
    const t0 = performance.now();
    const responseJson = runSimulationFromForm(gpxText, JSON.stringify(formValues));
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
      supplyPlanEl.innerHTML = "";
    } else {
      render(response.summary, file.name, elapsedMs);
      currentSeries = response.series;
      currentSummary = response.summary;
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
    supplyPlanEl.innerHTML = "";
  } finally {
    runBtn.disabled = false;
    fileEl.disabled = false;
  }
});

function summaryCard(label, value, cls) {
  return `<div class="stat-card"><span class="stat-label">${label}</span>`
       + `<span class="stat-value${cls ? " " + cls : ""}">${value}</span></div>`;
}

// tozan/derived.py の plan_summary() が返す集計値をそのまま表示する。
// 単位換算・合計計算はすべて Python 側で済んでいる。
function render(summary, fileName) {
  const days = summary.days;
  const total = summary.total;
  let html = `<h2>${fileName} の結果</h2>`;

  html += `<div class="summary-grid">`;
  html += summaryCard("所要時間", `${total.duration_h.toFixed(2)} h`);
  html += summaryCard("距離", `${total.distance_km.toFixed(1)} km`);
  html += summaryCard("累積標高", `↑${total.up_m.toFixed(0)} / ↓${total.down_m.toFixed(0)} m`);
  html += summaryCard("消費エネルギー", `${total.kcal.toFixed(0)} kcal`, "consume");
  html += summaryCard("発汗量", `${total.sweat_kg.toFixed(2)} kg`, "supply");
  html += summaryCard("必要な水（目安）", `${total.water_L.toFixed(2)} L`, "supply");
  html += summaryCard("必要な行動食（目安）", `${total.action_food_kcal.toFixed(0)} kcal`, "consume");
  html += `<div class="stat-card stat-card-empty"></div>`;
  html += `</div>`;

  if (days.length > 1) {
    html += `<h3>日別内訳</h3>`;
    html += `<div class="table-scroll"><table class="daily-table"><tr><th>日</th>`
          + `<th>距離<br><span class="unit">(km)</span></th>`
          + `<th>登り<br><span class="unit">(m)</span></th>`
          + `<th>下り<br><span class="unit">(m)</span></th>`
          + `<th>所要時間<br><span class="unit">(h)</span></th>`
          + `<th>消費<br><span class="unit">(kcal)</span></th>`
          + `<th>発汗<br><span class="unit">(kg)</span></th></tr>`;
    for (const d of days) {
      html += `<tr><td>${shortDate(d.date)}</td>`
            + `<td class="num">${d.distance_km.toFixed(1)}</td>`
            + `<td class="num">${d.up_m.toFixed(0)}</td>`
            + `<td class="num">${d.down_m.toFixed(0)}</td>`
            + `<td class="num">${d.duration_h.toFixed(2)}</td>`
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

function toPoints(xs, ys) {
  return xs.map((x, i) => ({ x, y: ys[i] }));
}

// 結果画面モックアップ（消費エネルギーのエリアチャート）に合わせた、
// アクセントカラーが上から下へ透明に抜けるグラデーション塗り。
// Chart.js のスクリプタブルオプションとして dataset.backgroundColor に渡す。
function accentAreaFill(ctx) {
  const { chart } = ctx;
  const { chartArea } = chart;
  if (!chartArea) return "rgba(233, 132, 80, 0.25)";
  const gradient = chart.ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  gradient.addColorStop(0, "rgba(233, 132, 80, 0.35)");
  gradient.addColorStop(1, "rgba(233, 132, 80, 0)");
  return gradient;
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
  dayStatsEl.innerHTML = `
    <div class="day-stat"><span class="day-stat-label">行動時間</span>`
      + `<span class="day-stat-value">${d.duration_h.toFixed(2)} h</span></div>
    <div class="day-stat"><span class="day-stat-label">消費エネルギー</span>`
      + `<span class="day-stat-value consume">${d.kcal.toFixed(0)} kcal</span></div>
    <div class="day-stat"><span class="day-stat-label">発汗量</span>`
      + `<span class="day-stat-value supply">${d.sweat_kg.toFixed(2)} L</span></div>`;
}

function showDay(dayIndex) {
  const s = currentSeries.days[dayIndex];
  renderDayStats(dayIndex);
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
      { label: "スピード", data: toPoints(s.elapsed_h, s.speed_pct), borderColor: "#63A6A0" },
    ],
    null,
    // 30分/kmを100%とした相対速度（依頼者指定・2026-09-19、tozan/derived.py 参照）。
    // 50%刻みの目盛りにして、基準の100%がそのまま目盛り線として見えるようにする。
    { y: { title: { display: true, text: "スピード [%]" }, min: 0, max: 250,
           ticks: { stepSize: 50 } } }, 1);

  charts.energy = makeLineChart("chartEnergy",
    [
      elevationBackdrop(s),
      { label: "消費エネルギー(累積)", data: toPoints(s.elapsed_h, s.energy_kcal_cum),
        borderColor: "#E98450", backgroundColor: accentAreaFill, fill: "start", yAxisID: "y" },
      { label: "発汗量(累積)", data: toPoints(s.elapsed_h, s.sweat_L_cum),
        borderColor: "#63A6A0", borderDash: [2, 3], yAxisID: "y1" },
    ],
    null,
    {
      // 1日の行動時間・強度に対して十分な上限を固定（依頼者指定・2026-09-19）。
      y: { position: "left", title: { display: true, text: "消費エネルギー [kcal]" }, min: 0, max: 5000 },
      y1: { position: "right", title: { display: true, text: "発汗量 [L]" }, grid: { drawOnChartArea: false },
            min: 0, max: 5 },
      // このグラフだけ軸が3本になりプロット部分が他グラフより狭くなるため、
      // 標高軸は目盛り非表示にする（背景の塗りつぶし自体は残す・依頼者指定 2026-09-19）。
      yElevation: { display: false, min: 0, max: 3200 },
    }, 2);

  charts.glycogen = makeLineChart("chartGlycogen",
    [
      elevationBackdrop(s),
      // 部位別（A/B/C）は表示しない。全身合計のみ（依頼者指定・2026-09-19）。
      { label: "全身", data: toPoints(s.elapsed_h, s.glycogen_kcal),
        borderColor: "#E98450", borderWidth: 3 },
    ],
    null,
    // 現行モデルの最大値（約1800kcal）に対して固定（依頼者指定・2026-09-19）。
    { y: { title: { display: true, text: "グリコーゲン [kcal]" }, min: 0, max: 2000 } }, 1);

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

  // 個々の補給タイミングではなく、1日ごとの合計だけを表示する
  // （依頼者指定・2026-09-19）。
  if (plan.daily.length) {
    html += `<div class="table-scroll"><table class="supply-table"><tr><th>日</th>`
          + `<th>Glycogen<br><span class="unit">(kcal)</span></th>`
          + `<th>脂肪燃焼<br><span class="unit">(kcal)</span></th>`
          + `<th>行動食<br><span class="unit">(kcal)</span></th>`
          + `<th>山頂補給<br><span class="unit">(kcal)</span></th></tr>`;
    for (const d of plan.daily) {
      html += `<tr><td>${dayLabel(days, d.day)}</td>`
            + `<td class="num consume">${d.glycogen_consumed_kcal.toFixed(0)}</td>`
            + `<td class="num consume">${d.fat_burned_kcal.toFixed(0)}</td>`
            + `<td class="num supply">${d.periodic_food_kcal.toFixed(0)}</td>`
            + `<td class="num supply">${d.peak_food_kcal.toFixed(0)}</td></tr>`;
    }
    html += `</table></div>`;
  } else {
    html += `<p class="hint">このルートでは行動食の補給タイミングがありません。</p>`;
  }

  html += `<p class="hint">補給タイミング・警告の閾値は仮の計算式です。`
        + `モデル作成者が式を確定したら精度が上がります。</p>`;

  supplyPlanEl.innerHTML = html;
}

boot();
