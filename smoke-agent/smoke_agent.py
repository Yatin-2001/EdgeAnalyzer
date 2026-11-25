import time
from types import SimpleNamespace


class SmokeGraph:
    def __init__(self, ctx: dict):
        self.ctx = ctx

    def stream(self, payload, config=None, **kwargs):
        # 1. Test stdout noise immunity (must go to stderr_log, never break JSONL)
        print("NOISY DEBUG STDOUT FROM USER AGENT — SHOULD NOT BREAK PROTOCOL")

        resume_val = None
        if isinstance(payload, dict) and payload.get("__edge_resume__"):
            resume_val = payload.get("resume")
        elif hasattr(payload, "resume"):
            resume_val = payload.resume

        if resume_val is None:
            yield {
                "planner": {
                    "todos": [
                        {"content": "Step 1: Verify stdout isolation", "status": "completed"},
                        {"content": "Step 2: Wait for human approval", "status": "in_progress"},
                    ]
                }
            }
            yield {
                "__interrupt__": [
                    SimpleNamespace(
                        id="int_smoke_approval",
                        value={
                            "message": "Approve writing smoke_report.md?",
                            "tasks": ["Generate smoke_report.md artifact"],
                            "score": 9,
                        },
                        response_schema=None,
                    )
                ]
            }
            return

        delay = float(self.ctx["inputs"].get("sleep_sec") or 0)
        if delay > 0:
            time.sleep(delay)

        report = self.ctx["run_dir"] / "smoke_report.md"
        report.write_text(
            f"# Smoke Report\n\n- Brief: {self.ctx['inputs'].get('brief')}\n- Decision: `{resume_val}`\n",
            encoding="utf-8",
        )
        yield {
            "publisher": {
                "todos": [
                    {"content": "Step 1: Verify stdout isolation", "status": "completed"},
                    {"content": "Step 2: Wait for human approval", "status": "completed"},
                ],
                "final_answer": f"Smoke test completed with decision: {resume_val}",
            }
        }


def build_agent(context: dict):
    return SmokeGraph(context)