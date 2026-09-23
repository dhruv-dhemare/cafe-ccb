import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.DATABASE_PATH || path.join(root, 'ccb.sqlite')
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.exec(`
CREATE TABLE IF NOT EXISTS menu_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, description TEXT, price INTEGER NOT NULL CHECK(price >= 0), available INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_number TEXT UNIQUE NOT NULL, reference TEXT UNIQUE NOT NULL, phone TEXT NOT NULL, items_json TEXT NOT NULL, subtotal INTEGER NOT NULL, total INTEGER NOT NULL, payment_status TEXT NOT NULL, sms_status TEXT NOT NULL, order_status TEXT NOT NULL DEFAULT 'PAID', razorpay_order_id TEXT, razorpay_payment_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payment_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, reference TEXT UNIQUE NOT NULL, phone TEXT NOT NULL, items_json TEXT NOT NULL, subtotal INTEGER NOT NULL, total INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, razorpay_order_id TEXT UNIQUE NOT NULL, razorpay_payment_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, event_name TEXT NOT NULL, received_at TEXT NOT NULL);
`)
try { db.exec("ALTER TABLE orders ADD COLUMN order_status TEXT NOT NULL DEFAULT 'PAID'") } catch { /* Existing databases already have the column. */ }

export const seedMenu = (items) => {
  if (db.prepare('SELECT COUNT(*) count FROM menu_items').get().count) return
  const insert = db.prepare('INSERT INTO menu_items (id,name,category,description,price,available,created_at,updated_at) VALUES (@id,@name,@category,@description,@price,@available,@now,@now)')
  const now = new Date().toISOString()
  db.transaction(() => items.forEach(item => insert.run({ ...item, available: 1, now })))()
}
export const replaceMenu = (items) => {
  const insert = db.prepare('INSERT INTO menu_items (id,name,category,description,price,available,created_at,updated_at) VALUES (@id,@name,@category,@description,@price,@available,@now,@now)')
  const now = new Date().toISOString()
  db.transaction(() => { db.prepare('DELETE FROM menu_items').run(); items.forEach(item => insert.run({ ...item, available: 1, now })) })()
}
export const listMenu = () => db.prepare('SELECT id,name,category,description,price,available FROM menu_items ORDER BY rowid').all().map(i => ({ ...i, available: Boolean(i.available) }))
export const getMenuByIds = (ids) => db.prepare(`SELECT id,name,category,description,price,available FROM menu_items WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(i => ({ ...i, available: Boolean(i.available) }))
export const upsertMenu = (item) => { const now = new Date().toISOString(); db.prepare(`INSERT INTO menu_items (id,name,category,description,price,available,created_at,updated_at) VALUES (@id,@name,@category,@description,@price,@available,@now,@now) ON CONFLICT(id) DO UPDATE SET name=@name,category=@category,description=@description,price=@price,available=@available,updated_at=@now`).run({ ...item, now, available: item.available ? 1 : 0 }); return listMenu().find(i => i.id === item.id) }
export const deleteMenu = (id) => db.prepare('DELETE FROM menu_items WHERE id = ?').run(id).changes > 0
export const nextOrderNumber = () => { const row = db.prepare('SELECT COUNT(*) count FROM orders').get(); return `CCB-${String(row.count + 1).padStart(3, '0')}` }
export const createPaymentSession = (session) => { const now = new Date().toISOString(); db.prepare(`INSERT INTO payment_sessions (reference,phone,items_json,subtotal,total,currency,status,razorpay_order_id,created_at,updated_at) VALUES (@reference,@phone,@itemsJson,@subtotal,@total,@currency,@status,@razorpayOrderId,@now,@now)`).run({ ...session, now }); return findPaymentSessionByReference(session.reference) }
export const findPaymentSessionByReference = (reference) => { const row = db.prepare('SELECT * FROM payment_sessions WHERE reference = ?').get(reference); return row ? parsePaymentSession(row) : null }
export const findPaymentSessionByRazorpayOrderId = (orderId) => { const row = db.prepare('SELECT * FROM payment_sessions WHERE razorpay_order_id = ?').get(orderId); return row ? parsePaymentSession(row) : null }
export const markPaymentSessionFailed = (orderId) => db.prepare("UPDATE payment_sessions SET status = 'FAILED', updated_at = ? WHERE razorpay_order_id = ? AND status != 'PAID'").run(new Date().toISOString(), orderId).changes > 0
export const finalizePaymentSession = (session, payment) => {
  const existing = db.prepare('SELECT * FROM orders WHERE razorpay_payment_id = ? OR razorpay_order_id = ?').get(payment.id, session.razorpay_order_id)
  if (existing) return parseOrder(existing)
  const now = new Date().toISOString()
  const orderNumber = nextOrderNumber()
  const insert = db.prepare(`INSERT INTO orders (order_number,reference,phone,items_json,subtotal,total,payment_status,sms_status,order_status,razorpay_order_id,razorpay_payment_id,created_at,updated_at) VALUES (@orderNumber,@reference,@phone,@itemsJson,@subtotal,@total,'PAID',@smsStatus,'PAID',@razorpayOrderId,@razorpayPaymentId,@now,@now)`)
  const tx = db.transaction(() => { const result = insert.run({ orderNumber, reference:session.reference, phone:session.phone, itemsJson:session.items_json, subtotal:session.subtotal, total:session.total, smsStatus:'PENDING', razorpayOrderId:session.razorpay_order_id, razorpayPaymentId:payment.id, now }); db.prepare("UPDATE payment_sessions SET status = 'PAID', razorpay_payment_id = ?, updated_at = ? WHERE reference = ?").run(payment.id, now, session.reference); return result.lastInsertRowid })
  const id = tx()
  return parseOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id))
}
export const hasWebhookEvent = (eventId) => Boolean(db.prepare('SELECT event_id FROM webhook_events WHERE event_id = ?').get(eventId))
export const recordWebhookEvent = (eventId, eventName) => db.prepare('INSERT OR IGNORE INTO webhook_events (event_id,event_name,received_at) VALUES (?,?,?)').run(eventId, eventName, new Date().toISOString()).changes > 0
export const createOrder = (order) => { const now = new Date().toISOString(); const result = db.prepare(`INSERT INTO orders (order_number,reference,phone,items_json,subtotal,total,payment_status,sms_status,order_status,razorpay_order_id,razorpay_payment_id,created_at,updated_at) VALUES (@orderNumber,@reference,@phone,@itemsJson,@subtotal,@total,@paymentStatus,@smsStatus,@orderStatus,@razorpayOrderId,@razorpayPaymentId,@now,@now)`).run({ orderStatus:'PAID', ...order, now }); return { ...order, id: result.lastInsertRowid, createdAt: now } }
export const listOrders = () => db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all().map(parseOrder)
export const findReceipt = (reference) => { const row = db.prepare('SELECT * FROM orders WHERE reference = ?').get(reference); return row ? parseOrder(row) : null }
export const updateOrderStatus = (id, status) => { const now = new Date().toISOString(); const result = db.prepare('UPDATE orders SET order_status = ?, updated_at = ? WHERE id = ?').run(status, now, id); return result.changes > 0 }
const parsePaymentSession = row => ({ ...row, items: JSON.parse(row.items_json) })
const parseOrder = row => ({ ...row, items: JSON.parse(row.items_json), createdAt: row.created_at, updatedAt: row.updated_at })
export const newReference = () => crypto.randomBytes(18).toString('hex')
