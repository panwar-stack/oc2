# PYTHONPATH="$PWD" harbor run \
#   --dataset terminal-bench/terminal-bench-2-1 \
#   --agent benchmark.oc2_agent:OC2Agent \
#   --model openai/gpt-5.4 \
#   --agent-env OPENAI_API_KEY="$OPENAI_API_KEY" \
#   --n-concurrent 1 \
#   --n-tasks 1
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.installed.opencode import OpenCode
from harbor.environments.base import BaseEnvironment


class OC2Agent(OpenCode):
    @staticmethod
    def name() -> str:
        return "oc2"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment,
            ("bash", "curl", "tar"),
        )

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                "curl -fsSL https://panwar-stack.github.io/oc2/install | bash && "
                'OC2_BIN="$(command -v oc2 || true)"; '
                'if [ -z "$OC2_BIN" ]; then '
                '  OC2_BIN="$(find "$HOME" -type f -path "*/bin/oc2" '
                '-perm -u+x 2>/dev/null | head -n 1)"; '
                "fi; "
                'test -n "$OC2_BIN"; '
                'ln -sf "$OC2_BIN" "$(dirname "$(command -v node)")/opencode"; '
                "opencode --version"
            ),
        )