import unittest, tempfile, pathlib, json, importlib.util, subprocess
from unittest.mock import patch, MagicMock


class UtilityTests(unittest.TestCase):
    def scenario(self, times_out=False, already_sent=False):
        with tempfile.TemporaryDirectory() as temp:
            home = pathlib.Path(temp)
            h = home / ".inkboard-team"
            h.mkdir()
            (h / "config.json").write_text(
                '{"url":"https://example.invalid","runnerToken":"fake"}'
            )
            (home / ".dsh").mkdir()
            (home / ".dsh/.credentials.yaml").write_text(
                "refs:\n  DEEPSEEK_API_KEY: fake-key\n"
            )
            with patch.object(pathlib.Path, "home", return_value=home):
                spec = importlib.util.spec_from_file_location(
                    "utility", pathlib.Path(__file__).parents[1] / "runner/utility.py"
                )
                u = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(u)
            reports = []
            job = {
                "id": "file-test",
                "payload": {
                    "message": "request1",
                    "lease": "lease1",
                    "effort": "high",
                    "instructions": "生成CSV",
                },
            }

            def cloud(path, body):
                if path == "media/claim":
                    return {"job": job}
                reports.append(body)
                return {"ok": True}

            proc = MagicMock()
            proc.pid = 12345
            proc.communicate.side_effect = (
                [subprocess.TimeoutExpired(["private-command"], 120), ("", "")]
                if times_out
                else [
                    (
                        json.dumps(
                            {
                                "type": "final",
                                "reason": {"kind": "completed"},
                                "text": "CSV已生成",
                            }
                        ),
                        "",
                    )
                ]
            )

            def spawn(*a, **kw):
                self.assertEqual(kw["stdin"], subprocess.PIPE)
                self.assertEqual(kw["stdout"], subprocess.PIPE)
                self.assertTrue(kw["start_new_session"])
                out = pathlib.Path(kw["cwd"]) / "outputs/example.csv"
                out.write_text("项目,数量\n大肥鱼,3\n")
                return proc

            if already_sent:
                import hashlib

                q = h / "file-deliveries"
                q.mkdir()
                (
                    q
                    / (
                        hashlib.sha256(job["id"].encode()).hexdigest()[:32]
                        + ".json.sent"
                    )
                ).write_text("{}")
            with patch.object(u, "cloud", side_effect=cloud), patch.object(
                u.subprocess, "Popen", side_effect=spawn
            ), patch.object(u.os, "killpg") as kill, patch.object(
                pathlib.Path, "home", return_value=home
            ):
                u.once()
            return (
                reports,
                (
                    list((h / "file-deliveries").glob("*.json"))
                    if (h / "file-deliveries").exists()
                    else []
                ),
                kill.call_count,
            )

    def test_file_delivery_manifest_and_terminal_report(self):
        reports, files, kills = self.scenario()
        self.assertEqual(len(files), 1)
        self.assertIn("CSV已生成", reports[0]["result"])
        self.assertEqual(kills, 0)

    def test_timeout_kills_group_and_only_reports_human_text(self):
        reports, files, kills = self.scenario(times_out=True)
        self.assertEqual(kills, 1)
        self.assertFalse(reports[0]["success"])
        self.assertNotIn("private-command", reports[0]["result"])
        self.assertEqual(files, [])

    def test_completed_delivery_is_not_enqueued_twice(self):
        reports, files, kills = self.scenario(already_sent=True)
        self.assertEqual(files, [])


if __name__ == "__main__":
    unittest.main()
