"""The agent's LLM layer — swappable behind one method, three providers.

The LLM NEVER touches keys or signatures; it only fills semantic nodes:
plan (objective → watch params), observe (narrate the delivery), decide (re-issue?).
Spend is bounded by the server-quoted ceiling regardless of what it says.

Providers (AGENT_LLM env, default `scripted`):
- `opencode`: the running opencode server (`opencode serve`) — the agent in our demo
  IS opencode; no separate API key (the server carries the user's auth).
- `anthropic`/`openai`: direct SDK calls, if a key exists (optional).
- `scripted`: deterministic fallback — CI and keyless demos still run the full graph.
"""
from __future__ import annotations

import json
import re
from typing import Any, Protocol

from .config import Config


class LlmClient(Protocol):
    def complete(self, system: str, prompt: str) -> str: ...


# ── opencode ────────────────────────────────────────────────────────────────
class OpenCodeLlm:
    """Talks to `opencode serve` over its HTTP API.

    POST /session → session id; POST /session/:id/message → waits synchronously for
    the agent turn. Prompts demand JSON-only output; the parser is tolerant (the model
    may wrap it in prose or code fences).
    """

    def __init__(self, base_url: str, poster: Any | None = None) -> None:
        import requests

        self.base_url = base_url.rstrip("/")
        self._post = poster or (lambda path, body: requests.post(f"{self.base_url}{path}", json=body, timeout=180))

    def complete(self, system: str, prompt: str) -> str:
        session = self._post("/session", {"title": "agenttether-graph"}).json()
        res = self._post(
            f"/session/{session['id']}/message",
            {
                "parts": [{"type": "text", "text": f"{system}\n\n{prompt}"}],
                "tools": {},  # no tools — pure text completion
            },
        ).json()
        texts = [p.get("text", "") for p in res.get("parts", []) if p.get("type") == "text"]
        return "\n".join(t for t in texts if t)


# ── scripted (deterministic) ────────────────────────────────────────────────
class ScriptedLlm:
    """Deterministic stand-in: parse intent from the prompt, return a fixed decision.

    Keeps the graph fully runnable offline — CI, and the demo when no LLM is present.
    """

    def complete(self, system: str, prompt: str) -> str:
        if '"kind": "plan"' in prompt:
            return json.dumps(
                {
                    "target_contract": _extract(prompt, "target_contract"),
                    "min_amount_atomic": _extract(prompt, "min_amount_atomic"),
                    "ttl_seconds": int(_extract(prompt, "ttl_seconds") or 60),
                    "query_intent": "scripted watch",
                }
            )
        if '"kind": "decide"' in prompt:
            budget = int(_extract(prompt, "reissue_budget") or 0)
            used = int(_extract(prompt, "reissues_used") or 0)
            return json.dumps({"decision": "reissue" if used < budget else "done", "reason": "scripted policy"})
        return "ok"


def _extract(prompt: str, key: str) -> str | None:
    # quoted value first ("key": "with spaces ok"), then a bare token (key: 60,)
    match = re.search(rf'"?{key}"?\s*[:=]\s*"([^"]*)"', prompt)
    if match:
        return match.group(1).strip()
    match = re.search(rf'"?{key}"?\s*[:=]\s*([^\s,}}\n]+)', prompt)
    return match.group(1).strip() if match else None


# ── factory + JSON helper ───────────────────────────────────────────────────
def create_llm(config: Config) -> LlmClient:
    if config.llm_provider == "opencode":
        return OpenCodeLlm(config.opencode_url)
    if config.llm_provider in ("anthropic", "openai"):
        raise NotImplementedError(f"{config.llm_provider} adapter lands on demand — use opencode or scripted")
    return ScriptedLlm()


def parse_json(text: str) -> dict[str, Any]:
    """Tolerant JSON extraction: the model may wrap the object in prose or fences."""
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidates = [fenced.group(1) if fenced else None, text]
    for candidate in candidates:
        if not candidate:
            continue
        match = re.search(r"\{.*\}", candidate, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except ValueError:
                continue
    raise ValueError(f"no JSON object in LLM reply: {text[:200]}")
