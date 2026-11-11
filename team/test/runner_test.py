import unittest, tempfile, json, importlib.util, pathlib, subprocess, hashlib, urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "execute", pathlib.Path(__file__).parents[1] / "runner/execute.py"
)
execute = importlib.util.module_from_spec(spec)
spec.loader.exec_module(execute)


class Response:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class RunnerTests(unittest.TestCase):
    def scenario(self, conflict=False, fail=False):
        with tempfile.TemporaryDirectory() as d:
            home = pathlib.Path(d)
            h = home / ".inkboard-team"
            h.mkdir()
            (home / ".dsh").mkdir()
            (home / ".dsh/.credentials.yaml").write_text(
                "refs:\n  DEEPSEEK_API_KEY: fake-test-key\n"
            )
            (h / "config.json").write_text(
                json.dumps({"url": "https://test.invalid", "runnerToken": "fake-token"})
            )
            task = {
                "id": "test-task",
                "repo": "OmnixSI/WhalePartner",
                "title": "test",
                "detail": "test",
                "lease": "lease",
                "version": 2,
            }
            (h / "current.json").write_text(json.dumps(task))
            execute.H = h
            key = hashlib.sha256(task["id"].encode()).hexdigest()[:32]
            work = h / "work" / key
            (work / "apps/api").mkdir(parents=True)
            (work / "apps/api/package.json").write_text(
                '{"scripts":{"test":"node --test"}}'
            )
            (h / "repos/WhalePartner").mkdir(parents=True)
            calls = []

            def fake(args, **kwargs):
                calls.append(args)
                if args[0].endswith("/dsh"):
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        json.dumps(
                            {
                                "type": "final",
                                "reason": {"kind": "completed"},
                                "text": "已完成",
                            }
                        )
                        + "\n",
                        "",
                    )
                if args[:2] == ["npm", "test"]:
                    return subprocess.CompletedProcess(
                        args,
                        1 if fail else 0,
                        "tests failed" if fail else "tests passed",
                        "",
                    )
                text = ""
                if args[:3] == ["git", "ls-files", "--modified"]:
                    text = "apps/api/src/test.ts\n"
                if args[:3] == ["git", "status", "--porcelain"]:
                    text = " M apps/api/src/test.ts\n"
                if args[:4] == ["git", "diff", "--cached", "--name-only"]:
                    text = "apps/api/src/test.ts\n"
                if args[:3] == ["gh", "pr", "create"]:
                    text = "https://github.com/example/test/pull/1"
                return subprocess.CompletedProcess(args, 0, text, "")

            with patch.object(pathlib.Path, "home", return_value=home), patch.object(
                execute.subprocess, "run", side_effect=fake
            ), patch(
                "urllib.request.urlopen",
                side_effect=(
                    urllib.error.HTTPError(
                        "https://test.invalid", 409, "conflict", {}, None
                    )
                    if conflict
                    else lambda *a, **kw: Response()
                ),
            ):
                execute.main()
            result = json.loads(next((h / "results").glob("*.json")).read_text())
            return result, calls

    def test_success_publishes_only_draft_after_tests(self):
        r, calls = self.scenario()
        self.assertEqual(r["status"], "ready_for_review")
        self.assertTrue(any(c[:3] == ["git", "push", "-u"] for c in calls))
        self.assertTrue(any("--draft" in c for c in calls))
        self.assertFalse(any("merge" in c for c in calls))

    def test_human_change_prevents_push(self):
        r, calls = self.scenario(conflict=True)
        self.assertEqual(r["status"], "needs_human")
        self.assertFalse(any(c[:2] == ["git", "push"] for c in calls))

    def test_two_failed_validations_stop(self):
        r, calls = self.scenario(fail=True)
        self.assertEqual(r["status"], "needs_human")
        self.assertEqual(sum(c[:2] == ["npm", "test"] for c in calls), 2)
        self.assertFalse(any(c[:2] == ["git", "push"] for c in calls))


if __name__ == "__main__":
    unittest.main()
