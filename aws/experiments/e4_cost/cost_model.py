"""E4 成本：比較三種執行模型的每千次掃描成本與月成本。

    python e4_cost/cost_model.py                         用預設假設算（純計算，不連 AWS）
    python e4_cost/cost_model.py --from-e3 results/e3/<prefix>.json   用 E3 實測的單次掃描耗時
    python e4_cost/cost_model.py --scenarios 14,36,360 --lambda-memory-mb 256

三種模型：
  A. Cloudflare Workers（原型）：每分鐘一次 cron，每次掃 N 組。實測 CPU 最壞 6.45 ms／次（14 組）、每分鐘 14 組。
  B. EC2 ASG worker：t3 instance 跑 worker，每台 WORKER_CONCURRENCY 個並行掃描；為了跨 AZ 高可用至少 2 台。
  C. Lambda worker：SQS 觸發，每則訊息一次 invocation，計費時間＝單次掃描的牆鐘時間（等官網回應也算錢）。

情境（--scenarios，單位：每分鐘掃描組數）：
  14  = 目前對官網的禮貌上限（live）
  36  = 360 組每 10 分鐘一輪（原型的偵測延遲）
  360 = 360 組每分鐘一輪（只能對 Replay 站做，代表系統能力上限）

輸出兩種成本：
  - scanning：只算「掃描」本身的邊際成本（worker 運算、SQS、NAT 流量、S3 寫入、CloudWatch Logs）→ 每千次掃描成本
  - platform：加上兩種 AWS 模型都要付的固定成本（RDS Multi-AZ、2 個 NAT Gateway、ALB、API ASG 2 台、
    公有 IPv4 位址、Secrets Manager、CloudFront）
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from typing import Any, Dict, List

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from common.results import write_result  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
MIN_PER_MONTH = 60 * 730  # 和 hoursPerMonth=730 一致

DEFAULTS = {
    # 單次掃描的牆鐘時間（含等官網回應、寫 DB、寫 S3）；E3 實測後用 --from-e3 覆寫
    "scanWallMs": 800.0,
    # 原型在 Cloudflare 實測：一次 cron（14 組）CPU 最壞 6.45 ms
    "cfCpuMsPerInvocationWorst": 6.45,
    "cfScansPerInvocationMeasured": 14,
    # 走 NAT Gateway 的官網頁面大小。NAT 依實際傳輸位元組計費；fixture 未壓縮 68–93 KB（available.html 93 KB），
    # 官網是否回 gzip 沒有驗證，這裡保守用未壓縮的最大值
    "htmlKbPerScan": 93.0,
    "rawKbPerScanGz": 15.0,  # 存 S3 的 gzip 原始頁面
    "workerConcurrency": 5,  # 契約 WORKER_CONCURRENCY 預設
    "workerInstanceType": "t3.micro",
    "workerTargetUtilization": 0.6,  # 留 40% 餘裕給尖峰與重送
    "workerMinInstances": 2,  # 跨 2 個 AZ
    "lambdaMemoryMb": 256,
    "lambdaInitMsAmortized": 20.0,  # 冷啟動攤提到每次 invocation
    "sqsRequestsPerScan": 3.0,  # EC2：Send + Receive + Delete
    # Lambda：Receive 由事件來源的 poller 做，已算在 lambdaPollRequestsPerMonth，每次掃描只剩 Send + Delete
    "lambdaSqsRequestsPerScan": 2.0,
    "lambdaPollRequestsPerMonth": 650000,  # SQS 事件來源的長輪詢（約 5 個 poller × 每 20 秒一次）
    "logKbPerScan": 1.0,  # worker 每次掃描寫的 log／EMF 指標（假設值）
    "logRetentionMonths": 1.0,
    "apiInstances": 2,
    "apiInstanceType": "t3.micro",
    "rdsStorageGb": 20,
    "natGateways": 2,
    "albLcu": 1.0,
    # 公有 IPv4：2 個 NAT 的 EIP＋ALB 每個 AZ 一個（bastion 只在實驗時開，不算）
    "publicIpv4Count": 4,
    "secrets": 2,  # DB 帳密、Discord webhook
    # CloudFront 的量取決於公開 API 的使用量，不是掃描量；預設 0，有流量估計時再填
    "cloudfrontRequestsPerMonth": 0,
    "cloudfrontGbPerMonth": 0.0,
}


def load_prices(path: str) -> Dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def scans_per_month(per_min: float) -> float:
    return per_min * MIN_PER_MONTH


def shared_scan_costs(P: Dict[str, Any], a: Dict[str, Any], scans: float, sqs_per_scan: float) -> Dict[str, float]:
    """EC2 與 Lambda 都要付、和掃描次數成正比的部分。"""
    nat_gb = scans * a["htmlKbPerScan"] / 1024 / 1024
    s3_gb_added = scans * a["rawKbPerScanGz"] / 1024 / 1024
    log_gb = scans * a["logKbPerScan"] / 1024 / 1024
    cw = P["cloudwatchLogs"]
    return {
        "sqs": scans * sqs_per_scan / 1e6 * P["sqs"]["perMillionRequests"],
        "cloudwatchLogs": log_gb * (cw["perGbIngested"] + a["logRetentionMonths"] * cw["perGbMonthStored"]),
        "natData": nat_gb * P["natGateway"]["perGbProcessed"],
        # 只算當月新增資料一個月的儲存（保守低估長期累積），加上 PUT
        "s3": s3_gb_added * P["s3"]["perGbMonth"] + scans / 1000 * P["s3"]["perThousandPut"],
    }


def platform_fixed(P: Dict[str, Any], a: Dict[str, Any]) -> Dict[str, float]:
    h = P["hoursPerMonth"]
    return {
        "rdsMultiAz": P["rds"]["db.t3.micro.multiAz"] * h + a["rdsStorageGb"] * P["rds"]["gp2PerGbMonthMultiAz"],
        "natHours": a["natGateways"] * P["natGateway"]["perHour"] * h,
        "alb": (P["alb"]["perHour"] + a["albLcu"] * P["alb"]["perLcuHour"]) * h,
        "apiAsg": a["apiInstances"] * (P["ec2"][a["apiInstanceType"]] * h + P["ec2"]["ebsGbPerInstance"] * P["ec2"]["ebsGp3PerGbMonth"]),
        "publicIpv4": a["publicIpv4Count"] * P["publicIpv4"]["perHour"] * h,
        "secretsManager": a["secrets"] * P["secretsManager"]["perSecretMonth"],
        "cloudfront": a["cloudfrontRequestsPerMonth"] / 1e4 * P["cloudfront"]["perTenThousandHttpsRequests"]
        + a["cloudfrontGbPerMonth"] * P["cloudfront"]["perGbTransferOut"],
    }


def ec2_model(P: Dict[str, Any], a: Dict[str, Any], per_min: float) -> Dict[str, Any]:
    scans = scans_per_month(per_min)
    per_instance_per_sec = a["workerConcurrency"] / (a["scanWallMs"] / 1000.0)
    need = (per_min / 60.0) / (per_instance_per_sec * a["workerTargetUtilization"])
    n = max(a["workerMinInstances"], math.ceil(need))
    h = P["hoursPerMonth"]
    compute = n * (P["ec2"][a["workerInstanceType"]] * h + P["ec2"]["ebsGbPerInstance"] * P["ec2"]["ebsGp3PerGbMonth"])
    parts = {"workerCompute": compute, **shared_scan_costs(P, a, scans, a["sqsRequestsPerScan"])}
    return {"model": "ec2-asg", "instances": n, "instancesNeededRaw": need, "scansPerMonth": scans, "scanning": parts}


def lambda_model(P: Dict[str, Any], a: Dict[str, Any], per_min: float) -> Dict[str, Any]:
    scans = scans_per_month(per_min)
    billed_s = (a["scanWallMs"] + a["lambdaInitMsAmortized"]) / 1000.0
    gb_s = scans * billed_s * a["lambdaMemoryMb"] / 1024
    compute = gb_s * P["lambda"]["perGbSecond"] + scans / 1e6 * P["lambda"]["perMillionRequests"]
    polling = a["lambdaPollRequestsPerMonth"] / 1e6 * P["sqs"]["perMillionRequests"]
    parts = {"workerCompute": compute, "sqsPolling": polling, **shared_scan_costs(P, a, scans, a["lambdaSqsRequestsPerScan"])}
    concurrency = (per_min / 60.0) * billed_s
    return {"model": "lambda", "gbSeconds": gb_s, "avgConcurrency": concurrency, "scansPerMonth": scans, "scanning": parts}


def cloudflare_model(P: Dict[str, Any], a: Dict[str, Any], per_min: float) -> Dict[str, Any]:
    """一分鐘一次 cron、一次掃 per_min 組。CPU 依實測（每組 CPU = 6.45 ms / 14）線性外推。"""
    cf = P["cloudflare"]
    scans = scans_per_month(per_min)
    invocations = MIN_PER_MONTH  # 每分鐘一次 cron
    cpu_per_scan = a["cfCpuMsPerInvocationWorst"] / a["cfScansPerInvocationMeasured"]
    cpu_per_inv = cpu_per_scan * per_min
    fits_free = (
        cpu_per_inv <= cf["free"]["cpuMsPerInvocation"]
        and per_min <= cf["free"]["subrequestsPerInvocation"]
        and invocations / 30 <= cf["free"]["requestsPerDay"]
    )
    if fits_free:
        cost, plan = 0.0, "free"
    else:
        paid = cf["paid"]
        cpu_total = cpu_per_inv * invocations
        over_req = max(0.0, invocations - paid["includedRequestsPerMonth"]) / 1e6 * paid["perMillionRequests"]
        over_cpu = max(0.0, cpu_total - paid["includedCpuMsPerMonth"]) / 1e6 * paid["perMillionCpuMs"]
        cost, plan = paid["monthly"] + over_req + over_cpu, "paid"
    feasible = per_min <= (cf["free"]["subrequestsPerInvocation"] if fits_free else cf["paid"]["subrequestsPerInvocation"])
    return {
        "model": "cloudflare",
        "plan": plan,
        "feasible": feasible,
        "cpuMsPerInvocation": cpu_per_inv,
        "scansPerMonth": scans,
        "scanning": {"workers": cost},
        "note": "D1 讀寫額度未納入；原型已把每次 cron 的 D1 查詢壓在 50 次以內",
    }


def finalize(r: Dict[str, Any], fixed: Dict[str, float]) -> Dict[str, Any]:
    scanning = sum(r["scanning"].values())
    r["scanningMonthly"] = scanning
    r["per1000Scans"] = scanning / (r["scansPerMonth"] / 1000.0)
    if r["model"] == "cloudflare":
        r["platformMonthly"] = scanning
    else:
        r["platformFixed"] = fixed
        r["platformMonthly"] = scanning + sum(fixed.values())
    r["per1000ScansWithPlatform"] = r["platformMonthly"] / (r["scansPerMonth"] / 1000.0)
    return r


def run(P: Dict[str, Any], a: Dict[str, Any], scenarios: List[float]) -> List[Dict[str, Any]]:
    fixed = platform_fixed(P, a)
    out = []
    for s in scenarios:
        for fn in (cloudflare_model, ec2_model, lambda_model):
            r = finalize(fn(P, a, s), fixed)
            r["scansPerMinute"] = s
            out.append(r)
    return out


def assumptions_from_e3(path: str) -> Dict[str, Any]:
    """取 E3 最大台數那一輪的單次掃描服務時間 p50（started→finished）當 scanWallMs。"""
    with open(path, encoding="utf-8") as f:
        e3 = json.load(f)
    rounds = [r for r in e3.get("rounds", []) if r.get("scanTaskLog", {}).get("serviceMs", {}).get("p50")]
    if not rounds:
        raise SystemExit(f"{path} 裡沒有可用的 serviceMs.p50")
    r = max(rounds, key=lambda x: x["workers"])
    return {"scanWallMs": float(r["scanTaskLog"]["serviceMs"]["p50"]), "_fromE3": {"file": path, "workers": r["workers"]}}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--prices", default=os.path.join(HERE, "prices.json"))
    p.add_argument("--scenarios", default="14,36,360", help="每分鐘掃描組數，逗號分隔")
    p.add_argument("--from-e3", help="用 E3 結果檔的實測單次掃描耗時")
    p.add_argument("--scan-wall-ms", type=float)
    p.add_argument("--lambda-memory-mb", type=int)
    p.add_argument("--worker-instance-type")
    p.add_argument("--name", default="e4-cost")
    p.add_argument("--dry-run", action="store_true", help="E4 是純計算，這個旗標只在結果裡標記 dryRun")
    a = p.parse_args(argv)

    P = load_prices(a.prices)
    assume = dict(DEFAULTS)
    if a.from_e3:
        assume.update(assumptions_from_e3(a.from_e3))
    if a.scan_wall_ms:
        assume["scanWallMs"] = a.scan_wall_ms
    if a.lambda_memory_mb:
        assume["lambdaMemoryMb"] = a.lambda_memory_mb
    if a.worker_instance_type:
        if a.worker_instance_type not in P["ec2"]:
            raise SystemExit(f"prices.json 沒有 {a.worker_instance_type} 的價格")
        assume["workerInstanceType"] = a.worker_instance_type
    scenarios = [float(x) for x in a.scenarios.split(",") if x.strip()]
    rows = run(P, assume, scenarios)

    print(f"價格基準：{P['asOf']}；單次掃描 {assume['scanWallMs']:.0f} ms")
    print(f"{'每分鐘':>6} {'模型':<11} {'掃描月成本':>10} {'每千次':>10} {'含平台月成本':>12} {'含平台每千次':>12}  備註")
    for r in rows:
        extra = ""
        if r["model"] == "ec2-asg":
            extra = f"{r['instances']} 台 {assume['workerInstanceType']}"
        elif r["model"] == "lambda":
            extra = f"平均並行 {r['avgConcurrency']:.1f}"
        else:
            extra = f"{r['plan']} 方案" + ("" if r["feasible"] else "（超出 subrequest 上限，不可行）")
        print(
            f"{r['scansPerMinute']:>6.0f} {r['model']:<11} ${r['scanningMonthly']:>9.2f} ${r['per1000Scans']:>9.4f}"
            f" ${r['platformMonthly']:>11.2f} ${r['per1000ScansWithPlatform']:>11.4f}  {extra}"
        )
    write_result("e4", a.name, {"dryRun": a.dry_run, "pricesAsOf": P["asOf"], "assumptions": assume, "rows": rows})
    return 0


if __name__ == "__main__":
    sys.exit(main())
