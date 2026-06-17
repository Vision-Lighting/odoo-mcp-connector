"""Odoo XML-RPC client wrapper.

Environment variables (injected per-server by claude_desktop_config.json):
  ODOO_URL      — base URL of the Odoo instance
  ODOO_DB       — database name
  ODOO_USERNAME — login email
  ODOO_API_KEY  — API key
  ODOO_MODE     — staging | live_ro | live_rw
"""

import xmlrpc.client
import os
import base64
from typing import Any

# Load .env only as fallback (claude_desktop_config injects env vars directly)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

ODOO_URL = os.environ["ODOO_URL"].rstrip("/")
ODOO_DB = os.environ["ODOO_DB"]
ODOO_USERNAME = os.environ["ODOO_USERNAME"]
ODOO_API_KEY = os.environ["ODOO_API_KEY"]
ODOO_MODE = os.environ.get("ODOO_MODE", "staging")


class OdooClient:
    def __init__(self):
        self._uid: int | None = None
        self._common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
        self._models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")

    @property
    def uid(self) -> int:
        if self._uid is None:
            self._uid = self._common.authenticate(
                ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, {}
            )
            if not self._uid:
                raise ConnectionError(
                    "Odoo authentication failed. Check URL, DB, username and API key."
                )
        return self._uid

    @property
    def mode(self) -> str:
        return ODOO_MODE

    def execute(self, model: str, method: str, *args, **kwargs) -> Any:
        return self._models.execute_kw(
            ODOO_DB, self.uid, ODOO_API_KEY, model, method, list(args), kwargs
        )

    # ── Generic CRUD ──────────────────────────────────────────────────────────

    def search_read(
        self,
        model: str,
        domain: list | None = None,
        fields: list[str] | None = None,
        limit: int = 80,
        offset: int = 0,
        order: str | None = None,
    ) -> list[dict]:
        kwargs: dict = {"limit": limit, "offset": offset}
        if fields:
            kwargs["fields"] = fields
        if order:
            kwargs["order"] = order
        return self.execute(model, "search_read", domain or [], **kwargs)

    def search(
        self,
        model: str,
        domain: list | None = None,
        limit: int = 80,
        offset: int = 0,
        order: str | None = None,
    ) -> list[int]:
        kwargs: dict = {"limit": limit, "offset": offset}
        if order:
            kwargs["order"] = order
        return self.execute(model, "search", domain or [], **kwargs)

    def read(self, model: str, ids: list[int], fields: list[str] | None = None) -> list[dict]:
        kwargs: dict = {}
        if fields:
            kwargs["fields"] = fields
        return self.execute(model, "read", ids, **kwargs)

    def create(self, model: str, values: dict) -> int:
        return self.execute(model, "create", values)

    def write(self, model: str, ids: list[int], values: dict) -> bool:
        return self.execute(model, "write", ids, values)

    def unlink(self, model: str, ids: list[int]) -> bool:
        return self.execute(model, "unlink", ids)

    def get_fields(self, model: str, attributes: list[str] | None = None) -> dict:
        kwargs: dict = {}
        if attributes:
            kwargs["attributes"] = attributes
        return self.execute(model, "fields_get", [], **kwargs)

    def call(self, model: str, method: str, ids: list[int], **kwargs) -> Any:
        return self.execute(model, method, ids, **kwargs)

    # ── Image helpers ─────────────────────────────────────────────────────────

    def encode_image_from_url(self, url: str) -> str:
        import requests
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        return base64.b64encode(resp.content).decode()

    # ── Convenience: product helpers ─────────────────────────────────────────

    def get_product_template(self, tmpl_id: int) -> dict:
        records = self.read("product.template", [tmpl_id])
        return records[0] if records else {}

    def get_product_variants(self, tmpl_id: int) -> list[dict]:
        return self.search_read(
            "product.product",
            [["product_tmpl_id", "=", tmpl_id]],
            limit=200,
        )

    # ── Convenience: sales / delivery helpers ────────────────────────────────

    def get_sale_order(self, order_id: int) -> dict:
        records = self.read("sale.order", [order_id])
        return records[0] if records else {}

    def get_pickings_for_sale_order(self, order_id: int) -> list[dict]:
        return self.search_read(
            "stock.picking",
            [["sale_id", "=", order_id], ["state", "not in", ["done", "cancel"]]],
        )

    def get_move_lines(self, picking_id: int) -> list[dict]:
        return self.search_read(
            "stock.move",
            [["picking_id", "=", picking_id]],
        )

    def split_picking(self, picking_id: int, moves_with_qty: list[dict]) -> list[int]:
        """Split a picking. Returns list of new picking IDs (backorders)."""
        self.call("stock.picking", "do_unreserve", [picking_id])

        moves = self.search_read(
            "stock.move",
            [["picking_id", "=", picking_id], ["state", "not in", ["done", "cancel"]]],
            fields=["id", "product_id", "product_uom_qty", "quantity_done"],
        )
        move_map = {m["id"]: m for m in moves}

        for item in moves_with_qty:
            mid = item["move_id"]
            qty = float(item["qty"])
            if mid in move_map:
                self.write("stock.move", [mid], {"quantity_done": qty})

        requested_ids = {item["move_id"] for item in moves_with_qty}
        for mid in move_map:
            if mid not in requested_ids:
                self.write("stock.move", [mid], {"quantity_done": 0})

        result = self.call("stock.picking", "button_validate", [picking_id])

        if isinstance(result, dict) and result.get("res_model") == "stock.backorder.confirmation":
            wizard_id = self.create(
                "stock.backorder.confirmation",
                {"pick_ids": [(4, picking_id)], "show_transfers": False},
            )
            self.call("stock.backorder.confirmation", "process", [wizard_id])

        return self.search("stock.picking", [["backorder_id", "=", picking_id]])


# Singleton
client = OdooClient()
