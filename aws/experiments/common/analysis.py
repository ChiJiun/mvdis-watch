"""純函式的量測計算，全部有單元測試（tests/test_analysis.py）。不碰網路、不 import boto3。"""
from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


def percentile(values: Sequence[float], p: float) -> Optional[float]:
    """線性內插的百分位數（和 numpy 預設相同）；空序列回 None。"""
    if not values:
        return None
    xs = sorted(values)
    k = (len(xs) - 1) * p / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return float(xs[int(k)])
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def summarize_run(
    rows: List[Dict[str, Any]],
    combos: List[Dict[str, Any]],
    expected_tasks: int,
) -> Dict[str, Any]:
    """一個 runId 的 scan_task_log 摘要。

    - 耗時 = 最後一筆 finished_at − 最早一筆 enqueued_at（含排隊時間，是使用者看得到的「掃完一輪」）
    - 漏掃組數 = 期望的組合中，沒有任何一筆 outcome='ok' 的組數（E2 目標為 0）
    """
    finished = [r for r in rows if r.get("finished_at") is not None]
    ok = [r for r in finished if r.get("outcome") == "ok"]
    ok_combos = {(r["license_type"], r["dmv_no"]) for r in ok}
    expected = {(c["licenseType"], c["dmvNo"]) for c in combos}
    missing = sorted(expected - ok_combos)

    enq = [r["enqueued_at"] for r in rows if r.get("enqueued_at") is not None]
    fin = [r["finished_at"] for r in finished]
    started = [r["started_at"] for r in rows if r.get("started_at") is not None]
    duration_ms = (max(fin) - min(enq)) if fin and enq else None
    latency = [r["finished_at"] - r["enqueued_at"] for r in finished]
    service = [r["finished_at"] - r["started_at"] for r in finished if r.get("started_at") is not None]

    def count_by(key: str) -> Dict[str, int]:
        out: Dict[str, int] = {}
        for r in finished:
            k = str(r.get(key))
            out[k] = out.get(k, 0) + 1
        return dict(sorted(out.items()))

    return {
        "expectedTasks": expected_tasks,
        "rows": len(rows),
        "finished": len(finished),
        "ok": len(ok),
        "errors": sum(1 for r in finished if r.get("outcome") == "error"),
        "skipped": sum(1 for r in finished if r.get("outcome") == "skipped"),
        "unfinished": len(rows) - len(finished),
        "notInLog": max(expected_tasks - len(rows), 0),
        "redelivered": sum(1 for r in rows if (r.get("receive_count") or 1) > 1),
        "missingCombos": len(missing),
        "missingComboList": [f"{lt}|{dmv}" for lt, dmv in missing],
        "firstEnqueuedAt": min(enq) if enq else None,
        "firstStartedAt": min(started) if started else None,
        "lastFinishedAt": max(fin) if fin else None,
        "durationMs": duration_ms,
        "throughputPerSec": (len(finished) / (duration_ms / 1000.0)) if duration_ms else None,
        "latencyMs": {"p50": percentile(latency, 50), "p95": percentile(latency, 95), "max": max(latency) if latency else None},
        "serviceMs": {"p50": percentile(service, 50), "p95": percentile(service, 95)},
        "byWorker": count_by("worker_id"),
        "byAz": count_by("az"),
    }


def max_gap(timestamps: Iterable[float], start: Optional[float] = None, end: Optional[float] = None) -> Tuple[float, Optional[float]]:
    """排序後相鄰時間戳的最大間隔（同單位）與間隔開始時間。

    E2 用 scan_task_log.finished_at 算「掃描管線停擺多久」：故障期間沒有任何任務完成的最長空窗。
    start/end 會被當成額外的邊界點，避免漏掉故障一開始或最後的空窗。
    """
    xs = sorted(t for t in timestamps if t is not None)
    if start is not None:
        xs = [start] + [t for t in xs if t >= start]
    if end is not None:
        xs = [t for t in xs if t <= end] + [end]
    best, at = 0.0, None
    for a, b in zip(xs, xs[1:]):
        if b - a > best:
            best, at = b - a, a
    return best, at


def outage_from_probe(samples: List[Tuple[float, bool]], interval_s: float) -> Dict[str, Any]:
    """由探針樣本 [(epoch 秒, 成功與否)] 算服務中斷。

    - totalDownS：失敗樣本數 × 探測間隔
    - longestDownS：最長連續失敗的時間跨度（第一個失敗到之後第一個成功），沒恢復則算到最後一個樣本
    """
    if not samples:
        return {"samples": 0, "failures": 0, "totalDownS": 0.0, "longestDownS": 0.0, "windows": []}
    samples = sorted(samples)
    windows: List[Dict[str, float]] = []
    cur_start: Optional[float] = None
    for t, ok in samples:
        if not ok and cur_start is None:
            cur_start = t
        elif ok and cur_start is not None:
            windows.append({"start": cur_start, "end": t, "seconds": t - cur_start})
            cur_start = None
    if cur_start is not None:
        last = samples[-1][0] + interval_s
        windows.append({"start": cur_start, "end": last, "seconds": last - cur_start, "recovered": False})
    failures = sum(1 for _, ok in samples if not ok)
    return {
        "samples": len(samples),
        "failures": failures,
        "totalDownS": failures * interval_s,
        "longestDownS": max((w["seconds"] for w in windows), default=0.0),
        "windows": windows,
    }


def speedup_table(durations_by_n: Dict[int, float]) -> List[Dict[str, Any]]:
    """E3：以最小台數為基準算 speedup 與平行效率。"""
    if not durations_by_n:
        return []
    base_n = min(durations_by_n)
    base = durations_by_n[base_n]
    out = []
    for n in sorted(durations_by_n):
        d = durations_by_n[n]
        s = (base / d) if d else None
        ideal = n / base_n
        out.append({"workers": n, "durationMs": d, "speedup": s, "idealSpeedup": ideal, "efficiency": (s / ideal) if s else None})
    return out


def detection_latency(flips: List[Dict[str, Any]], released: List[Dict[str, Any]], window_end_ms: Optional[float] = None) -> Dict[str, Any]:
    """E3：Replay 端的釋位（/admin/events kind=released）→ worker 寫入 slot_event(kind=released) 的延遲。

    同一個場次 (licenseType, dmvNo, examDate, secKey) 取「釋位之後第一筆偵測」。
    若同一場次在被偵測前又翻回額滿，該次釋位本來就看不到，計為 undetected（不是錯誤）。
    """
    by_key: Dict[Tuple[str, str, str, str], List[float]] = {}
    for e in released:
        k = (e["license_type"], e["dmv_no"], str(e["exam_date"]), e["sec_key"])
        by_key.setdefault(k, []).append(float(e["at"]))
    for v in by_key.values():
        v.sort()

    lat: List[float] = []
    undetected = 0
    for f in flips:
        if f.get("kind") != "released":
            continue
        if window_end_ms is not None and f["at"] > window_end_ms:
            continue
        k = (f["licenseType"], f["dmvNo"], f["examDate"], f["secKey"])
        hit = next((t for t in by_key.get(k, []) if t >= f["at"]), None)
        if hit is None:
            undetected += 1
        else:
            lat.append(hit - f["at"])
    return {
        "flips": len(lat) + undetected,
        "detected": len(lat),
        "undetected": undetected,
        "p50Ms": percentile(lat, 50),
        "p95Ms": percentile(lat, 95),
        "maxMs": max(lat) if lat else None,
        "meanMs": (sum(lat) / len(lat)) if lat else None,
    }
