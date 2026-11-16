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
            # 第一次呼叫讓 Id "0" 失敗一次（SenderFault=False，可重試）
            failed = {"0"} if len(calls) == 1 else set()
            return {
                "Successful": [{"Id": e["Id"]} for e in Entries if e["Id"] not in failed],
                "Failed": [{"Id": i, "SenderFault": False} for i in failed],
            }

        sqs = mock.Mock()
        sqs.send_message_batch.side_effect = fake_send
        with redirect_stdout(io.StringIO()):
            r = tasks.send_tasks("q", ts, dry_run=False, sqs_client=sqs, concurrency=1)
        self.assertEqual(r["sent"], 25)
        self.assertEqual(r["failed"], 0)
        self.assertEqual(sorted(calls), [1, 5, 10, 10])
        self.assertEqual(r["failedTaskIds"], [])

    def test_send_tasks_retries_when_call_raises_and_reports_failed_ids(self):
        ts = tasks.build_tasks("r3", 12)
        state = {"n": 0}

        def flaky(QueueUrl, Entries):  # noqa: N803
            state["n"] += 1
            if state["n"] == 1:
                raise RuntimeError("ThrottlingException")  # 整批呼叫丟例外 → 重試，不中斷整個 run
            # Id "1" 是 SenderFault（訊息本身有問題），重試沒有意義，直接算失敗
            bad = {"1"} if len(Entries) == 10 else set()
            return {
                "Successful": [{"Id": e["Id"]} for e in Entries if e["Id"] not in bad],
                "Failed": [{"Id": i, "SenderFault": True} for i in bad],
            }

        sqs = mock.Mock()
        sqs.send_message_batch.side_effect = flaky
        with redirect_stdout(io.StringIO()), mock.patch("time.sleep"):
            r = tasks.send_tasks("q", ts, dry_run=False, sqs_client=sqs, concurrency=1)
        self.assertEqual(r["sent"], 11)
        self.assertEqual(r["failed"], 1)
        self.assertEqual(r["failedTaskIds"], [ts[1]["taskId"]])

    def test_send_tasks_gives_up_after_max_attempts(self):
        ts = tasks.build_tasks("r4", 3)
        sqs = mock.Mock()
        sqs.send_message_batch.side_effect = RuntimeError("網路斷線")
        with redirect_stdout(io.StringIO()), mock.patch("time.sleep"):
            r = tasks.send_tasks("q", ts, dry_run=False, sqs_client=sqs, concurrency=1)
        self.assertEqual(sqs.send_message_batch.call_count, tasks.SEND_ATTEMPTS)
        self.assertEqual((r["sent"], r["failed"]), (0, 3))

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

    def test_detection_latency_classifies_flips(self):
        def flip(kind, at, lt="3", dmv="63", d="2026-12-01", k="2:25"):
            return {"kind": kind, "at": at, "licenseType": lt, "dmvNo": dmv, "examDate": d, "secKey": k}

        flips = [
            flip("released", 1000),  # 4000 偵測到 → detected，延遲 3000
            flip("released", 5000),  # 6000 翻回額滿、9000 才有偵測 → reverted（任何掃描都看不到）
            flip("filled", 6000),
            flip("released", 7000, "A", "74", "2026-12-02", "1:3"),  # 可偵測卻沒偵測到 → undetected
            flip("released", 30000, "A", "74", "2026-12-02", "1:3"),  # 在該組最後一次開始抓取之後 → afterLastScan
            flip("released", 99999, "A", "74", "2026-12-02", "1:3"),  # window 之後 → afterLastScan
            flip("released", 2000, "H", "83", "2026-12-03", "1:1"),  # 該組這一輪完全沒開始抓 → comboNotScanned
        ]
        released = [
            {"license_type": "3", "dmv_no": "63", "exam_date": "2026-12-01", "sec_key": "2:25", "at": 4000},
            {"license_type": "3", "dmv_no": "63", "exam_date": "2026-12-01", "sec_key": "2:25", "at": 9000},
        ]
        rows = [
            {"license_type": "3", "dmv_no": "63", "started_at": 8500},
            {"license_type": "A", "dmv_no": "74", "started_at": 8000},
            {"license_type": "A", "dmv_no": "74", "started_at": 20000},
            {"license_type": "H", "dmv_no": "83", "started_at": None},
        ]
        last = analysis.last_scan_start_by_combo(rows)
        self.assertEqual(last, {("3", "63"): 8500.0, ("A", "74"): 20000.0})
        r = analysis.detection_latency(flips, released, window_end_ms=50000, last_scan_start_ms=last)
        self.assertEqual(
            {k: r[k] for k in ("flips", "detectable", "detected", "undetected", "reverted", "afterLastScan", "comboNotScanned")},
            {"flips": 6, "detectable": 2, "detected": 1, "undetected": 1, "reverted": 1, "afterLastScan": 2, "comboNotScanned": 1},
        )
        self.assertEqual(r["p50Ms"], 3000.0)
        # 沒給 last_scan_start_ms 時只用 window 判斷（30000 的釋位改算 undetected）
        r2 = analysis.detection_latency(flips, released, window_end_ms=50000)
        self.assertEqual((r2["undetected"], r2["afterLastScan"], r2["comboNotScanned"]), (3, 1, 0))


class TestReplayDb(unittest.TestCase):
    """契約 §7.3：實驗只碰 replay schema 的 slot／slot_event／scan_log，任務量測讀 public.scan_task_log WHERE target='replay'。"""

    def test_sql_only_touches_replay_schema(self):
        from common import db

        for sql in db.ALL_SQL:
            for table in ("slot", "slot_event", "scan_log"):
                # 不帶 schema 或帶 public. 的 slot／slot_event／scan_log 都不允許
                for m in re.finditer(rf"(?<![\w.])((?:\w+\.)?){table}(?![\w])", sql):
                    self.assertEqual(m.group(1), "replay.", f"{sql!r} 碰到非 replay schema 的 {table}")
            if "scan_task_log" in sql:
                self.assertIn("public.scan_task_log", sql)
                self.assertIn("target = 'replay'", sql)
        self.assertEqual(db.TRUNCATE_REPLAY_SQL, "TRUNCATE replay.slot, replay.slot_event, replay.scan_log RESTART IDENTITY")

    def test_experiment_scripts_have_no_raw_sql_on_live_tables(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        pat = re.compile(r"\b(FROM|INTO|UPDATE|TRUNCATE|JOIN)\s+(public\.)?(slot|slot_event|scan_log)\b", re.I)
        for d, _, files in os.walk(root):
            if "tests" in d:
                continue
            for f in files:
                if f.endswith(".py"):
                    with open(os.path.join(d, f), encoding="utf-8") as fh:
                        self.assertIsNone(pat.search(fh.read()), f"{f} 有直接讀寫 public 的 slot／slot_event／scan_log")

    def test_reset_replay_db_dry_run_and_skip_do_not_connect(self):
        from common import db

        with mock.patch.object(db, "connect") as conn, redirect_stdout(io.StringIO()) as out:
            self.assertFalse(db.reset_replay_db({}, dry_run=True))
            self.assertFalse(db.reset_replay_db({}, dry_run=False, skip=True))
        conn.assert_not_called()
        self.assertIn("TRUNCATE replay.slot", out.getvalue())

    def test_reset_replay_db_truncates_and_closes(self):
        from common import db

        fake = mock.MagicMock()
        with mock.patch.object(db, "connect", return_value=fake), redirect_stdout(io.StringIO()):
            self.assertTrue(db.reset_replay_db({}, dry_run=False))
        calls = [c.args[0] for c in fake.cursor.return_value.__enter__.return_value.execute.call_args_list]
        self.assertEqual(calls, [db.LOCK_TIMEOUT_SQL, db.TRUNCATE_REPLAY_SQL, "RESET lock_timeout"])
        fake.close.assert_called_once()

    def test_db_secret_fetched_once(self):
        from common import db

        sm = mock.Mock()
        sm.get_secret_value.return_value = {"SecretString": json.dumps({"username": "u", "password": "p"})}
        db._SECRET_CACHE.clear()
        with mock.patch("common.awsclients.client", return_value=sm):
            for _ in range(3):
                self.assertEqual(db._db_secret("arn:x")["username"], "u")
        self.assertEqual(sm.get_secret_value.call_count, 1)
        db._SECRET_CACHE.clear()


class TestE2Main(TmpResults):
    """用 mock 驅動 fault_inject.main()：結束碼與還原行為。"""

    def run_e2(self, restore_fails=False, reset_delay_fails=False):
        from e2_ha import fault_inject as fi
        from common import replay_admin

        groups = {"w": "sa,sb", "api": "sa2,sb2"}
        azs = {"sa": "us-east-1a", "sb": "us-east-1b", "sa2": "us-east-1a", "sb2": "us-east-1b"}
        asg = mock.Mock()
        asg.describe_auto_scaling_groups.side_effect = lambda AutoScalingGroupNames: {  # noqa: N803
            "AutoScalingGroups": [{"VPCZoneIdentifier": groups[AutoScalingGroupNames[0]]}]
        }
        restores = {"n": 0}

        def update(AutoScalingGroupName, VPCZoneIdentifier):  # noqa: N803
            if restore_fails and "," in VPCZoneIdentifier and AutoScalingGroupName == "w":
                restores["n"] += 1
                raise RuntimeError("ExpiredToken")
            groups[AutoScalingGroupName] = VPCZoneIdentifier

        asg.update_auto_scaling_group.side_effect = update
        ec2 = mock.Mock()
        ec2.describe_subnets.side_effect = lambda SubnetIds: {  # noqa: N803
            "Subnets": [{"SubnetId": x, "AvailabilityZone": azs[x]} for x in SubnetIds]
        }
        clients = {"autoscaling": asg, "ec2": ec2, "rds": mock.Mock(), "sqs": mock.Mock()}
        combos = tasks.load_combos()
        rows = [
            {"license_type": c["licenseType"], "dmv_no": c["dmvNo"], "enqueued_at": 1, "started_at": 2, "committed_at": 3,
             "finished_at": 4, "outcome": "ok", "receive_count": 1, "az": "us-east-1b", "worker_id": "i-1"}
            for c in combos
        ]
        resets = []

        def fake_reset(url, **kw):
            resets.append(kw)
            if reset_delay_fails and kw.get("delayMs") == 5000:
                raise RuntimeError("replay 掛了")
            return {}

        argv = ["--confirm", "--no-rds", "--block-az", "--post-seconds", "0", "--fault-after", "0",
                "--queue-url", "q", "--worker-asg", "w", "--api-asg", "api", "--api-url", "http://api", "--replay-url", "http://10.0.0.1:8080"]
        with mock.patch("common.awsclients.client", side_effect=lambda n: clients[n]), \
                mock.patch.object(fi, "instances_in_az", return_value={"w": ["i-a"], "api": []}), \
                mock.patch.object(fi, "reset_replay_db"), \
                mock.patch.object(fi, "send_tasks", return_value={"sent": 360}), \
                mock.patch.object(fi, "Probe") as probe, \
                mock.patch.object(replay_admin, "stats", return_value={"delayMs": 500}), \
                mock.patch.object(replay_admin, "reset", side_effect=fake_reset), \
                mock.patch("common.db.connect"), \
                mock.patch("common.db.wait_run_finished", return_value=True), \
                mock.patch("common.db.fetch_run_rows", return_value=rows), \
                mock.patch("time.sleep"), redirect_stdout(io.StringIO()) as out:
            probe.return_value.samples = []
            probe.return_value.errors = []
            try:
                rc = fi.main(argv)
            except RuntimeError as e:
                rc = e
        return rc, groups, resets, out.getvalue()

    def test_exit_0_when_all_restored(self):
        rc, groups, resets, _ = self.run_e2()
        self.assertEqual(rc, 0)
        self.assertEqual(groups, {"w": "sa,sb", "api": "sa2,sb2"})
        self.assertEqual([r["delayMs"] for r in resets], [5000, 500])

    def test_exit_3_when_subnet_restore_fails(self):
        rc, groups, _, out = self.run_e2(restore_fails=True)
        self.assertEqual(rc, 3)
        self.assertEqual(groups["api"], "sa2,sb2")
        self.assertIn("手動還原", out)

    def test_delay_restored_even_if_raising_delay_fails(self):
        rc, _, resets, _ = self.run_e2(reset_delay_fails=True)
        self.assertIsInstance(rc, RuntimeError)
        self.assertEqual([r["delayMs"] for r in resets], [5000, 500])


class TestBlockAz(unittest.TestCase):
    """E2 --block-az：先驗證所有 ASG 再改；中途失敗時已改的 ASG 一定記在 original，finally 逐一還原。"""

    def setUp(self):
        from e2_ha import fault_inject

        self.fi = fault_inject
        self.groups = {"w": "sa,sb", "api": "sa2,sb2"}
        self.azs = {"sa": "us-east-1a", "sb": "us-east-1b", "sa2": "us-east-1a", "sb2": "us-east-1b", "only-a": "us-east-1a"}
        self.asg = mock.Mock()
        self.asg.describe_auto_scaling_groups.side_effect = lambda AutoScalingGroupNames: {  # noqa: N803
            "AutoScalingGroups": [{"VPCZoneIdentifier": self.groups[AutoScalingGroupNames[0]]}]
        }
        self.ec2 = mock.Mock()
        self.ec2.describe_subnets.side_effect = lambda SubnetIds: {  # noqa: N803
            "Subnets": [{"SubnetId": s, "AvailabilityZone": self.azs[s]} for s in SubnetIds]
        }

    def test_second_asg_update_fails_first_is_recorded_and_restored(self):
        def update(AutoScalingGroupName, VPCZoneIdentifier):  # noqa: N803
            if AutoScalingGroupName == "api" and VPCZoneIdentifier == "sb2":
                raise RuntimeError("Throttling")
            self.groups[AutoScalingGroupName] = VPCZoneIdentifier

        self.asg.update_auto_scaling_group.side_effect = update
        original = {}
        with redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError):
                self.fi.block_az(self.asg, self.ec2, ["w", "api"], "us-east-1a", original)
            self.assertEqual(self.groups["w"], "sb")
            self.assertEqual(original, {"w": "sa,sb", "api": "sa2,sb2"})
            failed = self.fi.restore_subnets(self.asg, original)
        self.assertEqual(failed, [])
        self.assertEqual(self.groups, {"w": "sa,sb", "api": "sa2,sb2"})

    def test_validation_failure_changes_nothing(self):
        self.groups["api"] = "only-a"
        original = {}
        with redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            self.fi.block_az(self.asg, self.ec2, ["w", "api"], "us-east-1a", original)
        self.asg.update_auto_scaling_group.assert_not_called()
        self.assertEqual(original, {})

    def test_restore_continues_after_one_failure_and_prints_manual_command(self):
        def update(AutoScalingGroupName, VPCZoneIdentifier):  # noqa: N803
            if AutoScalingGroupName == "w":
                raise RuntimeError("ExpiredToken")
            self.groups[AutoScalingGroupName] = VPCZoneIdentifier

        self.asg.update_auto_scaling_group.side_effect = update
        self.groups = {"w": "sb", "api": "sb2"}
        with redirect_stdout(io.StringIO()) as out:
            failed = self.fi.restore_subnets(self.asg, {"w": "sa,sb", "api": "sa2,sb2"})
        self.assertEqual(failed, ["w"])
        self.assertEqual(self.groups["api"], "sa2,sb2")
        self.assertIn('--auto-scaling-group-name w --vpc-zone-identifier "sa,sb"', out.getvalue())


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
        # Lambda 的 Receive 已算在 sqsPolling，每次掃描只算 Send＋Delete，不重複計算
        self.assertAlmostEqual(r["scanning"]["sqs"], scans * 2 / 1e6 * self.P["sqs"]["perMillionRequests"])
        e = self.cm.ec2_model(self.P, a, 1)
        self.assertAlmostEqual(e["scanning"]["sqs"], scans * 3 / 1e6 * self.P["sqs"]["perMillionRequests"])

    def test_platform_includes_public_ipv4_and_secrets(self):
        f = self.cm.platform_fixed(self.P, self.cm.DEFAULTS)
        self.assertAlmostEqual(f["publicIpv4"], 4 * 0.005 * 730)
        self.assertAlmostEqual(f["secretsManager"], 0.8)
        self.assertEqual(f["cloudfront"], 0)

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
        self.assertNotIn("TRUNCATE", out)  # E1 預設不清 replay schema
        self.assert_result("e1")

    def test_e1_truncate_is_opt_in(self):
        rc, out = self.run_main("e1_scalability.enqueue_burst", ["--dry-run", "--truncate-replay-db"])
        self.assertEqual(rc, 0)
        self.assertIn("TRUNCATE replay.slot", out)

    def test_e1_monitor(self):
        rc, out = self.run_main("e1_scalability.monitor_asg", ["--dry-run"])
        self.assertEqual(rc, 0)
        self.assertIn("[dry-run]", out)

    def test_e2_fault_inject(self):
        rc, out = self.run_main("e2_ha.fault_inject", ["--dry-run", "--az", "us-east-1a"])
        self.assertEqual(rc, 0)
        self.assertIn("ForceFailover", out)
        self.assertIn("TRUNCATE replay.slot, replay.slot_event, replay.scan_log", out)
        self.assert_result("e2")

    def test_e2_requires_confirm(self):
        with self.assertRaises(SystemExit) as cm:
            self.run_main("e2_ha.fault_inject", [])
        self.assertIn("--confirm", str(cm.exception))

    def test_e3_run_scaling(self):
        rc, out = self.run_main("e3_performance.run_scaling", ["--dry-run", "--workers", "1,2,4,8"])
        self.assertEqual(rc, 0)
        self.assertIn("n=8", out)
        self.assertIn("TRUNCATE replay.slot", out)
        self.assert_result("e3")

    def test_e3_repeat_multiplies_measure_round(self):
        rc, out = self.run_main("e3_performance.run_scaling", ["--dry-run", "--workers", "8", "--repeat", "10", "--keep-replay-db"])
        self.assertEqual(rc, 0)
        self.assertIn("量測 3600 則", out)
        self.assertNotIn("TRUNCATE", out)

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
