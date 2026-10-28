// Inline SVG charts rendered from report.json. No dependencies, no raster assets.

const MUTED = "#5f5f5f";
const GRID = "#ededed";
const RULE = "#bfbfbf";
const NAVY = "#741633";
const QUIET = "#bfbfbf";
const RAMP = ["#e9ccd5", "#c98a9e", "#9e4462", "#741633"];
let serial = 0;

const esc = (value) =>
  String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);

function ticks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const rough = (max - min) / count;
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / power;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * power;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const out = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

function legend(items) {
  return `<div class="plot-legend">${items
    .map(
      (item) =>
        `<span class="key"><i style="background:${item.color}"${
          item.dash ? ' class="dash"' : ""
        }></i>${esc(item.label)}</span>`
    )
    .join("")}</div>`;
}

function lines(cfg) {
  const id = `clip${(serial += 1)}`;
  const w = cfg.width || 460;
  const h = cfg.height || 272;
  const pad = { l: 54, r: cfg.direct ? 56 : 22, t: 16, b: 58 };
  const xs = cfg.series.flatMap((s) => s.points.map((p) => p[0]));
  const ys = cfg.series.flatMap((s) => s.points.map((p) => p[1]));
  const xTicks = cfg.xTicks || ticks(Math.min(...xs), Math.max(...xs), 5);
  const yTicks = cfg.yTicks || ticks(Math.min(0, ...ys), Math.max(...ys), 4);
  const x0 = cfg.xMin ?? xTicks[0];
  const x1 = cfg.xMax ?? xTicks[xTicks.length - 1];
  const y0 = cfg.yMin ?? yTicks[0];
  const y1 = cfg.yMax ?? yTicks[yTicks.length - 1];
  const left = pad.l;
  const right = w - pad.r;
  const bottom = h - pad.b;
  const px = (v) => left + ((v - x0) / (x1 - x0 || 1)) * (right - left);
  const py = (v) => bottom - ((v - y0) / (y1 - y0 || 1)) * (bottom - pad.t);
  const fy = cfg.yFmt || ((v) => v.toFixed(2));
  const fx = cfg.xFmt || ((v) => (Number.isInteger(v) ? String(v) : v.toFixed(2)));

  const grid = yTicks
    .map(
      (v) =>
        `<line x1="${left}" x2="${right}" y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(
          1
        )}" stroke="${Math.abs(v) < 1e-9 ? RULE : GRID}"/><text x="${left - 8}" y="${(
          py(v) + 3.5
        ).toFixed(1)}" text-anchor="end">${fy(v)}</text>`
    )
    .join("");

  const xtickMarks = xTicks
    .map((v) => `<text x="${px(v).toFixed(1)}" y="${bottom + 18}" text-anchor="middle">${fx(v)}</text>`)
    .join("");

  const clipId = `${id}`;
  const paths = cfg.series
    .map((s) => {
      const pts = s.points
        .filter(([x]) => x >= x0 - 1e-9 && x <= x1 + 1e-9)
        .map(([x, y]) => `${px(x).toFixed(1)},${py(Math.max(y0 - 0.02, Math.min(y1 + 0.02, y))).toFixed(1)}`)
        .join(" ");
      const line = `<polyline points="${pts}" fill="none" stroke="${s.color || NAVY}" stroke-width="${
        s.width || 2
      }" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`;
      const dots = (s.dots || [])
        .map(
          ([x, y]) =>
            `<circle cx="${px(x).toFixed(1)}" cy="${py(y).toFixed(1)}" r="2.7" fill="#fff" stroke="${
              s.color || NAVY
            }" stroke-width="1.5"/>`
        )
        .join("");
      return line + dots;
    })
    .join("");

  const directLabels = cfg.direct
    ? cfg.series
        .filter((s) => s.points.length)
        .map((s) => {
          const last = s.points[s.points.length - 1];
          return `<text x="${(px(last[0]) + 8).toFixed(1)}" y="${(py(last[1]) + 3.6).toFixed(
            1
          )}" fill="${s.color || NAVY}" class="direct">${esc(s.label || s.name)}</text>`;
        })
        .join("")
    : "";

  const guide =
    cfg.guide == null
      ? ""
      : `<line x1="${px(cfg.guide).toFixed(1)}" x2="${px(cfg.guide).toFixed(1)}" y1="${pad.t}" y2="${bottom}" stroke="#1f1f1f" stroke-width="1" stroke-dasharray="3 3"/><text x="${Math.min(Math.max(px(cfg.guide), left + 40), right - 40).toFixed(
          1
        )}" y="${pad.t + 10}" text-anchor="middle" fill="#1f1f1f" class="guide">${esc(
          cfg.guideLabel || ""
        )}</text>`;

  const axis = `<line x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}" stroke="${RULE}"/>`;
  const yTitle = `<text transform="translate(13 ${((pad.t + bottom) / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" class="axis-title">${esc(
    cfg.yLabel || ""
  )}</text>`;
  const xTitle = `<text x="${((left + right) / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle" class="axis-title">${esc(
    cfg.xLabel || ""
  )}</text>`;

  return `${cfg.legendHtml || ""}<svg class="plot" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(
    cfg.title || "chart"
  )}" shape-rendering="geometricPrecision"><defs><clipPath id="${clipId}"><rect x="${left}" y="${pad.t}" width="${
    right - left
  }" height="${bottom - pad.t}"/></clipPath></defs><g class="axis">${grid}${xtickMarks}</g>${axis}${guide}<g clip-path="url(#${clipId})">${paths}</g>${yTitle}${xTitle}${directLabels}</svg>`;
}

function bars(items, cfg = {}) {
  const w = 460;
  const rowH = 32;
  const left = 116;
  const right = w - 44;
  const top = 12;
  const height = items.length * rowH + top + 40;
  const bottom = items.length * rowH + top;
  const span = right - left;

  const grid = [0, 0.5, 1]
    .map(
      (v) =>
        `<line x1="${(left + v * span).toFixed(1)}" x2="${(left + v * span).toFixed(1)}" y1="${
          top - 6
        }" y2="${bottom}" stroke="${v === 0 ? RULE : GRID}"/><text x="${(left + v * span).toFixed(1)}" y="${
          bottom + 18
        }" text-anchor="middle">${v.toFixed(1)}</text>`
    )
    .join("");

  const rows = items
    .map((item, index) => {
      const y = top + index * rowH;
      const len = Math.max((item.value / 1) * span, 1.5);
      const band =
        item.lo == null
          ? ""
          : `<line x1="${(left + item.lo * span).toFixed(1)}" x2="${(left + item.hi * span).toFixed(1)}" y1="${
              y + 7
            }" y2="${y + 7}" stroke="${MUTED}" stroke-width="1" stroke-opacity="0.6"/><line x1="${
              (left + item.lo * span).toFixed(1)
            }" x2="${(left + item.lo * span).toFixed(1)}" y1="${y + 3}" y2="${
              y + 11
            }" stroke="${MUTED}" stroke-width="1" stroke-opacity="0.6"/><line x1="${
              (left + item.hi * span).toFixed(1)
            }" x2="${(left + item.hi * span).toFixed(1)}" y1="${y + 3}" y2="${
              y + 11
            }" stroke="${MUTED}" stroke-width="1" stroke-opacity="0.6"/>`;
      return `<text x="${left - 10}" y="${y + 11}" text-anchor="end">${esc(item.label)}</text>${band}<rect x="${left}" y="${y}" width="${len.toFixed(
        1
      )}" height="14" rx="2" fill="${item.color || NAVY}"${item.muted ? ' fill-opacity="0.5"' : ""}/><text x="${
        right + 4
      }" y="${y + 11}" class="value">${item.value.toFixed(3)}</text>`;
    })
    .join("");

  return `<svg class="plot" viewBox="0 0 ${w} ${height}" role="img" aria-label="${esc(
    cfg.title || "chart"
  )}" shape-rendering="geometricPrecision"><g class="axis">${grid}${rows}</g><line x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}" stroke="${RULE}"/></svg>`;
}

export function modelComparisonChart(report) {
  const rows = Object.entries(report.evaluation)
    .filter(([, value]) => value && typeof value.pr_auc === "number")
    .map(([name, value]) => ({
      label: name.replace(/_/g, " "),
      value: value.pr_auc,
      lo: Array.isArray(value.pr_auc_bootstrap_95pct) ? value.pr_auc_bootstrap_95pct[0] : null,
      hi: Array.isArray(value.pr_auc_bootstrap_95pct) ? value.pr_auc_bootstrap_95pct[1] : null,
      color: name === "logistic_regression" ? NAVY : QUIET,
      muted: name !== "logistic_regression" && name !== "prevalence",
    }))
    .sort((a, b) => b.value - a.value);
  return bars(rows, { title: "holdout average precision" });
}

export function calibrationChart(report) {
  const buckets = report.calibration;
  return lines({
    title: "calibration",
    xMin: 0,
    xMax: 1,
    yMin: 0,
    yMax: 1,
    xTicks: [0, 0.25, 0.5, 0.75, 1],
    yTicks: [0, 0.25, 0.5, 0.75, 1],
    yLabel: "observed churn",
    xLabel: "mean predicted risk",
    legendHtml: legend([
      { label: "observed", color: NAVY },
      { label: "perfect calibration", color: "#bfbfbf", dash: true },
    ]),
    series: [
      { name: "perfect", color: "#bfbfbf", width: 1.2, dash: "5 5", points: [[0, 0], [1, 1]] },
      {
        name: "observed",
        color: NAVY,
        points: buckets.map((b) => [b.mean_score, b.observed_rate]),
        dots: buckets.map((b) => [b.mean_score, b.observed_rate]),
      },
    ],
  });
}

export function sensitivityChart(report) {
  const sensitivity = report.economics.sensitivity;
  const values = [...new Set(sensitivity.rows.map((row) => row.retained_value))].sort((a, b) => a - b);
  return lines({
    title: "break-even sensitivity",
    direct: true,
    guide: sensitivity.breakeven_multiplier,
    guideLabel: `break-even ${sensitivity.breakeven_multiplier ?? "n/a"}×`,
    xLabelPad: true,
    yLabel: "net benefit · IDR M",
    xLabel: "success-rate multiplier",
    yFmt: (v) => v.toFixed(0),
    xFmt: (v) => `${v}×`,
    series: values.map((value, index) => ({
      name: `${value / 1e6}M`,
      label: `${value / 1e6}M`,
      color: RAMP[index % RAMP.length],
      points: sensitivity.rows
        .filter((row) => row.retained_value === value)
        .sort((a, b) => a.success_multiplier - b.success_multiplier)
        .map((row) => [row.success_multiplier, row.net_benefit / 1e6]),
    })),
  });
}

export function decisionChart(report) {
  const curve = report.economics.decision_curve.filter((row) => row.threshold <= 0.6);
  return lines({
    title: "net benefit versus threshold",
    xMin: 0.1,
    xMax: 0.6,
    yMin: -0.12,
    yMax: 0.2,
    xTicks: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    yTicks: [-0.1, 0, 0.1, 0.2],
    yLabel: "net benefit per customer",
    xLabel: "threshold probability",
    yFmt: (v) => v.toFixed(1),
    xFmt: (v) => v.toFixed(1),
    legendHtml: legend([
      { label: "model", color: NAVY },
      { label: "treat all", color: QUIET, dash: true },
      { label: "treat none", color: "#bfbfbf", dash: true },
    ]),
    series: [
      { name: "model", color: NAVY, points: curve.map((row) => [row.threshold, row.model]) },
      {
        name: "treat all",
        color: QUIET,
        width: 1.5,
        dash: "5 4",
        points: curve.map((row) => [row.threshold, row.treat_all]),
      },
    ],
  });
}
