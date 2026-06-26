import json

import azure.functions as func

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
}


def cors_response(body, status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(
        body=json.dumps(body),
        status_code=status,
        mimetype="application/json",
        headers=CORS_HEADERS,
    )


def cors_options() -> func.HttpResponse:
    return func.HttpResponse(status_code=200, headers=CORS_HEADERS)


def cors_error(message: str, status: int = 500) -> func.HttpResponse:
    return func.HttpResponse(
        body=json.dumps({"error": message}),
        status_code=status,
        mimetype="application/json",
        headers=CORS_HEADERS,
    )
