#!/usr/bin/env python3
"""
EdgeAnalyzer Generic Python Agent Runner (MVP 4)

Spawns inside the registered agent's `uv` environment:
  uv run --project <folderPath> python <daemonRoot>/agents/edge_runner.py --manifest <folderPath>/edge-agent.json

Guarantees:
  1. Duplicates file descriptor 1 to a dedicated JSONL protocol stream before redirecting
     sys.stdout -> sys.stderr so stray print() calls never corrupt JSONL framing.
  2. Supports both sync `def build_agent(context)` and `async def build_agent(context)`.
  3. Streams LangGraph updates (`astream` / `stream`), Todo lists, and __interrupt__ pauses
     (both `hitl_approval` and `user_input`), resuming via `Command(resume=...)` over stdin.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import inspect
import json
import mimetypes
import os
import sys
import traceback
import uuid
from pathlib import Path
from typing import Any

# ============================================================================
# 1. CRITICAL: Isolate Protocol Stdout BEFORE importing user modules
# ============================================================================
_PROTO_FD = os.dup(1)
_PROTO_OUT = os.fdopen(_PROTO_FD, "w", encoding="utf-8", buffering=1)
try:
    os.dup2(2, 1)
except OSError:
    pass
sys.stdout = sys.stderr


def emit(event_obj: dict[str, Any]) -> None:
    """Write a single JSONL control frame to the isolated protocol pipe."""
    line = json.dumps(event_obj, ensure_ascii=False, default=str)
    _PROTO_OUT.write(line + "\n")
    _PROTO_OUT.flush()


def _safe_str(val: Any, max_len: int = 400) -> str:
    text = val if isinstance(val, str) else json.dumps(val, ensure_ascii=False, default=str)
    return text if len(text) <= max_len else text[:max_len] + "…"


def _extract_message_text(msg: Any) -> str:
    content = getattr(msg, "content", None)
    if content is None and isinstance(msg, dict):
        content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
        return "".join(parts)
    return ""


def _guess_mime(file_path: Path) -> str:
    suffix = file_path.suffix.lower()
    if suffix == ".md":
        return "text/markdown"
    if suffix == ".json":
        return "application/json"
    if suffix == ".csv":
        return "text/csv"
    if suffix == ".txt":
        return "text/plain"
    guessed, _ = mimetypes.guess_type(str(file_path))
    return guessed or "application/octet-stream"


def _scan_artifacts(run_dir: Path, emitted_paths: set[str]) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    if not run_dir.exists():
        return artifacts

    allowed_exts = {".md", ".json", ".txt", ".csv", ".html"}
    for item in sorted(run_dir.rglob("*")):
        if not item.is_file():
            continue
        if item.suffix.lower() not in allowed_exts:
            continue
        try:
            rel_posix = item.relative_to(run_dir).as_posix()
            size_bytes = item.stat().st_size
            mime = _guess_mime(item)
            artifact_meta = {
                "path": rel_posix,
                "size_bytes": size_bytes,
                "mime": mime,
            }
            artifacts.append(artifact_meta)
            if rel_posix not in emitted_paths:
                emitted_paths.add(rel_posix)
                emit({"event": "artifact", **artifact_meta})
        except OSError:
            continue
    return artifacts


def _classify_interrupt(interrupt_obj: Any) -> tuple[str, str, dict[str, Any], Any]:
    """
    Returns (interrupt_id, kind, payload, response_schema).
    Recognizes:
      - DeepAgents / HITL `action_requests` dicts -> kind = "hitl_approval"
      - Approval dicts with `tasks` + `message` -> kind = "hitl_approval"
      - Everything else -> kind = "user_input"
    """
    raw_value = getattr(interrupt_obj, "value", interrupt_obj)
    int_id = (
            getattr(interrupt_obj, "id", None)
            or getattr(interrupt_obj, "interrupt_id", None)
            or f"int_{uuid.uuid4().hex[:10]}"
    )
    response_schema = getattr(interrupt_obj, "response_schema", None)

    if isinstance(raw_value, dict):
        if "action_requests" in raw_value:
            return str(int_id), "hitl_approval", raw_value, response_schema
        if "tasks" in raw_value and "message" in raw_value:
            return str(int_id), "hitl_approval", raw_value, response_schema
        if raw_value.get("kind") == "hitl_approval":
            return str(int_id), "hitl_approval", raw_value, response_schema
        return str(int_id), "user_input", raw_value, response_schema

    return str(int_id), "user_input", {"prompt": str(raw_value)}, response_schema


def _process_update_chunk(
        chunk: Any,
        last_answer_holder: list[str],
) -> Any | None:
    """
    Processes a single LangGraph `stream_mode="updates"` chunk (with or without `subgraphs=True`).
    Returns an interrupt object if `__interrupt__` was encountered, else None.
    """
    namespace: tuple[Any, ...] = ()
    update: Any = chunk

    if isinstance(chunk, tuple) and len(chunk) == 2 and isinstance(chunk[0], tuple):
        namespace, update = chunk

    if not isinstance(update, dict):
        return None

    if "__interrupt__" in update and update["__interrupt__"]:
        interrupts = update["__interrupt__"]
        return interrupts[0] if isinstance(interrupts, (list, tuple)) else interrupts

    who = "subagent" if len(namespace) > 0 else "manager"

    for node_name, node_val in update.items():
        if node_name == "__interrupt__":
            continue

        if not isinstance(node_val, dict):
            emit(
                {
                    "event": "node_step",
                    "who": who,
                    "node": str(node_name),
                    "action": "message",
                    "summary": _safe_str(node_val, 300),
                }
            )
            continue

        # 1. Todo updates (DeepAgents / custom planner)
        todos = node_val.get("todos")
        if isinstance(todos, list):
            normalized_todos = []
            for t in todos:
                if isinstance(t, dict):
                    normalized_todos.append(
                        {
                            "content": str(t.get("content") or t.get("task") or t.get("question") or ""),
                            "status": str(t.get("status") or "pending"),
                        }
                    )
                else:
                    normalized_todos.append({"content": str(t), "status": "pending"})
            emit({"event": "todo_update", "todos": normalized_todos})

        # 2. Message-based agent outputs (tool_call / tool_result / message)
        messages = node_val.get("messages")
        emitted_from_messages = False
        if isinstance(messages, list) and len(messages) > 0:
            for msg in messages:
                tool_calls = getattr(msg, "tool_calls", None)
                if tool_calls is None and isinstance(msg, dict):
                    tool_calls = msg.get("tool_calls")

                msg_type = getattr(msg, "type", None) or (
                    msg.get("role") if isinstance(msg, dict) else ""
                )

                if tool_calls:
                    emitted_from_messages = True
                    for tc in tool_calls:
                        tc_name = tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", "tool")
                        tc_args = tc.get("args") if isinstance(tc, dict) else getattr(tc, "args", {})
                        emit(
                            {
                                "event": "node_step",
                                "who": who,
                                "node": str(node_name),
                                "action": "tool_call",
                                "summary": f"{tc_name}({_safe_str(tc_args, 200)})",
                            }
                        )
                elif msg_type == "tool":
                    emitted_from_messages = True
                    tool_name = getattr(msg, "name", None) or (
                        msg.get("name") if isinstance(msg, dict) else "tool"
                    )
                    emit(
                        {
                            "event": "node_step",
                            "who": who,
                            "node": str(node_name),
                            "action": "tool_result",
                            "summary": f"{tool_name}: {_safe_str(_extract_message_text(msg), 240)}",
                        }
                    )
                else:
                    text = _extract_message_text(msg).strip()
                    if text:
                        emitted_from_messages = True
                        last_answer_holder[0] = text
                        emit(
                            {
                                "event": "node_step",
                                "who": who,
                                "node": str(node_name),
                                "action": "message",
                                "summary": _safe_str(text, 300),
                            }
                        )

        # 3. Non-message StateGraph updates (e.g., plan, draft, critique, status)
        if not emitted_from_messages:
            if isinstance(node_val.get("draft"), str) and node_val["draft"].strip():
                last_answer_holder[0] = node_val["draft"]
            if isinstance(node_val.get("final_answer"), str) and node_val["final_answer"].strip():
                last_answer_holder[0] = node_val["final_answer"]

            keys_summary = ", ".join(
                f"{k}={_safe_str(v, 100)}"
                for k, v in node_val.items()
                if k not in ("todos",)
            )
            emit(
                {
                    "event": "node_step",
                    "who": who,
                    "node": str(node_name),
                    "action": "message",
                    "summary": _safe_str(keys_summary or f"Completed node {node_name}", 320),
                }
            )

    return None


def _make_resume_command(resume_value: Any) -> Any:
    try:
        from langgraph.types import Command  # type: ignore

        return Command(resume=resume_value)
    except Exception:
        return {"__edge_resume__": True, "resume": resume_value}


async def _wait_for_resume(expected_interrupt_id: str) -> Any:
    """Blocks on sys.stdin waiting for a JSONL resume command from AgentRunManager."""
    while True:
        raw_line = await asyncio.to_thread(sys.stdin.readline)
        if not raw_line:
            raise RuntimeError("stdin closed before interrupt was resumed")
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        incoming_id = msg.get("interrupt_id")
        if incoming_id and str(incoming_id) != str(expected_interrupt_id):
            continue
        return msg.get("resume")


async def _run_graph_loop(
        agent: Any,
        initial_payload: Any,
        run_cfg: dict[str, Any],
        run_dir: Path,
        emitted_artifacts: set[str],
) -> str:
    payload = initial_payload
    last_answer = [""]

    while True:
        caught_interrupt: Any | None = None

        # Prefer async stream (`astream`), fall back to sync `stream`
        if hasattr(agent, "astream") and callable(agent.astream):
            try:
                async for chunk in agent.astream(
                        payload, config=run_cfg, stream_mode="updates", subgraphs=True
                ):
                    caught = _process_update_chunk(chunk, last_answer)
                    if caught is not None:
                        caught_interrupt = caught
            except TypeError:
                async for chunk in agent.astream(payload, config=run_cfg):
                    caught = _process_update_chunk(chunk, last_answer)
                    if caught is not None:
                        caught_interrupt = caught
            except NotImplementedError:
                for chunk in agent.stream(
                        payload, config=run_cfg, stream_mode="updates", subgraphs=True
                ):
                    caught = _process_update_chunk(chunk, last_answer)
                    if caught is not None:
                        caught_interrupt = caught
        elif hasattr(agent, "stream") and callable(agent.stream):
            try:
                for chunk in agent.stream(
                        payload, config=run_cfg, stream_mode="updates", subgraphs=True
                ):
                    caught = _process_update_chunk(chunk, last_answer)
                    if caught is not None:
                        caught_interrupt = caught
            except TypeError:
                for chunk in agent.stream(payload, config=run_cfg):
                    caught = _process_update_chunk(chunk, last_answer)
                    if caught is not None:
                        caught_interrupt = caught
        elif callable(agent):
            res = agent(payload)
            if inspect.isawaitable(res):
                res = await res
            last_answer[0] = _safe_str(res, 4000)
            break
        else:
            raise TypeError(
                "build_agent(context) must return a compiled LangGraph graph (with astream/stream) or callable"
            )

        # Scan for any intermediate artifacts generated before pausing or finishing
        _scan_artifacts(run_dir, emitted_artifacts)

        if caught_interrupt is not None:
            int_id, kind, int_payload, response_schema = _classify_interrupt(caught_interrupt)
            emit(
                {
                    "event": "interrupt",
                    "interrupt_id": int_id,
                    "kind": kind,
                    "payload": int_payload,
                    "response_schema": response_schema,
                }
            )
            resume_val = await _wait_for_resume(int_id)
            payload = _make_resume_command(resume_val)
            continue

        break

    return last_answer[0]


async def main() -> None:
    parser = argparse.ArgumentParser(description="EdgeAnalyzer Python Agent Runner")
    parser.add_argument("--manifest", required=True, help="Path to edge-agent.json")
    args = parser.parse_args()

    manifest_path = Path(args.manifest).resolve()
    manifest_dir = manifest_path.parent
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    run_id = os.environ.get("EDGE_RUN_ID", f"run_{uuid.uuid4().hex[:8]}")
    trace_id = os.environ.get("EDGE_TRACE_ID", uuid.uuid4().hex)
    session_id = os.environ.get("EDGE_SESSION_ID", run_id)
    run_dir = Path(os.environ.get("EDGE_RUN_DIR", str(manifest_dir / ".edge_runs" / run_id))).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)

    raw_inputs = os.environ.get("EDGE_RUN_INPUT_JSON", "{}")
    inputs = json.loads(raw_inputs) if raw_inputs else {}

    raw_mounts = os.environ.get("EDGE_MOUNTS_JSON", "{}")
    mounts_raw = json.loads(raw_mounts) if raw_mounts else {}
    mounts = {k: Path(v) for k, v in mounts_raw.items()}

    context: dict[str, Any] = {
        "run_id": run_id,
        "run_dir": run_dir,
        "mounts": mounts,
        "inputs": inputs,
        "mesh_base_url": os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:8080/v1"),
        "mesh_api_key": os.environ.get("OPENAI_API_KEY", ""),
        "trace_id": trace_id,
        "session_id": session_id,
        "emit": emit,
    }

    emit({"event": "status", "status": "RUNNING"})

    if str(manifest_dir) not in sys.path:
        sys.path.insert(0, str(manifest_dir))

    entrypoint = manifest["runtime"]["entrypoint"]
    mod_name, fn_name = entrypoint.split(":", 1)
    mod_name = mod_name.replace("/", ".")
    if mod_name.endswith(".py"):
        mod_name = mod_name[:-3]

    user_mod = importlib.import_module(mod_name)
    build_fn = getattr(user_mod, fn_name)

    cleanup_fn = getattr(user_mod, "cleanup_agent", None)
    agent_obj = build_fn(context)
    if inspect.isawaitable(agent_obj):
        agent_obj = await agent_obj

    # Optional tuple return: (compiled_graph, async_or_sync_cleanup_fn)
    if isinstance(agent_obj, tuple) and len(agent_obj) == 2:
        agent_obj, cleanup_fn = agent_obj

    try:
        payload_builder = getattr(user_mod, "build_initial_payload", None)
        if callable(payload_builder):
            initial_payload = payload_builder(context)
            if inspect.isawaitable(initial_payload):
                initial_payload = await initial_payload
        else:
            brief = inputs.get("brief") or inputs.get("prompt") or inputs.get("query")
            user_content = str(brief) if brief is not None else json.dumps(inputs, ensure_ascii=False)
            initial_payload = {"messages": [{"role": "user", "content": user_content}]}

        run_cfg: dict[str, Any] = {
            "configurable": {"thread_id": session_id},
            "recursion_limit": 60,
            "metadata": {
                "langfuse_session_id": session_id,
                "edge_run_id": run_id,
                "edge_trace_id": trace_id,
            },
        }

        emitted_artifacts: set[str] = set()
        final_answer = await _run_graph_loop(
            agent_obj, initial_payload, run_cfg, run_dir, emitted_artifacts
        )
        all_artifacts = _scan_artifacts(run_dir, emitted_artifacts)

        emit(
            {
                "event": "completed",
                "final_answer": final_answer,
                "artifacts": all_artifacts,
            }
        )
    finally:
        if callable(cleanup_fn):
            try:
                maybe_coro = cleanup_fn(context)
                if inspect.isawaitable(maybe_coro):
                    await maybe_coro
            except Exception as cleanup_err:
                print(f"[edge_runner] cleanup warning: {cleanup_err}", file=sys.stderr)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        emit({"event": "failed", "error": "Interrupted by signal", "traceback": ""})
        sys.exit(130)
    except Exception as exc:
        emit(
            {
                "event": "failed",
                "error": str(exc),
                "traceback": traceback.format_exc(),
            }
        )
        sys.exit(1)