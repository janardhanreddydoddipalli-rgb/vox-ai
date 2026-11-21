"""Write the API's OpenAPI schema to packages/api-client/openapi.json (stable, sorted).

    uv run python scripts/export_openapi.py          # write
    uv run python scripts/export_openapi.py --check  # exit 1 if the committed file is stale

Built from code with placeholder settings: no database, no secrets, no server.
"""

import json
import sys
from pathlib import Path

from pydantic import SecretStr

from vox_api.core.config import Settings
from vox_api.main import create_app

OUT = Path(__file__).resolve().parents[3] / "packages" / "api-client" / "openapi.json"


def render() -> str:
    settings = Settings(
        _env_file=None,
        environment="development",
        database_url=SecretStr("postgresql://unused:unused@localhost/unused"),
        web_origin="http://localhost:3000",
        jwt_public_key=SecretStr("unused"),
        internal_api_token=SecretStr("x" * 32),
    )
    schema = create_app(settings).openapi()
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


def main() -> int:
    text = render()
    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != text:
            print(f"{OUT} is stale: run `make api-openapi`", file=sys.stderr)
            return 1
        print("openapi.json is up to date")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {OUT} ({len(text)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
