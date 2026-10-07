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
 *              luminaire schedules,
 *              helpdesk tickets, contacts, open manufacturing orders,
 *              date-only ETA edits on POs and transfers,
 *              invoice forecasts on quotes and orders),
 *              live database
 */

'use strict';

const readline = require('node:readline');
const fs = require('node:fs');
const nodePath = require('node:path');

const SERVER_VERSION = '3.8.0';

// ── Config from env ───────────────────────────────────────────────────────────

// Trim every value — a stray space or newline pasted into the install dialog
// otherwise reaches Odoo verbatim and fails auth with a bare "Access Denied".
const env = (key) => (process.env[key] || '').trim();

const ODOO_URL = env('ODOO_URL').replace(/\/+$/, '');
const ODOO_DB = env('ODOO_DB');
const ODOO_USERNAME = env('ODOO_USERNAME');
const ODOO_API_KEY = env('ODOO_API_KEY');
const MODE = env('ODOO_MODE') || 'live_rw'; // staging | live_ro | live_rw

// Optional second target. Odoo.sh staging is a copy of production, so the
// username and API key default to the live ones — set STAGING_* only when the
// staging database wants different credentials.
const STAGING_URL = env('STAGING_URL').replace(/\/+$/, '');
const STAGING_DB = env('STAGING_DB');
const STAGING_USERNAME = env('STAGING_USERNAME') || ODOO_USERNAME;
const STAGING_API_KEY = env('STAGING_API_KEY') || ODOO_API_KEY;
const HAS_STAGING = Boolean(STAGING_URL && STAGING_DB);

const TARGETS = {
  live: { url: ODOO_URL, db: ODOO_DB, username: ODOO_USERNAME, apiKey: ODOO_API_KEY, label: 'live' },
  staging: { url: STAGING_URL, db: STAGING_DB, username: STAGING_USERNAME, apiKey: STAGING_API_KEY, label: 'staging' },
};

const { AsyncLocalStorage } = require('node:async_hooks');
const targetStore = new AsyncLocalStorage();

/** Which database the call in flight is talking to. Defaults to live. */
function currentTarget() {
  const store = targetStore.getStore();
  return (store && store.target) || 'live';
}

function targetCfg() {
  const cfg = TARGETS[currentTarget()];
  if (!cfg || !cfg.url || !cfg.db) {
    throw new Error(
      `Target '${currentTarget()}' is not configured. Set STAGING_URL and ` +
      'STAGING_DB in the extension settings.',
    );
  }
  return cfg;
}

/** Staging is a scratch database: writes there are not restricted. */
function isStaging() {
  return currentTarget() === 'staging';
}

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
  'mrp.bom',
  // sale.order / sale.order.line writes are additionally gated by quoteGuard
  // to the quotation stage only (see QUOTE_STATES) — confirmed sales orders
  // are read-only here.
  'sale.order',
  'sale.order.line',
  // mrp.production / stock.move let the configurator push calculated component
  // quantities onto an open MO. Gated by productionGuard to MOs that have not
  // been finished or cancelled (see PRODUCTION_STATES).
  'mrp.production',
  'stock.move',
  // Configurator catalogue: the tool definition and the section/accessory
  // tables that say what can actually be built. Setup data, not transactional
  // — vl.configurator.config (one per order line) is deliberately absent.
  'vl.configurator.tool',
  'vl.configurator.section',
  'vl.configurator.accessory',
  // Purchasing ETA updates. These are DATE-ONLY: dateGuard rejects any write
  // that touches a field outside LIVE_RW_DATE_FIELDS (stock.move keeps its
  // wider MO path above — a date-only move write goes through dateGuard).
  'purchase.order',
  'purchase.order.line',
  'stock.picking',
]);

// The only fields live_rw may write on the purchasing/transfer models. Kept to
// the dates someone actually updates for an ETA — not date_order (it drives the
// PO's currency rate) nor the transfer's creation/done dates, which are history.
const LIVE_RW_DATE_FIELDS = {
  'purchase.order': new Set(['date_planned']),                         // Expected Arrival
  'purchase.order.line': new Set(['date_planned', 'vl_exworks_date']), // Expected Arrival, Ex-works Factory Date
  'stock.picking': new Set(['scheduled_date']),                        // Scheduled Date
  'stock.move': new Set(['date']),                                     // Date Scheduled
};

// Models that live_rw may CREATE in
const LIVE_RW_CREATE_MODELS = new Set([
  'project.task',
  'sale.order',
  'sale.order.line',
  'product.pricelist.item',
  'helpdesk.ticket',
  'res.partner',
  'mrp.bom',
  // Adding a component line to an open MO — productionGuard requires the move
  // to name a parent MO, so this can't be used to create loose stock moves.
  'stock.move',
  // Configurator catalogue — see the note on the write list above.
  'vl.configurator.tool',
  'vl.configurator.section',
  'vl.configurator.accessory',
]);

// sale.order states that count as an editable "quote". Anything else (sale =
// confirmed Sales Order, cancel, etc.) is locked down in live_rw mode.
const QUOTE_STATES = new Set(['draft', 'sent']);

// mrp.production states that are still open to edits. 'done' and 'cancel' are
// history — never rewrite them.
const PRODUCTION_STATES = new Set(['draft', 'confirmed', 'progress', 'to_close']);

const MODE_LABELS = {
  staging: '🧪 STAGING',
  live_ro: '🔵 LIVE (read-only)',
  live_rw: '🟠 LIVE (restricted write)',
};
const MODE_LABEL = MODE_LABELS[MODE] || MODE;

// ── Odoo JSON-RPC client ──────────────────────────────────────────────────────

let rpcCounter = 0;

async function odooRpc(service, method, args) {
  const cfg = targetCfg();
  const res = await fetch(`${cfg.url}/jsonrpc`, {
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
    // Odoo puts the Python traceback in data.debug. The last few frames say
    // where a server-side error came from, which the message alone does not.
    const tb = e.data && e.data.debug
      ? String(e.data.debug).trim().split('\n').slice(-8).join('\n')
      : '';
    throw new Error(tb ? `${msg}\n--- Odoo traceback (last frames) ---\n${tb}` : msg);
  }
  return data.result;
}

// One cached uid PER TARGET — live and staging are different databases and
// almost always different user ids, so a single cache would authenticate
// against one and then act as that uid on the other.
const cachedUids = Object.create(null);

async function getUid() {
  const cfg = targetCfg();
  if (cachedUids[cfg.label] == null) {
    const uid = await odooRpc('common', 'authenticate', [cfg.db, cfg.username, cfg.apiKey, {}]);
    if (!uid) {
      throw new Error(
        `Odoo authentication failed against ${cfg.label} (${cfg.url}). ` +
        'Check URL, DB, username and API key.',
      );
    }
    cachedUids[cfg.label] = uid;
  }
  return cachedUids[cfg.label];
}

async function execute(model, method, args, kwargs = {}) {
  const cfg = targetCfg();
  const uid = await getUid();
  return odooRpc('object', 'execute_kw', [cfg.db, uid, cfg.apiKey, model, method, args, kwargs]);
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

// ── Local files ───────────────────────────────────────────────────────────────
// The schedule tools read files from this machine so their bytes go straight
// to Odoo instead of through the tool call. Extensions are checked so a typo'd
// path cannot upload something unintended, and sizes are capped well above
// any real schedule (the Grafton review page is ~13 MB).

const SCHEDULE_FILE_EXTS = new Set(['.html', '.htm', '.json']);
const IMAGE_FILE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
// Tells vl_luminaire_schedule which integration made the change, so the line
// history reads "Edited via claude_desktop_mcp".
const MCP_CONTEXT = { vl_source_channel: 'claude_desktop_mcp' };

function readLocalFile(rawPath, exts, maxMb) {
  if (!rawPath) throw new Error('file_path is required.');
  let p = String(rawPath).trim();
  if (/^file:\/\//i.test(p)) {
    p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, ''));
  }
  const ext = nodePath.extname(p).toLowerCase();
  if (exts && !exts.has(ext)) {
    throw new Error(`Expected ${[...exts].join(' / ')}, got '${ext || 'no extension'}': ${p}`);
  }
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    throw new Error(`File not found: ${p}`);
  }
  if (!stat.isFile()) throw new Error(`Not a file: ${p}`);
  if (stat.size > maxMb * 1024 * 1024) throw new Error(`${nodePath.basename(p)} is over ${maxMb} MB.`);
  const buf = fs.readFileSync(p);
  return { b64: buf.toString('base64'), name: nodePath.basename(p), bytes: buf.length };
}

function looksLikeImage(b64) {
  const raw = Buffer.from(b64.slice(0, 64), 'base64');
  return (
    raw.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
    (raw[0] === 0xff && raw[1] === 0xd8) ||
    (raw.subarray(0, 4).toString('latin1') === 'RIFF' && raw.subarray(8, 12).toString('latin1') === 'WEBP') ||
    ['GIF87a', 'GIF89a'].includes(raw.subarray(0, 6).toString('latin1'))
  );
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<li>/gi, '\n- ')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&rarr;/g, '->')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

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
  if (isStaging() || MODE !== 'live_rw' || (model !== 'sale.order' && model !== 'sale.order.line')) {
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

// Keep MO edits to orders that are still open. A stock.move write is resolved
// back to its parent MO (raw material or finished goods) and judged on that —
// a move that belongs to no MO (a plain transfer) is not writable here at all,
// so inventory moves can't be altered through the configurator path.
async function productionGuard(model, ids = null, values = null) {
  if (isStaging() || MODE !== 'live_rw' || (model !== 'mrp.production' && model !== 'stock.move')) {
    return null;
  }

  let productionIds = [];
  if (model === 'mrp.production') {
    productionIds = [...(ids || [])];
  } else {
    if (ids && ids.length) {
      const moves = await odoo.read('stock.move', [...ids],
        ['raw_material_production_id', 'production_id', 'reference', 'state']);
      for (const mv of moves) {
        const parent = mv.raw_material_production_id || mv.production_id;
        if (!parent) {
          return (
            `stock.move ${mv.reference || mv.id} is not attached to a manufacturing order. ` +
            `${MODE_LABEL} mode only permits move edits on an open MO.`
          );
        }
        if (mv.state === 'done' || mv.state === 'cancel') {
          return `stock.move ${mv.reference || mv.id} is '${mv.state}' and cannot be rewritten.`;
        }
        productionIds.push(parent[0]);
      }
    }
    if (values && values.raw_material_production_id) productionIds.push(values.raw_material_production_id);
  }

  if (productionIds.length) {
    const mos = await odoo.read('mrp.production', [...new Set(productionIds)], ['name', 'state']);
    for (const mo of mos) {
      if (!PRODUCTION_STATES.has(mo.state)) {
        return (
          `Manufacturing order ${mo.name} (id ${mo.id}) is in state '${mo.state}'. ` +
          `${MODE_LABEL} mode may only edit open MOs (${[...PRODUCTION_STATES].join(', ')}).`
        );
      }
    }
  }

  // Don't let a write drive the MO through its workflow — that stays manual.
  if (model === 'mrp.production' && values && 'state' in values) {
    return (
      `Setting mrp.production state to '${values.state}' is not permitted in ` +
      `${MODE_LABEL} mode — marking an MO done or cancelled stays manual.`
    );
  }
  return null;
}

/** True when every key being written is one of the model's allowed date fields. */
function isDateOnlyWrite(model, values) {
  const allowed = LIVE_RW_DATE_FIELDS[model];
  const keys = Object.keys(values || {});
  return Boolean(allowed) && keys.length > 0 && keys.every((k) => allowed.has(k));
}

// Date-only writes to POs, PO lines, transfers and transfer lines. Rejects any
// other field, and any record that is cancelled or (for transfers) already
// done — an arrival that has happened is history, not an ETA.
async function dateGuard(model, ids = null, values = null) {
  if (isStaging() || MODE !== 'live_rw' || !LIVE_RW_DATE_FIELDS[model]) return null;

  const allowed = LIVE_RW_DATE_FIELDS[model];
  const bad = Object.keys(values || {}).filter((k) => !allowed.has(k));
  if (bad.length || !Object.keys(values || {}).length) {
    return (
      `${MODE_LABEL} mode may only change date fields on ${model} ` +
      `(${[...allowed].join(', ')}). Not permitted: ${bad.join(', ') || '(no fields given)'}.`
    );
  }
  if (!ids || !ids.length) return `No ${model} ids given.`;

  if (model === 'purchase.order' || model === 'purchase.order.line') {
    let orderIds = [...ids];
    if (model === 'purchase.order.line') {
      const lines = await odoo.read('purchase.order.line', [...ids], ['order_id']);
      orderIds = lines.filter((l) => l.order_id).map((l) => l.order_id[0]);
    }
    const orders = await odoo.read('purchase.order', [...new Set(orderIds)], ['name', 'state']);
    for (const po of orders) {
      if (po.state === 'cancel' || po.state === 'done') {
        return `Purchase order ${po.name} (id ${po.id}) is '${po.state}' — its dates cannot be changed here.`;
      }
    }
  } else {
    const label = model === 'stock.picking' ? 'name' : 'reference';
    const recs = await odoo.read(model, [...ids], [label, 'state']);
    for (const r of recs) {
      if (r.state === 'done' || r.state === 'cancel') {
        return `${model} ${r.name || r.reference || r.id} is '${r.state}' — its dates cannot be changed here.`;
      }
    }
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
  if (pattern) return `${targetCfg().url}${pattern.replace('{id}', recordId)}`;
  return `${targetCfg().url}/web#model=${model}&id=${recordId}&view_type=form`;
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
      `Test the Odoo connection. Current mode: ${MODE_LABEL} | DB: ${ODOO_DB} | URL: ${targetCfg().url}`,
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
          'and quotes cannot be confirmed into sales orders here. ' +
          'purchase.order, purchase.order.line, stock.picking and stock.move ' +
          '(outside an open MO) are DATE-ONLY: ' +
          Object.entries(LIVE_RW_DATE_FIELDS)
            .map(([m, f]) => `${m} [${[...f].join(', ')}]`).join('; ') +
          ' — not on cancelled POs or done/cancelled transfers.'
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
  {
    name: 'forecast_set',
    description:
      `[${MODE_LABEL}] Set a sales order's invoice forecast (vl_invoice_forecast). ` +
      "Works on quotes AND confirmed orders - it only ever touches the order's forecast_mode " +
      'and its invoice.forecast.line rows, nothing else on the order. ' +
      "mode: 'manual' (forecast typed by month), 'delivery' (follow deliveries - confirmed " +
      "orders only; the module rebuilds the lines itself), 'none' (out of the forecast). " +
      "months: {'YYYY-MM': amount ex-GST} - switches the order to manual if it is not already. " +
      'replace (default true): current/future months NOT listed are cleared, so the months given ' +
      'are the whole remaining forecast. lock_history (default true): past months are set to ' +
      'exactly what was invoiced in them, so no On Order shows in the past. Months before the ' +
      'current one may only be given explicitly with allow_past. Returns the lines before and ' +
      'after, and what is left unforecast.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'integer', description: 'sale.order id' },
        order_name: { type: 'string', description: 'Or the order reference, e.g. S00896' },
        mode: { type: 'string', enum: ['manual', 'delivery', 'none'] },
        months: {
          type: 'object',
          description: "Forecast by month, e.g. {'2026-10': 70000, '2026-11': 166670}",
          additionalProperties: { type: 'number' },
        },
        replace: { type: 'boolean', default: true },
        lock_history: { type: 'boolean', default: true },
        allow_past: { type: 'boolean', default: false },
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

// --- Luminaire schedule tools (vl_luminaire_schedule) ---
// Live-capable from v3.7.0: the module is installed on live, and these tools only
// touch the schedule models (the import wizard, schedule lines' specified image,
// source documents) - never quotes, products or stock. Available on live in
// live_rw mode; in live_ro they stay staging-only, like the other write paths.
const SCHEDULE_LIVE = MODE === 'live_rw' || MODE === 'staging';
const SCHEDULE_LABEL = SCHEDULE_LIVE ? MODE_LABEL : MODE_LABELS.staging;
const SCHEDULE_TOOLS = [
  // Each of these moves file bytes itself - reading a
  // local file or downloading a link - so an image or a whole schedule never
  // has to be written out inside the tool call.
  {
    name: 'schedule_import_file',
    description:
      `[${SCHEDULE_LABEL}] ` + 'File a comparison record as a luminaire schedule, images included. ' +
      'Pass the local path to the review .html (render_html.py output - carries every image) ' +
      'or the .comparison.json (imports without images). mode "create" makes a new schedule; ' +
      'mode "images" adds the specified images to an existing schedule_id, matching lines on legend.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Local path (or file:// URL) to the .html or .comparison.json' },
        mode: { type: 'string', enum: ['create', 'images'], default: 'create' },
        schedule_id: { type: 'integer', description: 'Required for mode "images"' },
        schedule_type: { type: 'string', enum: ['comparison', 'vision_specified', 'specifier_built'], default: 'comparison' },
        overwrite_images: { type: 'boolean', default: false, description: 'mode "images": replace images lines already have' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'schedule_set_image',
    description:
      `[${SCHEDULE_LABEL}] ` + 'Set the specified image on one luminaire-schedule line from a web link or a ' +
      'local file. The connector fetches or reads it. SharePoint links need a login and will not ' +
      'download - use the synced local path instead.',
    inputSchema: {
      type: 'object',
      properties: {
        line_id: { type: 'integer' },
        image_url: { type: 'string' },
        file_path: { type: 'string' },
      },
      required: ['line_id'],
    },
  },
  {
    name: 'schedule_add_source_document',
    description:
      `[${SCHEDULE_LABEL}] ` + 'Attach a source document to a luminaire schedule - normally the specified ' +
      'luminaire schedule it was built against (is_basis true). Prefer url (the SharePoint link, ' +
      'one copy of record); file_path uploads a local file instead.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_id: { type: 'integer' },
        name: { type: 'string', description: 'Short label, e.g. LUMINAIRE SCHEDULE' },
        role: {
          type: 'string',
          enum: ['specified_schedule', 'specification', 'drawing', 'take_off', 'email', 'other'],
          default: 'specified_schedule',
        },
        revision: { type: 'string' },
        issued_on: { type: 'string', description: 'YYYY-MM-DD' },
        url: { type: 'string' },
        reference: { type: 'string', description: 'Drawing number or path as recorded' },
        file_path: { type: 'string' },
        is_basis: { type: 'boolean', default: false },
      },
      required: ['schedule_id', 'name'],
    },
  },
];

// Build final tool list for this mode.
// MODE still decides what may be done to LIVE — configuring a staging database
// must never widen live access, so the staging-only tools are appended without
// disturbing the mode's own tool set. Each of them then refuses any call that
// does not name target 'staging'.
let ALL_TOOLS;
if (MODE === 'staging') {
  ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS, ...DATASHEET_TOOLS, ...SCHEDULE_TOOLS, ...STAGING_ONLY_TOOLS];
} else if (MODE === 'live_rw') {
  ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS, ...DATASHEET_TOOLS, ...SCHEDULE_TOOLS];
} else {
  // live_ro
  ALL_TOOLS = [...READ_TOOLS, ...DATASHEET_TOOLS];
}
if (HAS_STAGING && MODE !== 'staging') {
  // Only the staging-only tools are added. Write tools are deliberately NOT
  // granted to a live_ro install just because staging exists: their guards key
  // off MODE === 'live_rw', so in live_ro they would wave a live write through
  // as well. Read-only stays read-only, on both databases.
  ALL_TOOLS = [...ALL_TOOLS, ...STAGING_ONLY_TOOLS];
  if (!SCHEDULE_LIVE) ALL_TOOLS = [...ALL_TOOLS, ...SCHEDULE_TOOLS];
}
// Every tool takes an optional target once a staging database is configured.
// Declared here rather than on 40 individual schemas so the two can never
// drift apart.
if (HAS_STAGING) {
  const TARGET_PROP = {
    type: 'string',
    enum: ['live', 'staging'],
    default: 'live',
    description:
      "Which database to act on. 'live' is production (restricted writes); " +
      "'staging' is the staging copy and is unrestricted. Defaults to live, " +
      'so a staging action must ask for it explicitly.',
  };
  for (const tool of ALL_TOOLS) {
    if (!tool.inputSchema) tool.inputSchema = { type: 'object', properties: {} };
    if (!tool.inputSchema.properties) tool.inputSchema.properties = {};
    tool.inputSchema.properties.target = TARGET_PROP;
  }
}
const ALLOWED_TOOL_NAMES = new Set(ALL_TOOLS.map((t) => t.name));
const STAGING_ONLY_TOOL_NAMES = new Set([
  ...STAGING_ONLY_TOOLS,
  ...(SCHEDULE_LIVE ? [] : SCHEDULE_TOOLS),
].map((t) => t.name));

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
    const cfg = targetCfg();
    return ok({
      target: cfg.label,
      mode: isStaging() ? '\u{1F9EA} STAGING (full access)' : MODE_LABEL,
      server_version: version,
      uid,
      user,
      db: cfg.db,
      url: cfg.url,
      staging_configured: HAS_STAGING,
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
    if (!isStaging() && MODE === 'live_rw' && !LIVE_RW_CREATE_MODELS.has(model)) {
      return err(
        `Cannot create '${model}' in ${MODE_LABEL} mode. ` +
        `Allowed: ${[...LIVE_RW_CREATE_MODELS].sort().join(', ')}`,
      );
    }
    const guardErr = (await quoteGuard(model, null, args.values))
                  || (await productionGuard(model, null, args.values));
    if (guardErr) return err(guardErr);
    const newId = await odoo.create(model, args.values);
    return ok({ id: newId, model, url: recordUrl(model, newId) });
  }

  if (name === 'odoo_write') {
    const model = args.model;
    if (!isStaging() && MODE === 'live_rw' && !LIVE_RW_WRITE_MODELS.has(model)) {
      return err(
        `Cannot write to '${model}' in ${MODE_LABEL} mode. ` +
        `Allowed: ${[...LIVE_RW_WRITE_MODELS].sort().join(', ')}`,
      );
    }
    // A date-only stock.move write is an ETA update and may land on a receipt
    // or delivery line; anything wider on a move stays on the MO-only path.
    const guardErr = (model === 'stock.move' && isDateOnlyWrite(model, args.values))
      ? await dateGuard(model, args.ids, args.values)
      : (await quoteGuard(model, args.ids, args.values))
        || (await productionGuard(model, args.ids, args.values))
        || (model !== 'stock.move' ? await dateGuard(model, args.ids, args.values) : null);
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

  if (name === 'forecast_set') {
    // Bypasses quoteGuard on purpose: the forecast is planning data, not the
    // order itself. Only forecast_mode on sale.order and the order's own
    // invoice.forecast.line rows are written.
    let orders = [];
    if (args.order_id) {
      orders = await odoo.read('sale.order', [args.order_id], ['name', 'state', 'forecast_mode']);
    } else if (args.order_name) {
      orders = await odoo.searchRead('sale.order', [['name', '=', args.order_name]], {
        fields: ['name', 'state', 'forecast_mode'], limit: 2,
      });
    } else {
      return err('Give order_id or order_name.');
    }
    if (orders.length !== 1) return err(`Sale order ${args.order_id || args.order_name} not found.`);
    const order = orders[0];
    if (order.state === 'cancel') return err(`${order.name} is cancelled.`);

    const months = args.months || null;
    const mode = args.mode || (months ? 'manual' : null);
    if (months && mode !== 'manual') {
      return err("months can only be set on a manual forecast - leave mode out or set it to 'manual'.");
    }
    if (mode === 'delivery' && order.state !== 'sale') {
      return err(`${order.name} is a quotation - it has no deliveries to follow. Use manual.`);
    }
    if (!mode && args.lock_history === undefined) {
      return err('Nothing to do - give mode and/or months.');
    }

    // Month keys as the 1st of the month; "current" is Sydney time.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const thisMonth = `${today.slice(0, 7)}-01`;
    const toMonth = (key) => {
      const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(String(key).trim());
      return m ? `${m[1]}-${m[2]}-01` : null;
    };
    const wanted = {};
    if (months) {
      for (const [key, amount] of Object.entries(months)) {
        const month = toMonth(key);
        if (!month) return err(`Bad month '${key}' - use YYYY-MM.`);
        if (typeof amount !== 'number' || !Number.isFinite(amount)) return err(`Bad amount for ${key}.`);
        if (month < thisMonth && !args.allow_past) {
          return err(`${key} is in the past. Past months follow what was invoiced; pass allow_past to override.`);
        }
        wanted[month] = Math.round(amount * 100) / 100;
      }
    }

    const LINE_FIELDS = ['forecast_month', 'forecast_amount', 'actual_amount', 'delivered_uninvoiced'];
    const readLines = () => odoo.searchRead('invoice.forecast.line', [['order_id', '=', order.id]], {
      fields: LINE_FIELDS, limit: 500, order: 'forecast_month',
    });
    const before = await readLines();

    if (mode && mode !== order.forecast_mode) {
      // On a quote the form shows forecast_mode_quote; writing forecast_mode
      // directly is equivalent (that field's inverse just copies it across).
      await odoo.write('sale.order', [order.id], { forecast_mode: mode });
    }

    const changes = [];
    const effectiveMode = mode || order.forecast_mode;
    if (effectiveMode === 'manual') {
      const lines = await readLines();
      const byMonth = Object.fromEntries(lines.map((l) => [l.forecast_month, l]));
      const toUnlink = [];
      for (const [month, amount] of Object.entries(wanted)) {
        const line = byMonth[month];
        if (line) {
          if (Math.abs(line.forecast_amount - amount) >= 0.005) {
            await odoo.write('invoice.forecast.line', [line.id], { forecast_amount: amount });
            changes.push({ month, from: line.forecast_amount, to: amount });
          }
        } else if (amount) {
          await odoo.create('invoice.forecast.line', {
            order_id: order.id, forecast_month: month, forecast_amount: amount,
          });
          changes.push({ month, from: null, to: amount });
        }
      }
      for (const line of lines) {
        const month = line.forecast_month;
        if (month in wanted) continue;
        if (month >= thisMonth) {
          if (months && args.replace !== false && line.forecast_amount) {
            // Keep a line that carries an actual or a delivered-not-invoiced
            // figure (the report needs it); drop an empty one.
            if (line.actual_amount || line.delivered_uninvoiced) {
              await odoo.write('invoice.forecast.line', [line.id], { forecast_amount: 0 });
            } else {
              toUnlink.push(line.id);
            }
            changes.push({ month, from: line.forecast_amount, to: 0 });
          }
        } else if (args.lock_history !== false) {
          const invoiced = Math.max(line.actual_amount || 0, 0);
          if (Math.abs(line.forecast_amount - invoiced) >= 0.005) {
            await odoo.write('invoice.forecast.line', [line.id], { forecast_amount: invoiced });
            changes.push({ month, from: line.forecast_amount, to: invoiced, note: 'history locked to invoiced' });
          }
        }
      }
      if (toUnlink.length) await odoo.unlink('invoice.forecast.line', toUnlink);
    } else if (months) {
      return err(`${order.name} is not on a manual forecast.`);
    }

    const after = await readLines();
    const [totals] = await odoo.read('sale.order', [order.id],
      ['forecast_mode', 'amount_untaxed', 'forecast_unallocated']);
    const brief = (ls) => ls.map((l) => ({
      month: l.forecast_month.slice(0, 7),
      forecast: l.forecast_amount,
      actual: l.actual_amount,
      delivered_not_invoiced: l.delivered_uninvoiced,
    }));
    return ok({
      order: order.name,
      _url: recordUrl('sale.order', order.id),
      mode_before: order.forecast_mode,
      mode_after: totals.forecast_mode,
      changes,
      lines_before: brief(before),
      lines_after: brief(after),
      order_untaxed: totals.amount_untaxed,
      unforecast: totals.forecast_unallocated,
    });
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

  // ── Luminaire schedule tools ────────────────────────────────────────────────
  if (name === 'schedule_import_file') {
    const file = readLocalFile(args.file_path, SCHEDULE_FILE_EXTS, 80);
    const mode = args.mode === 'images' ? 'images' : 'create';
    if (mode === 'images' && !args.schedule_id) return err('mode "images" needs schedule_id.');
    const vals = {
      file: file.b64,
      filename: file.name,
      mode,
      schedule_type: args.schedule_type || 'comparison',
      overwrite_images: Boolean(args.overwrite_images),
    };
    if (args.schedule_id) vals.schedule_id = args.schedule_id;
    const wizardId = await odoo.create('vl.luminaire.schedule.import', vals);
    const action = await odoo.call('vl.luminaire.schedule.import', 'action_import', [wizardId]);
    const scheduleId = action && action.res_id;
    if (!scheduleId) return err('The import ran but did not say which schedule it filed.');
    const [schedule] = await odoo.read('vl.luminaire.schedule', [scheduleId], ['name', 'line_count']);
    // The import writes its own summary - lines, images, anything it could not
    // match - to the schedule's chatter. Hand that back rather than re-deriving it.
    const [note] = await odoo.searchRead(
      'mail.message',
      // message_post files a note as a 'notification', not a 'comment' -
      // match on the model and record and take the newest with a body.
      [['model', '=', 'vl.luminaire.schedule'], ['res_id', '=', scheduleId], ['body', '!=', false]],
      { fields: ['body'], limit: 1, order: 'id desc' },
    );
    return ok({
      success: true,
      schedule_id: scheduleId,
      name: schedule && schedule.name,
      lines: schedule && schedule.line_count,
      file: file.name,
      size_kb: Math.round(file.bytes / 1024),
      summary: note ? stripHtml(note.body) : '',
      url: recordUrl('vl.luminaire.schedule', scheduleId),
      review_url: `${targetCfg().url}/vl/luminaire_schedule/${scheduleId}/review`,
    });
  }

  if (name === 'schedule_set_image') {
    let b64;
    let from;
    if (args.file_path) {
      const file = readLocalFile(args.file_path, IMAGE_FILE_EXTS, 15);
      b64 = file.b64;
      from = file.name;
    } else if (args.image_url) {
      b64 = await odoo.encodeImageFromUrl(args.image_url);
      from = args.image_url;
    } else {
      return err('Provide image_url or file_path.');
    }
    if (!looksLikeImage(b64)) {
      return err(`${from} is not an image (a SharePoint link returns its login page - use the local path).`);
    }
    await execute('vl.luminaire.schedule.line', 'write', [[args.line_id], { specified_image: b64 }],
      { context: MCP_CONTEXT });
    return ok({ success: true, line_id: args.line_id, from, url: recordUrl('vl.luminaire.schedule.line', args.line_id) });
  }

  if (name === 'schedule_add_source_document') {
    const kwargs = {
      schedule_id: args.schedule_id,
      name: args.name,
      role: args.role || 'specified_schedule',
      revision: args.revision || null,
      issued_on: args.issued_on || null,
      url: args.url || null,
      reference: args.reference || null,
      is_basis: Boolean(args.is_basis),
    };
    if (args.file_path) {
      const file = readLocalFile(args.file_path, null, 40);
      kwargs.file_base64 = file.b64;
      kwargs.filename = file.name;
    }
    if (!kwargs.url && !kwargs.file_base64) {
      return err('Provide url (preferred) or file_path, so the document can be opened from the schedule.');
    }
    const docId = await execute('vl.luminaire.schedule', 'add_source_document', [[]],
      { ...kwargs, context: MCP_CONTEXT });
    return ok({ success: true, document_id: docId, schedule_id: args.schedule_id,
      url: recordUrl('vl.luminaire.schedule', args.schedule_id) });
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
      const target = args.target === 'staging' ? 'staging' : 'live';
      if (target === 'staging' && !HAS_STAGING) {
        return err('No staging database is configured. Set STAGING_URL and '
                 + 'STAGING_DB in the extension settings, then restart Claude.');
      }
      // Staging-only tools stay staging-only even though they are now listed.
      if (target !== 'staging' && STAGING_ONLY_TOOL_NAMES.has(name)) {
        return err(`Tool '${name}' may only be used with target 'staging'.`);
      }
      const { target: _omit, ...rest } = args;
      return await targetStore.run({ target }, () => dispatch(name, rest));
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
