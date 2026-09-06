"""AgentTether AI agent client (Phase 5).

Modules:
- config: environment/wire constants (repo-root .env, one source of truth)
- allowance: Permit2 allowance bootstrap (5.2a three-way branch)
"""
from .config import Config, load_config  # noqa: F401
from .allowance import AllowanceBootstrapper, AllowanceReport, FundError  # noqa: F401
