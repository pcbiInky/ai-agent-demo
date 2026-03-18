#!/usr/bin/env python3
"""
Office document worker — JSON-over-stdio protocol.

Reads one JSON command per line from stdin, writes one JSON response per line to stdout.
Logs go to stderr only.

Protocol v1:
  Request:  {"id": "...", "protocol_version": 1, "action": "...", "params": {...}}
  Response: {"id": "...", "protocol_version": 1, "ok": true, "result": {...}}
       or:  {"id": "...", "protocol_version": 1, "ok": false, "error": {"code": "...", "message": "...", "details": ...}}
"""

import json
import sys
import traceback

from handlers import docx_handler, pptx_handler

PROTOCOL_VERSION = 1

HANDLERS = {
    "docx": docx_handler,
    "pptx": pptx_handler,
}


def log(msg):
    print(f"[office-worker] {msg}", file=sys.stderr, flush=True)


def make_error(code, message, details=None):
    err = {"code": code, "message": message}
    if details is not None:
        err["details"] = details
    return err


def handle_request(req):
    action = req.get("action")
    params = req.get("params", {})

    if action == "ping":
        return {"pong": True, "protocol_version": PROTOCOL_VERSION}

    if action == "analyze":
        doc_type = params.get("doc_type")
        file_path = params.get("file_path")
        mode = params.get("mode", "summary")
        if not doc_type or not file_path:
            raise WorkerError("INVALID_PARAMS", "doc_type and file_path are required")
        handler = HANDLERS.get(doc_type)
        if not handler:
            raise WorkerError("UNSUPPORTED_DOC_TYPE", f"Unsupported doc_type: {doc_type}")
        if mode == "summary":
            return handler.analyze_summary(file_path)
        elif mode == "search":
            query = params.get("query")
            if not query:
                raise WorkerError("INVALID_PARAMS", "search mode requires 'query' param")
            return handler.analyze_search(file_path, query)
        else:
            raise WorkerError("INVALID_PARAMS", f"Unsupported mode: {mode}")

    if action == "apply_operations":
        doc_type = params.get("doc_type")
        file_path = params.get("file_path")
        operations = params.get("operations")
        if not doc_type or not file_path or not operations:
            raise WorkerError("INVALID_PARAMS", "doc_type, file_path, and operations are required")
        handler = HANDLERS.get(doc_type)
        if not handler:
            raise WorkerError("UNSUPPORTED_DOC_TYPE", f"Unsupported doc_type: {doc_type}")
        return handler.apply_operations(file_path, operations)

    raise WorkerError("UNKNOWN_ACTION", f"Unknown action: {action}")


class WorkerError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = details


def main():
    log("Worker started, waiting for commands...")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            resp = {
                "id": None,
                "protocol_version": PROTOCOL_VERSION,
                "ok": False,
                "error": make_error("INVALID_JSON", f"Invalid JSON: {e}"),
            }
            print(json.dumps(resp), flush=True)
            continue

        req_id = req.get("id")
        try:
            result = handle_request(req)
            resp = {"id": req_id, "protocol_version": PROTOCOL_VERSION, "ok": True, "result": result}
        except WorkerError as e:
            resp = {
                "id": req_id,
                "protocol_version": PROTOCOL_VERSION,
                "ok": False,
                "error": make_error(e.code, str(e), e.details),
            }
        except Exception as e:
            log(f"Error handling {req.get('action')}: {traceback.format_exc()}")
            resp = {
                "id": req_id,
                "protocol_version": PROTOCOL_VERSION,
                "ok": False,
                "error": make_error("INTERNAL_ERROR", str(e)),
            }

        print(json.dumps(resp, default=str), flush=True)


if __name__ == "__main__":
    main()
