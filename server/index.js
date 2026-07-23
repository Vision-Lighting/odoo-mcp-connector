#!/usr/bin/env node
/**
 * Odoo MCP Server for Claude Desktop — zero-dependency Node.js implementation.
 *
 * Runs on the Node runtime bundled with Claude Desktop, so users need nothing
 * installed. Talks to Odoo over its JSON-RPC endpoint (/jsonrpc) using the
 * built-in fetch, and speaks MCP over stdio (newline-delimited JSON-RPC).
 *
 * Modes (set via ODOO_MODE env var):
 *   staging  — full access, staging database
 *   live_ro  — read-only, live database
 *   live_rw  — restricted writes (products, quotes, project tasks,
 *              helpdesk tickets, contacts), live database
 */

'use strict';

const readline = require('node:readline');

const SERVER_VERSION = '3.1.0';

// ── Config from env ───────────────────────────────────────────────────────────

// Trim every value — a stray space or newline pasted into the install dialog
// otherwise reaches Odoo verbatim and fails auth with a bare "Access Denied".
const env = (key) => (process.env[key] || '').trim();

const ODOO_URL = env('ODOO_URL').replace(/\/+$/, '');
const ODOO_DB = env('ODOO_DB');
const ODOO_USERNAME = env('ODOO_USERNAME');
const ODOO_API_KEY = env('ODOO_API_KEY');
const MODE = env('ODOO_MODE') || 'live_rw'; // staging | live_ro | live_rw

const PDFMONKEY_API_KEY = env('PDFMONKEY_API_KEY');
const PDFMONKEY_TEMPLATE_ID = env('PDFMONKEY_TEMPLATE_ID');

for (const [k, v] of Object.entries({ ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY })) {
  if (!v) process.stderr.write(`[odoo-mcp] WARNING: ${k} is not set — tools will fail until configured.\n`);
}

// ── Mode configuration ────────────────────────────────────────────────────────

// Models that live_rw may WRITE to
const LIVE_RW_WRITE_MODELS = new Set([
  'product.template',
  'product.product',
  'project.task',
  'project.project',
  'product.pricelist.item',
  'helpdesk.ticket',
  'res.partner',
  // sale.order / sale.order.line writes are additionally gated by quoteGuard
  // to the quotation stage only (see QUOTE_STATES) — confirmed sales orders
  // are read-only here.
  'sale.order',
  'sale.order.line',
]);

// Models that live_rw may CREATE in
const LIVE_RW_CREATE_MODELS = new Set([
  'project.task',
  'sale.order',
  'sale.order.line',
  'product.pricelist.item',
  'helpdesk.ticket',
  'res.partner',
]);

// sale.order states that count as an editable "quote". Anything else (sale =
// confirmed Sales Order, cancel, etc.) is locked down in live_rw mode.
const QUOTE_STATES = new Set(['draft', 'sent']);

const MODE_LABELS = {
  staging: '🧪 STAGING',
  live_ro: '🔵 LIVE (read-only)',
  live_rw: '🟠 LIVE (restricted write)',
};
const MODE_LABEL = MODE_LABELS[MODE] || MODE;

// ── Odoo JSON-RPC client ──────────────────────────────────────────────────────

let rpcCounter = 0;

async function odooRpc(service, method, args) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { service, method, args },
      id: ++rpcCounter,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Odoo HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (data.error) {
    const e = data.error;
    const msg = (e.data && e.data.message) || e.message || JSON.stringify(e);
    throw new Error(msg);
  }
  return data.result;
}

let cachedUid = null;

async function getUid() {
  if (cachedUid == null) {
    cachedUid = await odooRpc('common', 'authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, {}]);
    if (!cachedUid) {
      throw new Error('Odoo authentication failed. Check URL, DB, username and API key.');
    }
  }
  return cachedUid;
}

async function execute(model, method, args, kwargs = {}) {
  const uid = await getUid();
  return odooRpc('object', 'execute_kw', [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs]);
}

const odoo = {
  searchRead(model, domain = [], { fields, limit = 80, offset = 0, order } = {}) {
    const kwargs = { limit, offset };
    if (fields) kwargs.fields = fields;
    if (order) kwargs.order = order;
    return execute(model, 'search_read', [domain], kwargs);
  },
  search(model, domain = [], { limit = 80, offset = 0, order } = {}) {
    const kwargs = { limit, offset };
    if (order) kwargs.order = order;
    return execute(model, 'search', [domain], kwargs);
  },
  read(model, ids, fields) {
    const kwargs = {};
    if (fields) kwargs.fields = fields;
    return execute(model, 'read', [ids], kwargs);
  },
  create(model, values) {
    return execute(model, 'create', [values]);
  },
  write(model, ids, values) {
    return execute(model, 'write', [ids, values]);
  },
  // Deliberately not exposed as a generic tool — only quote_update uses it,
  // and only on sale.order.line ids verified to belong to a quote-stage order.
  unlink(model, ids) {
    return execute(model, 'unlink', [ids]);
  },
  getFields(model, attributes) {
    const kwargs = {};
    if (attributes) kwargs.attributes = attributes;
    return execute(model, 'fields_get', [[]], kwargs);
  },
  call(model, method, ids, kwargs = {}) {
    return execute(model, method, [ids], kwargs);
  },
  async getProductTemplate(tmplId) {
    const records = await this.read('product.template', [tmplId]);
    return records[0] || {};
  },
  getProductVariants(tmplId) {
    return this.searchRead('product.product', [['product_tmpl_id', '=', tmplId]], { limit: 200 });
  },
  async getSaleOrder(orderId) {
    const records = await this.read('sale.order', [orderId]);
    return records[0] || {};
  },
  getPickingsForSaleOrder(orderId) {
    return this.searchRead('stock.picking', [
      ['sale_id', '=', orderId],
      ['state', 'not in', ['done', 'cancel']],
    ]);
  },
  getMoveLines(pickingId) {
    return this.searchRead('stock.move', [['picking_id', '=', pickingId]]);
  },
  async encodeImageFromUrl(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  },
  /** Split a picking. Returns list of new picking IDs (backorders). */
  async splitPicking(pickingId, movesWithQty) {
    await this.call('stock.picking', 'do_unreserve', [pickingId]);

    const moves = await this.searchRead(
      'stock.move',
      [['picking_id', '=', pickingId], ['state', 'not in', ['done', 'cancel']]],
      { fields: ['id', 'product_id', 'product_uom_qty', 'quantity_done'] },
    );
    const moveIds = new Set(moves.map((m) => m.id));

    for (const item of movesWithQty) {
      if (moveIds.has(item.move_id)) {
        await this.write('stock.move', [item.move_id], { quantity_done: Number(item.qty) });
      }
    }
    const requested = new Set(movesWithQty.map((i) => i.move_id));
    for (const mid of moveIds) {
      if (!requested.has(mid)) {
        await this.write('stock.move', [mid], { quantity_done: 0 });
      }
    }

    const result = await this.call('stock.picking', 'button_validate', [pickingId]);
    if (result && typeof result === 'object' && result.res_model === 'stock.backorder.confirmation') {
      const wizardId = await this.create('stock.backorder.confirmation', {
        pick_ids: [[4, pickingId]],
        show_transfers: false,
      });
      await this.call('stock.backorder.confirmation', 'process', [wizardId]);
    }

    return this.search('stock.picking', [['backorder_id', '=', pickingId]]);
  },
};

// ── PDFMonkey client ──────────────────────────────────────────────────────────

const PDFMONKEY_BASE = 'https://api.pdfmonkey.io/api/v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Submit a document for generation and poll until complete.
 * Returns { document_id, status, download_url?, filename?, failure_cause? }.
 */
async function generatePdfmonkeyDocument(payload, templateId) {
  const tid = templateId || PDFMONKEY_TEMPLATE_ID;
  if (!tid) throw new Error('PDFMONKEY_TEMPLATE_ID not set');
  if (!PDFMONKEY_API_KEY) throw new Error('PDFMONKEY_API_KEY not set');

  const headers = {
    Authorization: `Bearer ${PDFMONKEY_API_KEY}`,
    'Content-Type': 'application/json',
  };

  // Template variables are accessed as payload.field_name, so we nest accordingly
  const createRes = await fetch(`${PDFMONKEY_BASE}/documents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      document: {
        document_template_id: tid,
        payload: { payload },
        status: 'pending',
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!createRes.ok) throw new Error(`PDFMonkey HTTP ${createRes.status}: ${await createRes.text()}`);
  const docId = (await createRes.json()).document.id;

  // Poll until done (max ~120s)
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const pollRes = await fetch(`${PDFMONKEY_BASE}/documents/${docId}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!pollRes.ok) throw new Error(`PDFMonkey HTTP ${pollRes.status}: ${await pollRes.text()}`);
    const doc = (await pollRes.json()).document;
    if (doc.status === 'success') {
      return {
        document_id: docId,
        status: 'success',
        download_url: doc.download_url,
        filename: doc.filename,
      };
    }
    if (doc.status === 'error' || doc.status === 'failed') {
      return { document_id: docId, status: 'error', failure_cause: doc.failure_cause };
    }
  }
  return { document_id: docId, status: 'timeout', message: 'Generation took >120s' };
}

// ── Tool result helpers ───────────────────────────────────────────────────────

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(msg) {
  return { content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true };
}

function denied(action) {
  return err(
    `Action '${action}' is not permitted in ${MODE_LABEL} mode. ` +
    'Switch to the staging server to perform this operation.',
  );
}

/**
 * Restrict live_rw sale.order(.line) writes/creates to the quotation stage.
 * Returns an error message string when the operation must be blocked, or null
 * when it is allowed. Enforces two rules for live_rw:
 *   1. The affected sale.order(s) must be in a quote state (draft/sent) — a
 *      confirmed Sales Order (or cancelled order) cannot be edited here.
 *   2. A sale.order's `state` may not be set to anything outside QUOTE_STATES,
 *      so a quote can never be confirmed/locked into a Sales Order from here.
 */
async function quoteGuard(model, ids = null, values = null) {
  if (MODE !== 'live_rw' || (model !== 'sale.order' && model !== 'sale.order.line')) {
    return null;
  }

  // Collect the parent sale.order ids implicated by this operation.
  let orderIds = [];
  if (model === 'sale.order') {
    orderIds = [...(ids || [])];
  } else {
    if (ids && ids.length) {
      const lines = await odoo.read('sale.order.line', [...ids], ['order_id']);
      for (const line of lines) {
        if (line.order_id) orderIds.push(line.order_id[0]);
      }
    }
    if (values && values.order_id) orderIds.push(values.order_id);
  }

  if (orderIds.length) {
    const orders = await odoo.read('sale.order', orderIds, ['name', 'state']);
    for (const order of orders) {
      if (!QUOTE_STATES.has(order.state)) {
        return (
          `Sale order ${order.name} (id ${order.id}) is in state '${order.state}', ` +
          `past the quotation stage. ${MODE_LABEL} mode may only edit quotes ` +
          '(state draft or sent).'
        );
      }
    }
  }

  // Never allow a direct state change that would confirm/lock a quote.
  if (model === 'sale.order' && values && 'state' in values && !QUOTE_STATES.has(values.state)) {
    return (
      `Setting sale.order state to '${values.state}' is not permitted in ` +
      `${MODE_LABEL} mode — quotes cannot be converted to sales orders here.`
    );
  }
  return null;
}

// ── URL helpers ───────────────────────────────────────────────────────────────

// Odoo 18 clean URL patterns (falls back to /web# for unknown models)
const MODEL_URL_PATHS = {
  'product.template': '/odoo/inventory/products/{id}',
  'product.product': '/odoo/inventory/products/{id}',
  'sale.order': '/odoo/sales/{id}',
  'purchase.order': '/odoo/purchase/{id}',
  'project.task': '/odoo/project/tasks/{id}',
  'project.project': '/odoo/project/{id}',
  'stock.picking': '/odoo/inventory/delivery-orders/{id}',
  'res.partner': '/odoo/contacts/{id}',
  'account.move': '/odoo/accounting/customer-invoices/{id}',
  'helpdesk.ticket': '/odoo/helpdesk/tickets/{id}',
};

function recordUrl(model, recordId) {
  const pattern = MODEL_URL_PATHS[model];
  if (pattern) return `${ODOO_URL}${pattern.replace('{id}', recordId)}`;
  return `${ODOO_URL}/web#model=${model}&id=${recordId}&view_type=form`;
}

function withUrl(record, model) {
  if (record && typeof record === 'object' && 'id' in record) {
    record._url = recordUrl(model, record.id);
  }
  return record;
}

function injectUrls(records, model) {
  return records.map((r) => withUrl(r, model));
}

// ── Tool catalogue ────────────────────────────────────────────────────────────

// --- Read tools (all modes) ---
const READ_TOOLS = [
  {
    name: 'odoo_ping',
    description:
      `Test the Odoo connection. Current mode: ${MODE_LABEL} | DB: ${ODOO_DB} | URL: ${ODOO_URL}`,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'odoo_search_read',
    description: `[${MODE_LABEL}] Search and read records from any Odoo model.`,
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: "Odoo model, e.g. 'product.template'" },
        domain: { type: 'array', description: "Filter domain, e.g. [['name','ilike','LED']]", default: [] },
        fields: { type: 'array', items: { type: 'string' }, description: 'Fields to return (omit for all)' },
        limit: { type: 'integer', default: 80 },
        offset: { type: 'integer', default: 0 },
        order: { type: 'string', description: "Sort order, e.g. 'name asc'" },
      },
      required: ['model'],
    },
  },
  {
    name: 'odoo_read',
    description: `[${MODE_LABEL}] Read specific Odoo records by ID.`,
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        ids: { type: 'array', items: { type: 'integer' } },
        fields: { type: 'array', items: { type: 'string' } },
      },
      required: ['model', 'ids'],
    },
  },
  {
    name: 'odoo_get_fields',
    description:
      `[${MODE_LABEL}] Get field definitions for an Odoo model, ` +
      'including custom Studio fields (x_ prefix).',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        attributes: {
          type: 'array',
          items: { type: 'string' },
          description: "e.g. ['string','type','required']",
        },
      },
      required: ['model'],
    },
  },
  {
    name: 'product_get',
    description:
      `[${MODE_LABEL}] Get full product template details including ` +
      'variants, attributes, and custom Studio fields.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'product.template ID' },
        include_variants: { type: 'boolean', default: true },
      },
      required: ['id'],
    },
  },
  {
    name: 'sales_find_order',
    description: `[${MODE_LABEL}] Find sales orders by reference or customer name.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Order ref, e.g. 'S00123'" },
        customer: { type: 'string', description: 'Customer name (partial)' },
        state: { type: 'string', enum: ['draft', 'sent', 'sale', 'done', 'cancel'] },
        limit: { type: 'integer', default: 20 },
      },
    },
  },
  {
    name: 'sales_order_get',
    description: `[${MODE_LABEL}] Get a sales order with lines and delivery pickings.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'sale.order ID' },
      },
      required: ['id'],
    },
  },
];

// --- Write tools (staging + live_rw) ---
const WRITE_TOOLS = [
  {
    name: 'odoo_create',
    description:
      `[${MODE_LABEL}] Create a new record. ` +
      (MODE === 'live_rw'
        ? 'Allowed models: ' + [...LIVE_RW_CREATE_MODELS].sort().join(', ')
        : 'Any model.'),
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        values: { type: 'object' },
      },
      required: ['model', 'values'],
    },
  },
  {
    name: 'odoo_write',
    description:
      `[${MODE_LABEL}] Update Odoo records. ` +
      (MODE === 'live_rw'
        ? 'Allowed models: ' + [...LIVE_RW_WRITE_MODELS].sort().join(', ') +
          '. Note: sale.order / sale.order.line edits are limited to the ' +
          'quotation stage (draft/sent); confirmed sales orders are read-only ' +
          'and quotes cannot be confirmed into sales orders here.'
        : 'Any model.'),
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        ids: { type: 'array', items: { type: 'integer' } },
        values: { type: 'object' },
      },
      required: ['model', 'ids', 'values'],
    },
  },
  {
    name: 'product_create',
    description: `[${MODE_LABEL}] Create a new product template.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        product_type: { type: 'string', enum: ['consu', 'service', 'product'], default: 'product' },
        sale_price: { type: 'number' },
        cost_price: { type: 'number' },
        internal_reference: { type: 'string' },
        description: { type: 'string' },
        description_sale: { type: 'string' },
        categ_id: { type: 'integer' },
        extra_fields: { type: 'object', description: 'Any additional/Studio fields' },
      },
      required: ['name'],
    },
  },
  {
    name: 'product_set_image',
    description: `[${MODE_LABEL}] Set image on a product template or variant.`,
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', enum: ['product.template', 'product.product'], default: 'product.template' },
        id: { type: 'integer' },
        image_url: { type: 'string' },
        image_base64: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'product_update_variant',
    description:
      `[${MODE_LABEL}] Update fields on a product variant, ` +
      'including custom Studio fields (x_ prefix).',
    inputSchema: {
      type: 'object',
      properties: {
        variant_id: { type: 'integer' },
        values: { type: 'object' },
      },
      required: ['variant_id', 'values'],
    },
  },
  {
    name: 'quote_update',
    description:
      `[${MODE_LABEL}] Edit an existing QUOTATION (sale.order in draft/sent state) in one call: ` +
      'update header fields and add, update, or remove order lines. ' +
      'Refuses confirmed sales orders in every mode, and can never confirm a quote ' +
      'into a sales order — confirmation stays a manual step in Odoo. ' +
      'Returns the updated order with all lines so the result can be verified.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'integer', description: 'sale.order ID of the quotation' },
        values: {
          type: 'object',
          description:
            "Header fields to update, e.g. partner_id, validity_date, note, client_order_ref, " +
            "Studio fields (x_studio_*). 'state' may only be 'draft' or 'sent'.",
        },
        add_lines: {
          type: 'array',
          description: 'New order lines to add',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'integer', description: 'product.product (variant) ID' },
              quantity: { type: 'number', description: 'Quantity (product_uom_qty)' },
              price_unit: { type: 'number', description: 'Unit price (omit to use pricelist price)' },
              description: { type: 'string', description: 'Line description (omit to use product default)' },
              extra_fields: { type: 'object', description: 'Any additional/Studio fields, e.g. x_studio_project_legend' },
            },
            required: ['product_id'],
          },
        },
        update_lines: {
          type: 'array',
          description: 'Existing order lines to change (find line IDs via sales_order_get)',
          items: {
            type: 'object',
            properties: {
              line_id: { type: 'integer', description: 'sale.order.line ID' },
              product_id: { type: 'integer' },
              quantity: { type: 'number', description: 'New quantity (product_uom_qty)' },
              price_unit: { type: 'number' },
              description: { type: 'string', description: 'New line description' },
              extra_fields: { type: 'object', description: 'Any additional/Studio fields' },
            },
            required: ['line_id'],
          },
        },
        remove_line_ids: {
          type: 'array',
          items: { type: 'integer' },
          description: 'sale.order.line IDs to delete from the quote',
        },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'task_upsert',
    description:
      `[${MODE_LABEL}] Create or update a project task. ` +
      'If task_id is provided, updates it; otherwise creates a new task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: 'Existing task ID to update (omit to create)' },
        name: { type: 'string', description: 'Task title' },
        project_id: { type: 'integer', description: 'Project ID' },
        description: { type: 'string', description: 'Task description / notes' },
        user_ids: { type: 'array', items: { type: 'integer' }, description: 'Assigned user IDs' },
        stage_id: { type: 'integer', description: 'Stage/column ID' },
        date_deadline: { type: 'string', description: "Due date, e.g. '2025-06-30'" },
        priority: { type: 'string', enum: ['0', '1'], description: '0=normal, 1=high' },
        tag_ids: { type: 'array', items: { type: 'integer' }, description: 'Tag IDs' },
        extra_fields: { type: 'object', description: 'Any additional/Studio fields' },
      },
    },
  },
  {
    name: 'helpdesk_ticket_upsert',
    description:
      `[${MODE_LABEL}] Create or update a helpdesk ticket. ` +
      'If ticket_id is provided, updates it; otherwise creates a new ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: { type: 'integer', description: 'Existing ticket ID to update (omit to create)' },
        name: { type: 'string', description: 'Ticket subject/title' },
        partner_id: { type: 'integer', description: 'Customer (res.partner) ID' },
        partner_name: { type: 'string', description: 'Customer name (used if partner_id unknown)' },
        description: { type: 'string', description: 'Ticket description / body' },
        team_id: { type: 'integer', description: 'Helpdesk team ID' },
        user_id: { type: 'integer', description: 'Assigned agent user ID' },
        stage_id: { type: 'integer', description: 'Stage ID' },
        priority: { type: 'string', enum: ['0', '1', '2', '3'], description: '0=low, 1=medium, 2=high, 3=urgent' },
        tag_ids: { type: 'array', items: { type: 'integer' }, description: 'Tag IDs' },
        extra_fields: { type: 'object', description: 'Any additional/Studio fields' },
      },
    },
  },
];

// --- Datasheet tool (all modes — read-only operation) ---
const DATASHEET_TOOLS = [
  {
    name: 'generate_datasheet',
    description:
      `[${MODE_LABEL}] Generate a PDF datasheet for a product variant via PDFMonkey. ` +
      'Fetches all spec fields and the product image from Odoo, builds the payload, ' +
      'submits to PDFMonkey, and returns the download URL. ' +
      'Accepts a variant internal reference (SKU), a product.product ID, or a product name to search.',
    inputSchema: {
      type: 'object',
      properties: {
        internal_reference: {
          type: 'string',
          description: "Product variant SKU / internal reference (default_code), e.g. 'PLB-1230-24W-4K-9-MP'",
        },
        variant_id: {
          type: 'integer',
          description: 'product.product ID (use instead of internal_reference if you already have it)',
        },
        product_name: {
          type: 'string',
          description: 'Partial product name to search (returns error if multiple matches found)',
        },
        template_id: {
          type: 'string',
          description: `PDFMonkey template ID override. Defaults to ${PDFMONKEY_TEMPLATE_ID}`,
        },
        quote_name: {
          type: 'string',
          description: 'Project/quote name to print on the datasheet (sale.order x_studio_quote_name). Optional — project datasheets only.',
        },
        project_legend: {
          type: 'string',
          description: 'Project legend/tag for this line (sale.order.line x_studio_project_legend). Optional — project datasheets only.',
        },
      },
    },
  },
];

// --- Staging-only tools ---
const STAGING_ONLY_TOOLS = [
  {
    name: 'odoo_call',
    description: '[🧪 STAGING] Call any method on an Odoo model.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        method: { type: 'string' },
        ids: { type: 'array', items: { type: 'integer' } },
        kwargs: { type: 'object', default: {} },
      },
      required: ['model', 'method', 'ids'],
    },
  },
  {
    name: 'delivery_split',
    description: '[🧪 STAGING] Split a delivery picking into multiple batches.',
    inputSchema: {
      type: 'object',
      properties: {
        picking_id: { type: 'integer' },
        batches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              scheduled_date: { type: 'string' },
              moves: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    move_id: { type: 'integer' },
                    qty: { type: 'number' },
                  },
                  required: ['move_id', 'qty'],
                },
              },
            },
            required: ['moves'],
          },
        },
      },
      required: ['picking_id', 'batches'],
    },
  },
];

// Build final tool list for this mode
let ALL_TOOLS;
if (MODE === 'staging') {
  ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS, ...DATASHEET_TOOLS, ...STAGING_ONLY_TOOLS];
} else if (MODE === 'live_rw') {
  ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS, ...DATASHEET_TOOLS];
} else {
  // live_ro
  ALL_TOOLS = [...READ_TOOLS, ...DATASHEET_TOOLS];
}
const ALLOWED_TOOL_NAMES = new Set(ALL_TOOLS.map((t) => t.name));

// ── Datasheet helpers ─────────────────────────────────────────────────────────

/** Convert an Odoo base64 field to a MIME-typed data URI. */
function toDataUri(b64Val) {
  if (!b64Val) return '';
  let raw;
  try {
    raw = Buffer.from(b64Val, 'base64');
  } catch {
    return '';
  }
  let mime = 'image/jpeg';
  if (raw.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    mime = 'image/png';
  } else if (raw[0] === 0xff && raw[1] === 0xd8) {
    mime = 'image/jpeg';
  } else if (raw.subarray(0, 4).toString('latin1') === 'RIFF' && raw.subarray(8, 12).toString('latin1') === 'WEBP') {
    mime = 'image/webp';
  } else if (['GIF87a', 'GIF89a'].includes(raw.subarray(0, 6).toString('latin1'))) {
    mime = 'image/gif';
  } else if (raw.subarray(0, 256).toString('latin1').includes('<svg')) {
    mime = 'image/svg+xml';
  }
  return `data:${mime};base64,${raw.toString('base64')}`;
}

/** Odoo returns false for empty fields — render as ''. */
function f(val) {
  if (val === false || val === null || val === undefined) return '';
  return String(val);
}

// Every field here is an existing Studio (x_studio_*) field on the live
// database — no module-defined fields, so this works whether or not the
// vl_datasheet_pdfmonkey module is installed.
const SPEC_FIELDS = [
  'id', 'name', 'default_code', 'description_sale',
  'product_tmpl_id', 'image_1920',
  'product_template_attribute_value_ids',
  'x_studio_datasheet_description',
  'x_studio_lumens_1',
  'x_studio_ip_rating', 'x_studio_ik_rating',
  'x_studio_light_source', 'x_studio_lifetime',
  'x_studio_sdcm_1', 'x_studio_input_voltage',
  'x_studio_dimming_resolution', 'x_studio_wiring',
  'x_studio_power_factor', 'x_studio_mounting',
  'x_studio_length_mm_1', 'x_studio_width_mm_1',
  'x_studio_height_mm_2', 'x_studio_diameter_mm_1',
  'x_studio_cut_out', 'x_studio_weight_kg',
  'x_studio_specsheet_notes',
  'x_studio_ies_image',
  'x_studio_dimension_image',
  'x_studio_colour_detail',
  // Emergency (AS2293)
  'x_studio_emergency_as2293_classification',
  'x_studio_emergency_duration',
  'x_studio_emergency_exit_view_distance',
  'x_studio_emergency_battery_type',
  'x_studio_emergency_battery_voltage',
  'x_studio_emergency_charge_time',
];

async function generateDatasheet(args) {
  // 1. Resolve the variant
  let variantId = args.variant_id;
  if (!variantId) {
    let hits;
    if (args.internal_reference) {
      hits = await odoo.search('product.product', [['default_code', '=', args.internal_reference]]);
    } else if (args.product_name) {
      hits = await odoo.search('product.product', [['name', 'ilike', args.product_name]]);
    } else {
      return err('Provide internal_reference, variant_id, or product_name');
    }
    if (!hits.length) return err('No matching product variant found');
    if (hits.length > 1) {
      const names = await odoo.read('product.product', hits, ['default_code', 'name']);
      return err(`Multiple variants matched — be more specific: ${JSON.stringify(names)}`);
    }
    variantId = hits[0];
  }

  // 2. Fetch all spec fields (variant level)
  const variants = await odoo.read('product.product', [variantId], SPEC_FIELDS);
  if (!variants.length) return err(`Variant ID ${variantId} not found`);
  const v = variants[0];

  // 2b. Datasheet-specific description comes from the variant's Studio field
  //     x_studio_datasheet_description (falls back to description_sale below).
  const datasheetDescription = v.x_studio_datasheet_description || '';

  // 3. Fetch and sort attribute values; handle colour+detail
  const attrValIds = v.product_template_attribute_value_ids || [];
  const attrVals = [];
  const knownAttrs = {};
  const colourDetail = f(v.x_studio_colour_detail);
  if (attrValIds.length) {
    const avRecords = await odoo.read(
      'product.template.attribute.value',
      attrValIds,
      ['attribute_id', 'name'],
    );
    for (const av of avRecords) {
      const attrName = Array.isArray(av.attribute_id) ? av.attribute_id[1] : String(av.attribute_id);
      let attrValue = av.name;
      // Append colour detail to colour attribute values
      if (['colour', 'color'].includes(attrName.toLowerCase()) && colourDetail) {
        attrValue = `${attrValue} ${colourDetail}`;
      }
      attrVals.push({ name: attrName, value: attrValue });
      knownAttrs[attrName.toLowerCase()] = attrValue;
    }
  }

  // 4. Build the payload (matches template variable structure)
  //    Datasheet description takes priority, falling back to the sales description.
  const description = f(datasheetDescription || v.description_sale);

  const payload = {
    default_code: f(v.default_code),
    name: f(v.name),
    power: knownAttrs['power'] || '',
    cct_cri: knownAttrs['cct/cri'] || '',
    lumens: f(v.x_studio_lumens_1),
    optic: knownAttrs['optic'] || '',
    dimming: knownAttrs['dimming/control'] || '',
    description_sale: description,
    lumen_output: f(v.x_studio_lumens_1),
    ip_rating: f(v.x_studio_ip_rating),
    ik_rating: f(v.x_studio_ik_rating),
    light_source: f(v.x_studio_light_source),
    lifetime: f(v.x_studio_lifetime),
    sdcm: f(v.x_studio_sdcm_1),
    input_voltage: f(v.x_studio_input_voltage),
    dimming_resolution: f(v.x_studio_dimming_resolution),
    wiring: f(v.x_studio_wiring),
    power_factor: f(v.x_studio_power_factor),
    mounting: f(v.x_studio_mounting),
    length_mm: f(v.x_studio_length_mm_1),
    width_mm: f(v.x_studio_width_mm_1),
    height_mm: f(v.x_studio_height_mm_2),
    diameter_mm: f(v.x_studio_diameter_mm_1),
    cutout: f(v.x_studio_cut_out),
    weight: f(v.x_studio_weight_kg || ''), // 0.0 → "" so an empty weight row is omitted
    // Emergency (AS2293)
    emergency_as2293: f(v.x_studio_emergency_as2293_classification),
    emergency_duration: f(v.x_studio_emergency_duration),
    emergency_exit_view_distance: f(v.x_studio_emergency_exit_view_distance),
    emergency_battery_type: f(v.x_studio_emergency_battery_type),
    emergency_battery_voltage: f(v.x_studio_emergency_battery_voltage),
    emergency_charge_time: f(v.x_studio_emergency_charge_time),
    notes: f(v.x_studio_specsheet_notes),
    attributes: attrVals,
    product_image: toDataUri(v.image_1920),
    ies_image: toDataUri(v.x_studio_ies_image),
    dimension_image: toDataUri(v.x_studio_dimension_image),
    quote_name: f(args.quote_name || ''),
    project_legend: f(args.project_legend || ''),
  };

  // 5. Submit to PDFMonkey and return result
  const result = await generatePdfmonkeyDocument(payload, args.template_id);
  result.variant_id = variantId;
  result.product = f(v.name);
  result.sku = f(v.default_code);
  return ok(result);
}

// ── Tool dispatch ─────────────────────────────────────────────────────────────

async function dispatch(name, args) {
  // ── Ping ────────────────────────────────────────────────────────────────────
  if (name === 'odoo_ping') {
    const version = await odooRpc('common', 'version', []);
    const uid = await getUid();
    const user = await odoo.read('res.users', [uid], ['name', 'login', 'company_id']);
    return ok({
      mode: MODE_LABEL,
      server_version: version,
      uid,
      user,
      db: ODOO_DB,
      url: ODOO_URL,
    });
  }

  // ── Read tools ──────────────────────────────────────────────────────────────
  if (name === 'odoo_search_read') {
    const records = await odoo.searchRead(args.model, args.domain || [], {
      fields: args.fields,
      limit: args.limit ?? 80,
      offset: args.offset ?? 0,
      order: args.order,
    });
    return ok(injectUrls(records, args.model));
  }

  if (name === 'odoo_read') {
    const records = await odoo.read(args.model, args.ids, args.fields);
    return ok(injectUrls(records, args.model));
  }

  if (name === 'odoo_get_fields') {
    return ok(await odoo.getFields(args.model, args.attributes));
  }

  if (name === 'product_get') {
    const tmpl = withUrl(await odoo.getProductTemplate(args.id), 'product.template');
    const result = { template: tmpl };
    if (args.include_variants !== false) {
      result.variants = injectUrls(await odoo.getProductVariants(args.id), 'product.product');
    }
    return ok(result);
  }

  if (name === 'sales_find_order') {
    const domain = [];
    if (args.name) domain.push(['name', 'ilike', args.name]);
    if (args.customer) domain.push(['partner_id.name', 'ilike', args.customer]);
    if (args.state) domain.push(['state', '=', args.state]);
    const records = await odoo.searchRead('sale.order', domain, {
      fields: ['id', 'name', 'partner_id', 'state', 'date_order', 'amount_total', 'picking_ids'],
      limit: args.limit ?? 20,
      order: 'date_order desc',
    });
    return ok(injectUrls(records, 'sale.order'));
  }

  if (name === 'sales_order_get') {
    const order = withUrl(await odoo.getSaleOrder(args.id), 'sale.order');
    const lines = await odoo.searchRead('sale.order.line', [['order_id', '=', args.id]], {
      fields: ['id', 'product_id', 'product_uom_qty', 'qty_delivered', 'price_unit', 'name'],
    });
    const pickings = await odoo.getPickingsForSaleOrder(args.id);
    for (const p of pickings) {
      p.moves = await odoo.getMoveLines(p.id);
      withUrl(p, 'stock.picking');
    }
    return ok({ order, lines, pickings });
  }

  // ── Write tools ─────────────────────────────────────────────────────────────
  if (name === 'odoo_create') {
    const model = args.model;
    if (MODE === 'live_rw' && !LIVE_RW_CREATE_MODELS.has(model)) {
      return err(
        `Cannot create '${model}' in ${MODE_LABEL} mode. ` +
        `Allowed: ${[...LIVE_RW_CREATE_MODELS].sort().join(', ')}`,
      );
    }
    const guardErr = await quoteGuard(model, null, args.values);
    if (guardErr) return err(guardErr);
    const newId = await odoo.create(model, args.values);
    return ok({ id: newId, model, url: recordUrl(model, newId) });
  }

  if (name === 'odoo_write') {
    const model = args.model;
    if (MODE === 'live_rw' && !LIVE_RW_WRITE_MODELS.has(model)) {
      return err(
        `Cannot write to '${model}' in ${MODE_LABEL} mode. ` +
        `Allowed: ${[...LIVE_RW_WRITE_MODELS].sort().join(', ')}`,
      );
    }
    const guardErr = await quoteGuard(model, args.ids, args.values);
    if (guardErr) return err(guardErr);
    const okFlag = await odoo.write(model, args.ids, args.values);
    return ok({
      success: okFlag,
      ids: args.ids,
      urls: args.ids.map((i) => recordUrl(model, i)),
    });
  }

  if (name === 'product_create') {
    const values = { name: args.name };
    if ('product_type' in args) values.type = args.product_type;
    if ('sale_price' in args) values.list_price = args.sale_price;
    if ('internal_reference' in args) values.default_code = args.internal_reference;
    if ('description' in args) values.description = args.description;
    if ('description_sale' in args) values.description_sale = args.description_sale;
    if ('categ_id' in args) values.categ_id = args.categ_id;
    if (args.extra_fields) Object.assign(values, args.extra_fields);
    const newId = await odoo.create('product.template', values);
    if ('cost_price' in args) {
      const variants = await odoo.search('product.product', [['product_tmpl_id', '=', newId]]);
      if (variants.length) {
        await odoo.write('product.product', variants, { standard_price: args.cost_price });
      }
    }
    return ok({
      id: newId,
      url: recordUrl('product.template', newId),
      template: withUrl(await odoo.getProductTemplate(newId), 'product.template'),
    });
  }

  if (name === 'product_set_image') {
    const model = args.model || 'product.template';
    const recordId = args.id;
    let b64;
    if (args.image_url) {
      b64 = await odoo.encodeImageFromUrl(args.image_url);
    } else if (args.image_base64) {
      b64 = args.image_base64;
    } else {
      return err('Provide either image_url or image_base64');
    }
    await odoo.write(model, [recordId], { image_1920: b64 });
    return ok({ success: true, model, id: recordId, url: recordUrl(model, recordId) });
  }

  if (name === 'product_update_variant') {
    const okFlag = await odoo.write('product.product', [args.variant_id], args.values);
    return ok({
      success: okFlag,
      variant_id: args.variant_id,
      url: recordUrl('product.product', args.variant_id),
    });
  }

  if (name === 'quote_update') {
    const orderId = args.order_id;

    // Quote-stage gate applies in EVERY mode for this tool: it exists to edit
    // quotations, so confirmed/cancelled orders are always off limits here.
    const orders = await odoo.read('sale.order', [orderId], ['name', 'state']);
    if (!orders.length) return err(`sale.order ${orderId} not found`);
    const orderRef = orders[0];
    if (!QUOTE_STATES.has(orderRef.state)) {
      return err(
        `Sale order ${orderRef.name} (id ${orderId}) is in state '${orderRef.state}', ` +
        "past the quotation stage. quote_update may only edit quotes (state draft or sent).",
      );
    }
    if (args.values && 'state' in args.values && !QUOTE_STATES.has(args.values.state)) {
      return err(
        `Setting state to '${args.values.state}' is not permitted — quotes cannot be ` +
        'confirmed into sales orders from this connector. Confirm manually in Odoo.',
      );
    }

    // Every referenced line must belong to this order before anything is written.
    const touchedLineIds = [
      ...(args.update_lines || []).map((l) => l.line_id),
      ...(args.remove_line_ids || []),
    ];
    if (touchedLineIds.length) {
      const lines = await odoo.read('sale.order.line', touchedLineIds, ['order_id']);
      const wrong = lines.filter((l) => !l.order_id || l.order_id[0] !== orderId);
      if (wrong.length) {
        return err(
          `Line id(s) ${wrong.map((l) => l.id).join(', ')} do not belong to ` +
          `sale.order ${orderId} — refusing to touch them.`,
        );
      }
    }

    const lineValues = (line) => {
      const vals = {};
      if ('product_id' in line) vals.product_id = line.product_id;
      if ('quantity' in line) vals.product_uom_qty = line.quantity;
      if ('price_unit' in line) vals.price_unit = line.price_unit;
      if ('description' in line) vals.name = line.description;
      if (line.extra_fields) Object.assign(vals, line.extra_fields);
      return vals;
    };

    const changes = { header_updated: false, lines_added: [], lines_updated: [], lines_removed: [] };

    if (args.values && Object.keys(args.values).length) {
      await odoo.write('sale.order', [orderId], args.values);
      changes.header_updated = true;
    }
    for (const line of args.update_lines || []) {
      await odoo.write('sale.order.line', [line.line_id], lineValues(line));
      changes.lines_updated.push(line.line_id);
    }
    for (const line of args.add_lines || []) {
      changes.lines_added.push(
        await odoo.create('sale.order.line', { order_id: orderId, ...lineValues(line) }),
      );
    }
    if (args.remove_line_ids && args.remove_line_ids.length) {
      await odoo.unlink('sale.order.line', args.remove_line_ids);
      changes.lines_removed = args.remove_line_ids;
    }

    const order = withUrl(await odoo.getSaleOrder(orderId), 'sale.order');
    const lines = await odoo.searchRead('sale.order.line', [['order_id', '=', orderId]], {
      fields: ['id', 'product_id', 'product_uom_qty', 'price_unit', 'price_subtotal', 'name'],
    });
    return ok({ ...changes, order, lines });
  }

  if (name === 'task_upsert') {
    const values = {};
    for (const field of ['name', 'project_id', 'description', 'stage_id', 'date_deadline', 'priority']) {
      if (field in args) values[field] = args[field];
    }
    if (args.user_ids) values.user_ids = [[6, 0, args.user_ids]];
    if (args.tag_ids) values.tag_ids = [[6, 0, args.tag_ids]];
    if (args.extra_fields) Object.assign(values, args.extra_fields);

    if (args.task_id) {
      await odoo.write('project.task', [args.task_id], values);
      return ok({ updated: true, task_id: args.task_id, url: recordUrl('project.task', args.task_id) });
    }
    const newId = await odoo.create('project.task', values);
    return ok({ created: true, task_id: newId, url: recordUrl('project.task', newId) });
  }

  if (name === 'helpdesk_ticket_upsert') {
    const values = {};
    for (const field of ['name', 'partner_id', 'partner_name', 'description', 'team_id', 'user_id', 'stage_id', 'priority']) {
      if (field in args) values[field] = args[field];
    }
    if (args.tag_ids) values.tag_ids = [[6, 0, args.tag_ids]];
    if (args.extra_fields) Object.assign(values, args.extra_fields);

    if (args.ticket_id) {
      await odoo.write('helpdesk.ticket', [args.ticket_id], values);
      return ok({ updated: true, ticket_id: args.ticket_id, url: recordUrl('helpdesk.ticket', args.ticket_id) });
    }
    const newId = await odoo.create('helpdesk.ticket', values);
    return ok({ created: true, ticket_id: newId, url: recordUrl('helpdesk.ticket', newId) });
  }

  // ── Datasheet generation ────────────────────────────────────────────────────
  if (name === 'generate_datasheet') {
    return generateDatasheet(args);
  }

  // ── Staging-only tools ──────────────────────────────────────────────────────
  if (name === 'odoo_call') {
    return ok(await odoo.call(args.model, args.method, args.ids, args.kwargs || {}));
  }

  if (name === 'delivery_split') {
    const { picking_id: pickingId, batches } = args;
    if (!batches || batches.length < 2) {
      return err('Need at least 2 batches to perform a split.');
    }

    const created = [];
    let remaining = pickingId;
    for (let i = 0; i < batches.length - 1; i++) {
      const batch = batches[i];
      const newIds = await odoo.splitPicking(remaining, batch.moves);
      if (batch.scheduled_date) {
        await odoo.write('stock.picking', [remaining], { scheduled_date: batch.scheduled_date });
      }
      created.push({
        batch: i + 1,
        picking_id: remaining,
        scheduled_date: batch.scheduled_date,
        url: recordUrl('stock.picking', remaining),
      });
      if (newIds.length) remaining = newIds[0];
    }

    const last = batches[batches.length - 1];
    if (last.scheduled_date) {
      await odoo.write('stock.picking', [remaining], { scheduled_date: last.scheduled_date });
    }
    created.push({
      batch: batches.length,
      picking_id: remaining,
      scheduled_date: last.scheduled_date,
      url: recordUrl('stock.picking', remaining),
    });
    return ok({ split_pickings: created });
  }

  return err(`Unknown tool: ${name}`);
}

// ── MCP stdio transport (newline-delimited JSON-RPC 2.0) ─────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleRequest(msg) {
  const { method, params } = msg;

  if (method === 'initialize') {
    return {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: `odoo-${MODE}`, version: SERVER_VERSION },
    };
  }

  if (method === 'ping') return {};

  if (method === 'tools/list') return { tools: ALL_TOOLS };

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      if (!ALLOWED_TOOL_NAMES.has(name)) return denied(name);
      return await dispatch(name, args);
    } catch (e) {
      return err(`${e && e.message ? e.message : e}\n\n${e && e.stack ? e.stack : ''}`);
    }
  }

  const notFound = new Error(`Method not found: ${method}`);
  notFound.jsonrpcCode = -32601;
  throw notFound;
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    // Notifications (no id) — nothing to respond to.
    if (msg.id === undefined || msg.id === null) return;

    try {
      const result = await handleRequest(msg);
      send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (e) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: e.jsonrpcCode || -32603, message: String(e && e.message ? e.message : e) },
      });
    }
  });

  rl.on('close', () => process.exit(0));
}

main();
