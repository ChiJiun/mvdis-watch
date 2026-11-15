"""把 E1–E4 的結果畫成報告用的圖（PNG，matplotlib）。

    python plot/plot_results.py                    讀 results/ 底下各實驗最新的結果檔
    python plot/plot_results.py --demo             不需要任何結果檔，用合成資料畫一次（圖上標「示意資料」）
    python plot/plot_results.py --e3 results/e3/e3-xxx.json --out results/figures

設計原則（依 dataviz 指引）：
- 一張圖只有一個 y 軸；兩種尺度的量（例如 p95 與台數）拆成上下兩個共用 x 軸的子圖
- 類別色依固定順序取（藍、橘、青），同一個實體在每張圖都是同一個顏色
- 文字一律用文字色，不用系列色；格線淡、線寬 2px、標記 >= 8px
- 乾跑（dryRun）或示意資料的結果，標題前面會加註，避免誤把假資料放進報告
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import random
import sys
from typing import Any, Dict, Optional

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from matplotlib.ticker import FuncFormatter, NullFormatter  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULTS = os.path.join(ROOT, "results")

# 參考色盤（dataviz references/palette.md，淺色模式）
SERIES = ["#2a78d6", "#eb6834", "#1baf7a"]
MODEL_COLOR = {"cloudflare": SERIES[0], "ec2-asg": SERIES[1], "lambda": SERIES[2]}
MODEL_LABEL = {"cloudflare": "Cloudflare（原型）", "ec2-asg": "EC2 ASG", "lambda": "Lambda"}
SURFACE = "#fcfcfb"
TEXT = "#0b0b0b"
TEXT2 = "#52514e"
GRID = "#e4e3df"
DOWN = "#e34948"  # 中斷區段（搭配文字標籤，不只靠顏色）
MUTED = "#a9a8a2"

CJK_FONTS = ["Microsoft JhengHei", "Noto Sans CJK TC", "Noto Sans TC", "PingFang TC", "Heiti TC", "WenQuanYi Zen Hei", "Noto Sans CJK JP"]


def setup_style() -> None:
    available = {f.name for f in font_manager.fontManager.ttflist}
    fonts = [f for f in CJK_FONTS if f in available]
    if not fonts:
        print("警告：找不到中文字型，圖上的中文會變成方塊。Amazon Linux 可安裝 google-noto-sans-cjk-ttc-fonts。", file=sys.stderr)
    plt.rcParams.update(
        {
            "font.sans-serif": fonts + ["DejaVu Sans"],
            "axes.unicode_minus": False,
            "figure.facecolor": SURFACE,
            "axes.facecolor": SURFACE,
            "savefig.facecolor": SURFACE,
            "axes.edgecolor": GRID,
            "axes.labelcolor": TEXT2,
            "axes.titlecolor": TEXT,
            "axes.titlesize": 12,
            "axes.titleweight": "bold",
            "axes.grid": True,
            "grid.color": GRID,
            "grid.linewidth": 0.8,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "xtick.color": TEXT2,
            "ytick.color": TEXT2,
            "lines.linewidth": 2,
            "lines.markersize": 8,
            "legend.frameon": False,
            "legend.labelcolor": TEXT,
        }
    )


def latest(experiment: str, include_dry: bool, predicate=None) -> Optional[Dict[str, Any]]:
    files = sorted(glob.glob(os.path.join(RESULTS, experiment, "*.json")), key=os.path.getmtime, reverse=True)
    for f in files:
        with open(f, encoding="utf-8") as fh:
            d = json.load(fh)
        if d.get("dryRun") and not include_dry:
            continue
        if predicate and not predicate(d):
            continue
        d["_file"] = f
        return d
    return None


def load(path: Optional[str]) -> Optional[Dict[str, Any]]:
    if not path:
        return None
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    d["_file"] = path
    return d


def tag(d: Dict[str, Any]) -> str:
    if d.get("_demo"):
        return "【示意資料】"
    if d.get("dryRun"):
        return "【乾跑】"
    return ""


def save(fig, out_dir: str, name: str) -> str:
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, name)
    fig.savefig(path, dpi=160, bbox_inches="tight")
    plt.close(fig)
    print(f"已輸出 {path}")
    return path


# ───────────── E1 ─────────────


def plot_e1_api(d: Dict[str, Any], out: str) -> str:
    steps = [s for s in d["steps"] if s.get("p95Ms") is not None]
    users = [s["users"] for s in steps]
    xs = list(range(len(users)))
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(8, 6), sharex=True, gridspec_kw={"height_ratios": [3, 2]})
    ax1.plot(xs, [s["p95Ms"] for s in steps], marker="o", color=SERIES[0])
    for x, s in zip(xs, steps):
        if s is steps[-1] or s is max(steps, key=lambda r: r["p95Ms"]):
            ax1.annotate(f"{s['p95Ms']:.0f} ms", (x, s["p95Ms"]), textcoords="offset points", xytext=(0, 8), ha="center", color=TEXT, fontsize=9)
    ax1.set_ylabel("p95 回應時間（ms）")
    ax1.set_ylim(bottom=0)
    ax1.set_title(f"{tag(d)}E1 公開 API：併發使用者 vs p95 回應時間")
    inst = [s.get("apiInService") or 0 for s in steps]
    ax2.bar(xs, inst, width=0.6, color=SERIES[0], edgecolor=SURFACE, linewidth=2)
    for x, v in zip(xs, inst):
        ax2.annotate(f"{v:.0f}", (x, v), textcoords="offset points", xytext=(0, 3), ha="center", color=TEXT, fontsize=9)
    ax2.set_ylabel("API InService 台數")
    ax2.set_xticks(xs, [str(u) for u in users])
    ax2.set_xlabel("併發使用者數")
    ax2.set_ylim(0, max(inst + [1]) * 1.25)
    ax2.grid(axis="x", visible=False)
    return save(fig, out, "e1_api.png")


def plot_e1_queue(d: Dict[str, Any], out: str) -> str:
    rows = d["timeline"]
    t0 = d.get("startedAt") or rows[0]["t"]
    mins = [(r["t"] - t0) / 60 for r in rows]
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(8, 6), sharex=True, gridspec_kw={"height_ratios": [3, 2]})
    vis = [r["visible"] for r in rows]
    fl = [r["inFlight"] for r in rows]
    ax1.plot(mins, vis, color=SERIES[0], label="佇列中（visible）")
    ax1.plot(mins, fl, color=SERIES[1], label="處理中（in flight）")
    ax1.annotate("佇列中", (mins[0], vis[0]), textcoords="offset points", xytext=(6, -2), color=TEXT, fontsize=9)
    peak = max(range(len(fl)), key=lambda i: fl[i])
    ax1.annotate("處理中", (mins[peak], fl[peak]), textcoords="offset points", xytext=(6, 4), color=TEXT, fontsize=9)
    ax1.set_ylabel("訊息數")
    ax1.set_ylim(bottom=0)
    ax1.legend(loc="upper right")
    drain = d.get("queueDrainSeconds")
    sub = f"（清空耗時 {drain / 60:.1f} 分）" if drain else ""
    ax1.set_title(f"{tag(d)}E1 佇列端：一次灌 {d.get('count', 3600)} 個任務{sub}")
    ax2.step(mins, [r.get("inService", 0) for r in rows], where="post", color=SERIES[0])
    ax2.set_ylabel("worker InService 台數")
    ax2.set_xlabel("灌入後經過時間（分）")
    ax2.set_ylim(bottom=0)
    return save(fig, out, "e1_queue.png")


# ───────────── E2 ─────────────


def plot_e2(d: Dict[str, Any], out: str) -> str:
    t0 = d.get("faultAt") or min(t for t, _ in d["apiProbe"])
    fig, ax = plt.subplots(figsize=(9, 3.4))
    rows = [("API（CloudFront→ALB→ASG）", d.get("apiProbe", []), d.get("apiOutage", {})), ("資料庫（RDS）", d.get("dbProbe", []), d.get("dbOutage", {}))]
    for i, (label, samples, outage) in enumerate(rows):
        y = len(rows) - 1 - i
        if samples:
            ts = [(t - t0) for t, _ in samples]
            ax.broken_barh([(ts[0], ts[-1] - ts[0])], (y - 0.3, 0.6), color=SERIES[0], alpha=0.35)
        for w in outage.get("windows", []):
            ax.broken_barh([(w["start"] - t0, w["seconds"])], (y - 0.3, 0.6), color=DOWN)
            ax.annotate(f"中斷 {w['seconds']:.0f}s", (w["start"] - t0 + w["seconds"], y + 0.32), color=TEXT, fontsize=9)
    ax.axvline(0, color=TEXT2, linestyle="--", linewidth=1)
    ax.annotate("終止 AZ instance", (0, len(rows) - 0.45), xytext=(4, 0), textcoords="offset points", color=TEXT2, fontsize=9)
    if d.get("rdsFailoverAt"):
        x = d["rdsFailoverAt"] - t0
        ax.axvline(x, color=TEXT2, linestyle=":", linewidth=1)
        ax.annotate("RDS 強制切換", (x, -0.55), xytext=(4, 0), textcoords="offset points", color=TEXT2, fontsize=9)
    ax.set_yticks(range(len(rows)), [r[0] for r in reversed(rows)])
    ax.set_ylim(-0.7, len(rows) - 0.3)
    ax.set_xlabel("相對故障注入時間（秒）；淺藍＝探針正常、紅＝失敗")
    ax.grid(axis="y", visible=False)
    s = d.get("scanTaskLog", {})
    rds = d.get("rds", {}) or {}
    fo = rds.get("failoverSecondsFromEvents")
    ax.set_title(
        f"{tag(d)}E2 高可用：漏掃 {s.get('missingCombos', '?')} 組、重送 {s.get('redelivered', '?')} 則、"
        f"管線最長停擺 {d.get('pipelineMaxGapSeconds', 0):.0f}s" + (f"、RDS 切換 {fo:.0f}s" if fo else "")
    )
    return save(fig, out, "e2_ha.png")


# ───────────── E3 ─────────────


def plot_e3(d: Dict[str, Any], out: str) -> str:
    table = d["speedup"]
    ns = [r["workers"] for r in table]
    xs = list(range(len(ns)))
    fig, axes = plt.subplots(1, 3, figsize=(13, 4))
    ax = axes[0]
    secs = [r["durationMs"] / 1000 for r in table]
    ax.bar(xs, secs, width=0.6, color=SERIES[0], edgecolor=SURFACE, linewidth=2)
    for x, v in zip(xs, secs):
        ax.annotate(f"{v:.0f}s", (x, v), textcoords="offset points", xytext=(0, 3), ha="center", color=TEXT, fontsize=9)
    ax.set_xticks(xs, [str(n) for n in ns])
    ax.set_xlabel("worker 台數")
    ax.set_ylabel("掃完 360 組耗時（秒）")
    ax.set_title(f"{tag(d)}E3 掃完一輪耗時")
    ax.grid(axis="x", visible=False)

    ax = axes[1]
    ax.plot(ns, [r["idealSpeedup"] for r in table], color=MUTED, linestyle="--", label="理想（線性）")
    ax.plot(ns, [r["speedup"] for r in table], color=SERIES[0], marker="o", label="實測")
    last = table[-1]
    ax.text(0.97, 0.05, f"{ns[-1]} 台：{last['speedup']:.2f}×（效率 {last['efficiency']:.0%}）", transform=ax.transAxes, ha="right", color=TEXT, fontsize=9)
    ax.set_xscale("log", base=2)
    ax.set_xticks(ns, [str(n) for n in ns])
    ax.set_xlabel("worker 台數")
    ax.set_ylabel("speedup（相對 1 台）")
    ax.set_title("E3 speedup")
    ax.legend(loc="upper left")

    ax = axes[2]
    det = [(r["workers"], r.get("detection") or {}) for r in d.get("rounds", [])]
    det = [(n, x) for n, x in det if x.get("p50Ms") is not None]
    if det:
        dx = list(range(len(det)))
        w = 0.36
        p50 = [x["p50Ms"] / 1000 for _, x in det]
        p95 = [x["p95Ms"] / 1000 for _, x in det]
        ax.bar([i - w / 2 for i in dx], p50, width=w, color=SERIES[0], edgecolor=SURFACE, linewidth=2, label="p50")
        ax.bar([i + w / 2 for i in dx], p95, width=w, color=SERIES[1], edgecolor=SURFACE, linewidth=2, label="p95")
        ax.set_xticks(dx, [str(n) for n, _ in det])
        ax.legend(loc="upper right")
    else:
        ax.text(0.5, 0.5, "沒有偵測延遲資料\n（--tick-ms 0 或 --no-warmup）", ha="center", va="center", transform=ax.transAxes, color=TEXT2)
    ax.axhline(600, color=MUTED, linestyle=":", linewidth=1)
    ax.annotate("原型約 10 分鐘", (0, 600), xycoords=("axes fraction", "data"), xytext=(4, 4), textcoords="offset points", color=TEXT2, fontsize=9)
    ax.set_ylim(0, 660)
    ax.set_xlabel("worker 台數")
    ax.set_ylabel("釋位 → 偵測延遲（秒）")
    ax.set_title("E3 偵測延遲")
    ax.grid(axis="x", visible=False)
    fig.tight_layout()
    return save(fig, out, "e3_performance.png")


# ───────────── E4 ─────────────


def plot_e4(d: Dict[str, Any], out: str) -> str:
    rows = d["rows"]
    scen = sorted({r["scansPerMinute"] for r in rows})
    models = ["cloudflare", "ec2-asg", "lambda"]
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.2))
    w = 0.26
    for ax, key, ylabel, title in (
        (axes[0], "per1000Scans", "每千次掃描成本（USD，對數）", "掃描邊際成本／千次"),
        (axes[1], "platformMonthly", "月成本（USD，對數）", "含平台固定成本的月成本"),
    ):
        for j, m in enumerate(models):
            vals = []
            for s in scen:
                r = next(x for x in rows if x["model"] == m and x["scansPerMinute"] == s)
                vals.append(max(r[key], 1e-4))  # 對數軸不能畫 0；Cloudflare 免費方案標註 $0
            xs = [i + (j - 1) * w for i in range(len(scen))]
            ax.bar(xs, vals, width=w, color=MODEL_COLOR[m], edgecolor=SURFACE, linewidth=2, label=MODEL_LABEL[m])
            for x, v in zip(xs, vals):
                txt = "$0" if v <= 1e-4 else (f"${v:.4f}" if v < 0.001 else f"${v:.3f}" if v < 1 else f"${v:.0f}")
                ax.annotate(txt, (x, v), textcoords="offset points", xytext=(0, 3), ha="center", color=TEXT, fontsize=8)
        ax.set_yscale("log")
        # 刻度直接寫金額，不用 10^n 的 mathtext（中文字型沒有負號字形）
        ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _p: f"${v:g}"))
        ax.yaxis.set_minor_formatter(NullFormatter())
        ax.set_xticks(range(len(scen)), [f"{s:.0f} 組/分" for s in scen])
        ax.set_ylabel(ylabel)
        ax.set_title(f"{tag(d)}E4 {title}")
        ax.grid(axis="x", visible=False)
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper center", ncol=3, bbox_to_anchor=(0.5, 1.07))
    fig.text(0.01, -0.02, f"價格基準：{d.get('pricesAsOf', '?')}；單次掃描 {d.get('assumptions', {}).get('scanWallMs', '?')} ms", color=TEXT2, fontsize=9)
    fig.tight_layout()
    return save(fig, out, "e4_cost.png")


# ───────────── 示意資料 ─────────────


def demo_data() -> Dict[str, Dict[str, Any]]:
    rnd = random.Random(7)
    users = [50, 100, 250, 500, 1000, 1500, 2000]
    inst = [2, 2, 2, 3, 4, 6, 8]
    e1 = {"_demo": True, "steps": [{"users": u, "p95Ms": 80 + 0.05 * u + rnd.uniform(-10, 10) + (120 if u == 1000 else 0), "apiInService": i} for u, i in zip(users, inst)]}
    t0 = 1_800_000_000.0
    tl, vis = [], 3600
    for k in range(40):
        w = min(2 + k // 3, 8)
        done = w * 5 * 15 / 0.8 * 0.6
        vis = max(0, vis - done)
        tl.append({"t": t0 + k * 15, "visible": int(vis), "inFlight": 0 if vis == 0 else w * 5, "inService": w})
    e1q = {"_demo": True, "startedAt": t0, "count": 3600, "timeline": tl, "queueDrainSeconds": next(r["t"] for r in tl if r["visible"] == 0) - t0}
    api = [(t0 - 60 + i, not (10 <= i - 60 <= 24)) for i in range(300)]
    db = [(t0 - 60 + i, not (32 <= i - 60 <= 61)) for i in range(300)]

    def win(samples):
        from common.analysis import outage_from_probe

        return outage_from_probe(samples, 1.0)

    e2 = {
        "_demo": True, "faultAt": t0, "rdsFailoverAt": t0 + 30, "apiProbe": api, "dbProbe": db,
        "apiOutage": win(api), "dbOutage": win(db), "pipelineMaxGapSeconds": 74,
        "scanTaskLog": {"missingCombos": 0, "redelivered": 41}, "rds": {"failoverSecondsFromEvents": 27},
    }
    base = 380.0
    durs = {1: base, 2: base / 1.93, 4: base / 3.6, 8: base / 6.1}
    from common.analysis import speedup_table

    e3 = {
        "_demo": True, "speedup": speedup_table({n: v * 1000 for n, v in durs.items()}),
        "rounds": [{"workers": n, "detection": {"p50Ms": v * 500, "p95Ms": v * 950}} for n, v in durs.items()],
    }
    sys.path.insert(0, ROOT)
    from e4_cost.cost_model import DEFAULTS, load_prices, run

    e4 = {"_demo": True, "rows": run(load_prices(os.path.join(ROOT, "e4_cost", "prices.json")), dict(DEFAULTS), [14, 36, 360]), "pricesAsOf": "示意", "assumptions": DEFAULTS}
    return {"e1": e1, "e1q": e1q, "e2": e2, "e3": e3, "e4": e4}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--e1", help="analyze_locust.py 的結果檔")
    p.add_argument("--e1-queue", help="enqueue_burst.py --watch 的結果檔")
    p.add_argument("--e2")
    p.add_argument("--e3")
    p.add_argument("--e4")
    p.add_argument("--out", default=os.path.join(RESULTS, "figures"))
    p.add_argument("--include-dry-run", action="store_true", help="自動挑檔時也接受 dryRun 的結果")
    p.add_argument("--demo", action="store_true", help="用合成資料畫圖（驗證出圖流程用）")
    a = p.parse_args(argv)
    sys.path.insert(0, ROOT)
    setup_style()

    if a.demo:
        d = demo_data()
        out = os.path.join(a.out, "demo") if a.out == os.path.join(RESULTS, "figures") else a.out
        plot_e1_api(d["e1"], out)
        plot_e1_queue(d["e1q"], out)
        plot_e2(d["e2"], out)
        plot_e3(d["e3"], out)
        plot_e4(d["e4"], out)
        return 0

    inc = a.include_dry_run
    jobs = [
        ("E1 API", load(a.e1) or latest("e1", inc, lambda x: "steps" in x), plot_e1_api),
        ("E1 佇列", load(a.e1_queue) or latest("e1", inc, lambda x: "timeline" in x and "steps" not in x), plot_e1_queue),
        ("E2", load(a.e2) or latest("e2", inc, lambda x: "apiProbe" in x), plot_e2),
        ("E3", load(a.e3) or latest("e3", inc, lambda x: x.get("speedup")), plot_e3),
        ("E4", load(a.e4) or latest("e4", inc, lambda x: "rows" in x), plot_e4),
    ]
    made = 0
    for label, data, fn in jobs:
        if data is None:
            print(f"略過 {label}：results/ 裡沒有可用的結果檔")
            continue
        fn(data, a.out)
        made += 1
    return 0 if made else 1


if __name__ == "__main__":
    sys.exit(main())
