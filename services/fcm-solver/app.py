from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI(title="FCM Solver", docs_url=None, redoc_url=None)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "fcm-solver", "capability": "not_configured"}


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def unavailable(path: str) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"error": "capability_unavailable", "capability": "solver", "path": f"/{path}"},
    )