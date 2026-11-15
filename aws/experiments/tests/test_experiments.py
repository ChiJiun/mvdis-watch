"""實驗腳本的單元測試與乾跑測試（不需要 AWS 憑證、不需要 boto3／psycopg／locust）。

    cd aws/experiments && python -m unittest discover -s tests -v
"""
from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(os.path.dirname(ROOT))
sys.path.insert(0, ROOT)

from common import analysis, settings, tasks  # noqa: E402


class TmpResults(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self._env = mock.patch.dict(os.environ, {"EXPERIMENTS_RESULTS_DIR": self.tmp})
        self._env.start()

    def tearDown(self) -> None:
        self._env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestTasks(unittest.TestCase):
    def test_combos_are_360_and_match_catalogue_shape(self):
        combos = tasks.load_combos()
        self.assertEqual(len(combos), 360)
        self.assertEqual(len({(c["licenseType"], c["dmvNo"]) for c in combos}), 360)
        self.assertEqual(sum(1 for c in combos if c["hot"]), 108)

    def test_build_3600_tasks_same_run_unique_ids_all_replay(self):
        ts = tasks.build_tasks("e1-test", 3600)
        self.assertEqual(len(ts), 3600)
        self.assertEqual(len({t["taskId"] for t in ts}), 3600)
        self.assertEqual({t["runId"] for t in ts}, {"e1-test"})
        self.assertEqual({t["target"] for t in ts}, {"replay"})
        per_combo = {}
        for t in ts:
            k = (t["licenseType"], t["dmvNo"])
            per_combo[k] = per_combo.get(k, 0) + 1
        self.assertEqual(set(per_combo.values()), {10})
        self.assertTrue(all(set(t) == set(tasks.SCAN_TASK_KEYS) for t in ts))
        self.assertTrue(all(re.fullmatch(r"[0-9a-f-]{36}", t["taskId"]) for t in ts))

    def test_tier_follows_hot_flag(self):
        t = tasks.make_task({"licenseType": "3", "lv1": "60", "dmvNo": "63", "hot": True}, "r")
        self.assertEqual(t["tier"], "hot")
        t = tasks.make_task({"licenseType": "H", "lv1": "80", "dmvNo": "83", "hot": False}, "r")
        self.assertEqual(t["tier"], "cold")

    def test_guard_rejects_live_and_missing_run_id(self):
        t = tasks.make_task(tasks.load_combos()[0], "r1")
        for bad in ({**t, "target": "live"}, {**t, "target": None}, {**t, "runId": None}, {**t, "runId": " "}, {**t, "v": 2}, {**t, "extra": 1}):
            with self.assertRaises(tasks.TargetGuardError):
                tasks.assert_replay(bad)

    def test_send_tasks_refuses_live_even_in_dry_run_and_before_any_sqs_call(self):
        t = tasks.make_task(tasks.load_combos()[0], "r1")
        t["target"] = "live"
        sqs = mock.Mock()
        with self.assertRaises(tasks.TargetGuardError):
            tasks.send_tasks("q", [t], dry_run=True)
        with self.assertRaises(tasks.TargetGuardError):
            tasks.send_tasks("q", [t], dry_run=False, sqs_client=sqs)
        sqs.send_message_batch.assert_not_called()

    def test_send_tasks_batches_of_10_and_retries_failed_entries(self):
        ts = tasks.build_tasks("r2", 25)
        calls = []

        def fake_send(QueueUrl, Entries):  # noqa: N803
            calls.append(len(Entries))
            for e in Entries:
                body = json.loads(e["MessageBody"])
                assert body["target"] == "replay"
            # 第一次呼叫讓 Id "0" 失敗一次
            return {"Failed": [{"Id": "0"}]} if len(calls) == 1 else {}

        sqs = mock.Mock()
        sqs.send_message_batch.side_effect = fake_send
        with redirect_stdout(io.StringIO()):
            r = tasks.send_tasks("q", ts, dry_run=False, sqs_client=sqs, concurrency=1)
        self.assertEqual(r["sent"], 25)
        self.assertEqual(r["failed"], 0)
        self.assertEqual(sorted(calls), [1, 5, 10, 10])

    def test_scan_task_keys_match_contracts_ts(self):
        with open(os.path.join(REPO, "aws", "shared", "contracts.ts"), encoding="utf-8") as f:
            src = f.read()
        body = re.search(r"export type ScanTask = \{([\s\S]*?)\n\};", src).group(1)
        body = re.sub(r"/\*[\s\S]*?\*/", "", body)
        keys = re.findall(r"^\s*(\w+)\s*:", body, re.M)
        self.assertEqual(tuple(keys), tasks.SCAN_TASK_KEYS)

    @unittest.skipUnless(shutil.which("node"), "需要 node")
    def test_combos_json_in_sync_with_catalogue(self):
        r = subprocess.run(
            ["node", "--experimental-strip-types", "--no-warnings", "common/gen_combos.ts", "--check"],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
        )
        self.assertEqual(r.returncode, 0, r.stderr)


class TestAnalysis(unittest.TestCase):
    def row(self, lt, dmv, enq, start, fin, outcome="ok", az="us-east-1a", rc=1):
        return {"license_type": lt, "dmv_no": dmv, "enqueued_at": enq, "started_at": start, "finished_at": fin,
                "outcome": outcome, "worker_id": "i-" + az[-1], "az": az, "receive_count": rc}

    def test_percentile(self):
        self.assertIsNone(analysis.percentile([], 50))
        self.assertEqual(analysis.percentile([1, 2, 3, 4], 50), 2.5)
        self.assertAlmostEqual(analysis.percentile(list(range(1, 101)), 95), 95.05)

    def test_summarize_run_counts_missing_combos(self):
        combos = [{"licenseType": "3", "dmvNo": "63"}, {"licenseType": "3", "dmvNo": "41"}, {"licenseType": "A", "dmvNo": "74"}]
        rows = [
            self.row("3", "63", 1000, 1100, 1500),
            self.row("3", "41", 1000, 1200, 2500, outcome="error"),
            self.row("3", "41", 1000, 1300, 3000, az="us-east-1b", rc=2),
            self.row("A", "74", 1000, None, None),
        ]
        s = analysis.summarize_run(rows, combos, expected_tasks=5)
        self.assertEqual(s["missingCombos"], 1)
        self.assertEqual(s["missingComboList"], ["A|74"])
        self.assertEqual(s["durationMs"], 2000)
        self.assertEqual(s["errors"], 1)
        self.assertEqual(s["unfinished"], 1)
        self.assertEqual(s["notInLog"], 1)
        self.assertEqual(s["redelivered"], 1)
        self.assertEqual(s["byAz"], {"us-east-1a": 2, "us-east-1b": 1})
        self.assertEqual((s["stale"], s["rejected"], s["committedNotFinished"]), (0, 0, 0))

    def test_summarize_counts_new_outcomes_and_committed_not_finished(self):
        combos = [{"licenseType": "3", "dmvNo": "63"}]
        rows = [
            {**self.row("3", "63", 1000, 1100, None, outcome="ok"), "committed_at": 1200},
            {**self.row("3", "63", 1000, 1100, 1300, outcome="rejected")},
            {**self.row("3", "63", 1000, None, 1100, outcome="stale")},
        ]
        s = analysis.summarize_run(rows, combos, expected_tasks=3)
        self.assertEqual((s["stale"], s["rejected"], s["committedNotFinished"]), (1, 1, 1))
        # ok 那筆還沒 finished，不算完成 → 漏掃 1 組
        self.assertEqual(s["missingCombos"], 1)

    def test_max_gap_includes_boundaries(self):
        self.assertEqual(analysis.max_gap([10, 12, 30, 31]), (18, 12))
        gap, at = analysis.max_gap([10, 12, 30], start=0, end=100)
        self.assertEqual((gap, at), (70, 30))

    def test_outage_from_probe(self):
        s = [(0, True), (1, False), (2, False), (3, True), (4, False)]
        o = analysis.outage_from_probe(s, 1.0)
        self.assertEqual(o["failures"], 3)
        self.assertEqual(o["totalDownS"], 3.0)
        self.assertEqual(o["longestDownS"], 2.0)
        self.assertFalse(o["windows"][-1]["recovered"])
        self.assertEqual(analysis.outage_from_probe([], 1)["longestDownS"], 0.0)

    def test_speedup_table(self):
        t = analysis.speedup_table({1: 400.0, 2: 200.0, 4: 125.0, 8: 80.0})
        self.assertEqual([r["speedup"] for r in t], [1.0, 2.0, 3.2, 5.0])
        self.assertEqual(t[-1]["efficiency"], 5.0 / 8)

    def test_detection_latency_matches_first_detection_after_flip(self):
        flips = [
            {"kind": "released", "at": 1000, "licenseType": "3", "dmvNo": "63", "examDate": "2026-12-01", "secKey": "2:25"},
            {"kind": "released", "at": 5000, "licenseType": "3", "dmvNo": "63", "examDate": "2026-12-01", "secKey": "2:25"},
            {"kind": "filled", "at": 6000, "licenseType": "3", "dmvNo": "63", "examDate": "2026-12-01", "secKey": "2:25"},
            {"kind": "released", "at": 7000, "licenseType": "A", "dmvNo": "74", "examDate": "2026-12-02", "secKey": "1:3"},
            {"kind": "released", "at": 99999, "licenseType": "A", "dmvNo": "74", "examDate": "2026-12-02", "secKey": "1:3"},
        ]
        released = [
            {"license_type": "3", "dmv_no": "63", "exam_date": "2026-12-01", "sec_key": "2:25", "at": 4000},
            {"license_type": "3", "dmv_no": "63", "exam_date": "2026-12-01", "sec_key": "2:25", "at": 9000},
        ]
        r = analysis.detection_latency(flips, released, window_end_ms=50000)
        self.assertEqual(r["flips"], 3)
        self.assertEqual(r["detected"], 2)
        self.assertEqual(r["undetected"], 1)
        self.assertEqual(r["p50Ms"], 3500.0)


class TestCost(TmpResults):
    def setUp(self):
        super().setUp()
        from e4_cost import cost_model

        self.cm = cost_model
        self.P = cost_model.load_prices(os.path.join(ROOT, "e4_cost", "prices.json"))

    def test_cloudflare_free_at_14_per_minute_paid_beyond_cpu_limit(self):
        a = dict(self.cm.DEFAULTS)
        self.assertEqual(self.cm.cloudflare_model(self.P, a, 14)["plan"], "free")
        r = self.cm.cloudflare_model(self.P, a, 36)  # 6.45/14×36 ≈ 16.6 ms > 10 ms
        self.assertEqual(r["plan"], "paid")
        self.assertAlmostEqual(r["cpuMsPerInvocation"], 6.45 / 14 * 36)

    def test_ec2_min_two_instances_and_scales_with_load(self):
        a = dict(self.cm.DEFAULTS)
        self.assertEqual(self.cm.ec2_model(self.P, a, 14)["instances"], 2)
        a["scanWallMs"] = 5000
        self.assertGreater(self.cm.ec2_model(self.P, a, 360)["instances"], 2)

    def test_lambda_cost_formula(self):
        a = dict(self.cm.DEFAULTS, scanWallMs=980, lambdaInitMsAmortized=20, lambdaMemoryMb=1024)
        r = self.cm.lambda_model(self.P, a, 1)
        scans = 60 * 730
        expected = scans * 1.0 * self.P["lambda"]["perGbSecond"] + scans / 1e6 * self.P["lambda"]["perMillionRequests"]
        self.assertAlmostEqual(r["scanning"]["workerCompute"], expected)

    def test_per_1000_is_monthly_over_scans(self):
        rows = self.cm.run(self.P, dict(self.cm.DEFAULTS), [14])
        for r in rows:
            self.assertAlmostEqual(r["per1000Scans"], r["scanningMonthly"] / (14 * 60 * 730 / 1000))

    def test_cli_writes_result(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(self.cm.main(["--dry-run", "--scenarios", "14"]), 0)
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "e4", "e4-cost.json")))


class TestSettings(unittest.TestCase):
    def test_priority_cli_env_tf(self):
        import argparse

        p = argparse.ArgumentParser()
        settings.add_arguments(p, "queue_url", "worker_asg", "api_url")
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump({"scan_queue_url": {"value": "https://tf/q"}, "worker_asg_name": {"value": "tf-asg"}, "cloudfront_url": {"value": "https://cf"}}, f)
        try:
            a = p.parse_args(["--tf-outputs", f.name, "--worker-asg", "cli-asg"])
            with mock.patch.dict(os.environ, {"API_BASE_URL": "https://env"}):
                v = settings.resolve(a, "queue_url", "worker_asg", "api_url")
        finally:
            os.unlink(f.name)
        self.assertEqual(v, {"queue_url": "https://tf/q", "worker_asg": "cli-asg", "api_url": "https://env"})
        with self.assertRaises(SystemExit):
            settings.require({"queue_url": None}, "queue_url")


class TestReplayAdmin(unittest.TestCase):
    def test_refuses_official_host(self):
        from common import replay_admin

        for u in ("https://www.mvdis.gov.tw", "http://mvdis.gov.tw:8080"):
            with self.assertRaises(ValueError):
                replay_admin.assert_not_official(u)
        replay_admin.assert_not_official("http://10.0.10.200:8080")


class TestDryRuns(TmpResults):
    """每支實驗腳本的 --dry-run：不 import boto3／psycopg、不連網、寫出標記 dryRun 的結果。"""

    def run_main(self, module, argv):
        mod = __import__(module, fromlist=["main"])
        env = {k: v for k, v in os.environ.items() if not k.startswith(("SCAN_", "WORKER_", "API_", "RDS_", "REPLAY_", "DB_"))}
        with mock.patch.dict(os.environ, env, clear=True), redirect_stdout(io.StringIO()) as out:
            with mock.patch.dict(sys.modules, {"boto3": None, "psycopg": None}):  # import 就會失敗
                rc = mod.main(argv)
        return rc, out.getvalue()

    def assert_result(self, exp):
        files = os.listdir(os.path.join(self.tmp, exp))
        self.assertEqual(len(files), 1)
        with open(os.path.join(self.tmp, exp, files[0]), encoding="utf-8") as f:
            self.assertTrue(json.load(f)["dryRun"])

    def test_e1_enqueue_burst(self):
        rc, out = self.run_main("e1_scalability.enqueue_burst", ["--dry-run"])
        self.assertEqual(rc, 0)
        self.assertIn("3600 則 target=replay", out)
        self.assert_result("e1")

    def test_e1_monitor(self):
        rc, out = self.run_main("e1_scalability.monitor_asg", ["--dry-run"])
        self.assertEqual(rc, 0)
        self.assertIn("[dry-run]", out)

    def test_e2_fault_inject(self):
        rc, out = self.run_main("e2_ha.fault_inject", ["--dry-run", "--az", "us-east-1a"])
        self.assertEqual(rc, 0)
        self.assertIn("ForceFailover", out)
        self.assert_result("e2")

    def test_e2_requires_confirm(self):
        with self.assertRaises(SystemExit) as cm:
            self.run_main("e2_ha.fault_inject", [])
        self.assertIn("--confirm", str(cm.exception))

    def test_e3_run_scaling(self):
        rc, out = self.run_main("e3_performance.run_scaling", ["--dry-run", "--workers", "1,2,4,8"])
        self.assertEqual(rc, 0)
        self.assertIn("n=8", out)
        self.assert_result("e3")

    def test_e1_analyze_locust(self):
        hist = os.path.join(self.tmp, "h.csv")
        cols = "Timestamp,User Count,Type,Name,Requests/s,Failures/s,50%,95%,99%"
        lines = [cols]
        for i in range(40):
            users = 50 if i < 20 else 100
            lines.append(f"{1000 + i},{users},,Aggregated,{users / 2},0,{50 + i},{100 + i},{150 + i}")
        with open(hist, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        from e1_scalability import analyze_locust

        with redirect_stdout(io.StringIO()):
            self.assertEqual(analyze_locust.main(["--history", hist, "--name", "t", "--dry-run"]), 0)
        with open(os.path.join(self.tmp, "e1", "t.json"), encoding="utf-8") as f:
            steps = json.load(f)["steps"]
        self.assertEqual([s["users"] for s in steps], [50, 100])
        self.assertEqual(steps[0]["samples"], 10)  # 後半段


if __name__ == "__main__":
    unittest.main()
