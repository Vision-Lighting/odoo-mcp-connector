"""PDFMonkey API client for datasheet generation."""

import os
import time
import requests

PDFMONKEY_API_KEY = os.environ.get("PDFMONKEY_API_KEY", "")
PDFMONKEY_TEMPLATE_ID = os.environ.get("PDFMONKEY_TEMPLATE_ID", "")

BASE_URL = "https://api.pdfmonkey.io/api/v1"
HEADERS = {
    "Authorization": f"Bearer {PDFMONKEY_API_KEY}",
    "Content-Type": "application/json",
}


def generate_document(payload: dict, template_id: str | None = None) -> dict:
    """
    Submit a document for generation and poll until complete.

    Returns dict with:
      - document_id
      - status  ("success" | "error")
      - download_url  (when status == "success")
      - failure_cause (when status == "error")
    """
    tid = template_id or PDFMONKEY_TEMPLATE_ID
    if not tid:
        raise ValueError("PDFMONKEY_TEMPLATE_ID not set")
    if not PDFMONKEY_API_KEY:
        raise ValueError("PDFMONKEY_API_KEY not set")

    # Create the document
    # Note: template variables are accessed as payload.field_name, so we nest accordingly
    resp = requests.post(
        f"{BASE_URL}/documents",
        headers=HEADERS,
        json={
            "document": {
                "document_template_id": tid,
                "payload": {"payload": payload},
                "status": "pending",
            }
        },
        timeout=30,
    )
    resp.raise_for_status()
    doc = resp.json()["document"]
    doc_id = doc["id"]

    # Poll until done (max 120s)
    for _ in range(40):
        time.sleep(3)
        poll = requests.get(
            f"{BASE_URL}/documents/{doc_id}",
            headers=HEADERS,
            timeout=15,
        )
        poll.raise_for_status()
        doc = poll.json()["document"]
        status = doc.get("status")
        if status == "success":
            return {
                "document_id": doc_id,
                "status": "success",
                "download_url": doc.get("download_url"),
                "filename": doc.get("filename"),
            }
        if status in ("error", "failed"):
            return {
                "document_id": doc_id,
                "status": "error",
                "failure_cause": doc.get("failure_cause"),
            }

    return {"document_id": doc_id, "status": "timeout", "message": "Generation took >120s"}
