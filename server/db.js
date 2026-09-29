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
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_number TEXT UNIQUE NOT NULL, reference TEXT UNIQUE NOT NULL, phone TEXT NOT NULL, table_number TEXT, items_json TEXT NOT NULL, subtotal INTEGER NOT NULL, total INTEGER NOT NULL, payment_status TEXT NOT NULL, payment_method TEXT, sms_status TEXT NOT NULL, order_status TEXT NOT NULL DEFAULT 'PAID', razorpay_order_id TEXT, razorpay_payment_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payment_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, reference TEXT UNIQUE NOT NULL, phone TEXT NOT NULL, table_number TEXT, items_json TEXT NOT NULL, subtotal INTEGER NOT NULL, total INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, razorpay_order_id TEXT UNIQUE NOT NULL, razorpay_payment_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, event_name TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS khatta_users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS khatta_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, khatta_user_id INTEGER NOT NULL REFERENCES khatta_users(id) ON DELETE CASCADE, order_id INTEGER NOT NULL, order_number TEXT NOT NULL, reference TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount >= 0), items_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(order_id));
CREATE TABLE IF NOT EXISTS khatta_settlements (id INTEGER PRIMARY KEY AUTOINCREMENT, khatta_user_id INTEGER NOT NULL REFERENCES khatta_users(id) ON DELETE CASCADE, amount INTEGER NOT NULL CHECK(amount > 0), note TEXT, created_at TEXT NOT NULL);
`)
db.prepare("DELETE FROM menu_items WHERE category = ?").run('Breakfast')
try { db.exec("ALTER TABLE orders ADD COLUMN order_status TEXT NOT NULL DEFAULT 'PAID'") } catch { /* Existing databases already have the column. */ }
try { db.exec("ALTER TABLE orders ADD COLUMN khatta_user_id INTEGER") } catch { /* Existing databases already have the column. */ }
try { db.exec("ALTER TABLE orders ADD COLUMN table_number TEXT") } catch { /* Existing databases already have the column. */ }
try { db.exec("ALTER TABLE orders ADD COLUMN payment_method TEXT") } catch { /* Existing databases already have the column. */ }
try { db.exec("ALTER TABLE payment_sessions ADD COLUMN table_number TEXT") } catch { /* Existing databases already have the column. */ }
try { db.exec("ALTER TABLE khatta_entries ADD COLUMN order_number TEXT") } catch { /* Existing databases already have the column. */ }
try { db.exec("ALTER TABLE khatta_entries ADD COLUMN reference TEXT") } catch { /* Existing databases already have the column. */ }
try { db.exec("UPDATE khatta_entries SET order_number = (SELECT order_number FROM orders WHERE orders.id = khatta_entries.order_id), reference = (SELECT reference FROM orders WHERE orders.id = khatta_entries.order_id) WHERE order_number IS NULL OR reference IS NULL") } catch { /* Existing databases may already be migrated. */ }
if (db.prepare("PRAGMA foreign_key_list(khatta_entries)").all().some(key => key.table === 'orders')) {
  db.pragma('foreign_keys = OFF')
  db.transaction(() => { db.exec('CREATE TABLE khatta_entries_new (id INTEGER PRIMARY KEY AUTOINCREMENT, khatta_user_id INTEGER NOT NULL REFERENCES khatta_users(id) ON DELETE CASCADE, order_id INTEGER NOT NULL, order_number TEXT NOT NULL, reference TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount >= 0), items_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(order_id)); INSERT INTO khatta_entries_new (id,khatta_user_id,order_id,order_number,reference,amount,items_json,created_at) SELECT id,khatta_user_id,order_id,COALESCE(order_number,\'legacy\'),COALESCE(reference,\'legacy\'),amount,items_json,created_at FROM khatta_entries; DROP TABLE khatta_entries; ALTER TABLE khatta_entries_new RENAME TO khatta_entries;') })()
}

export const seedMenu = (items) => {
  const insert = db.prepare('INSERT OR IGNORE INTO menu_items (id,name,category,description,price,available,created_at,updated_at) VALUES (@id,@name,@category,@description,@price,@available,@now,@now)')
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
export const nextOrderNumber = () => { const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'orders'").get(); return `CCB-${String(Number(row?.seq || 0) + 1).padStart(3, '0')}` }
export const createPaymentSession = (session) => { const now = new Date().toISOString(); db.prepare(`INSERT INTO payment_sessions (reference,phone,table_number,items_json,subtotal,total,currency,status,razorpay_order_id,created_at,updated_at) VALUES (@reference,@phone,@tableNumber,@itemsJson,@subtotal,@total,@currency,@status,@razorpayOrderId,@now,@now)`).run({ ...session, tableNumber:session.tableNumber || null, now }); return findPaymentSessionByReference(session.reference) }
export const findPaymentSessionByReference = (reference) => { const row = db.prepare('SELECT * FROM payment_sessions WHERE reference = ?').get(reference); return row ? parsePaymentSession(row) : null }
export const findPaymentSessionByRazorpayOrderId = (orderId) => { const row = db.prepare('SELECT * FROM payment_sessions WHERE razorpay_order_id = ?').get(orderId); return row ? parsePaymentSession(row) : null }
export const markPaymentSessionFailed = (orderId) => db.prepare("UPDATE payment_sessions SET status = 'FAILED', updated_at = ? WHERE razorpay_order_id = ? AND status = 'PENDING'").run(new Date().toISOString(), orderId).changes > 0
export const finalizePaymentSession = (session, payment) => {
  const existing = db.prepare('SELECT * FROM orders WHERE razorpay_payment_id = ? OR razorpay_order_id = ?').get(payment.id, session.razorpay_order_id)
  if (existing) return parseOrder(existing)
  const now = new Date().toISOString()
  const orderNumber = nextOrderNumber()
  const insert = db.prepare(`INSERT INTO orders (order_number,reference,phone,table_number,items_json,subtotal,total,payment_status,payment_method,sms_status,order_status,razorpay_order_id,razorpay_payment_id,created_at,updated_at) VALUES (@orderNumber,@reference,@phone,@tableNumber,@itemsJson,@subtotal,@total,'PAID','ONLINE',@smsStatus,'PAID',@razorpayOrderId,@razorpayPaymentId,@now,@now)`)
  const tx = db.transaction(() => { const result = insert.run({ orderNumber, reference:session.reference, phone:session.phone, tableNumber:session.table_number || null, itemsJson:session.items_json, subtotal:session.subtotal, total:session.total, smsStatus:'PENDING', razorpayOrderId:session.razorpay_order_id, razorpayPaymentId:payment.id, now }); db.prepare("UPDATE payment_sessions SET status = 'PAID', razorpay_payment_id = ?, updated_at = ? WHERE reference = ?").run(payment.id, now, session.reference); return result.lastInsertRowid })
  const id = tx()
  return parseOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id))
}
export const findKhattaUserByPhone = (phone) => db.prepare('SELECT id,name,phone,active FROM khatta_users WHERE phone = ? AND active = 1').get(phone) || null
export const createKhattaOrder = ({ khattaUserId, reference, phone, tableNumber, itemsJson, subtotal, total }) => {
  const now = new Date().toISOString()
  const tx = db.transaction(() => {
    const orderNumber = nextOrderNumber()
    const result = db.prepare("INSERT INTO orders (order_number,reference,phone,table_number,items_json,subtotal,total,payment_status,payment_method,sms_status,order_status,khatta_user_id,created_at,updated_at) VALUES (@orderNumber,@reference,@phone,@tableNumber,@itemsJson,@subtotal,@total,'KHATTA','KHATTA','NOT_REQUIRED','PAID',@khattaUserId,@now,@now)").run({ orderNumber, reference, phone, tableNumber:tableNumber || null, itemsJson, subtotal, total, khattaUserId, now })
    db.prepare('INSERT INTO khatta_entries (khatta_user_id,order_id,order_number,reference,amount,items_json,created_at) VALUES (?,?,?,?,?,?,?)').run(khattaUserId, result.lastInsertRowid, orderNumber, reference, total, itemsJson, now)
    return result.lastInsertRowid
  })
  return parseOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(tx()))
}
export const syncFoodMenu = (items, version) => {
  if (db.prepare('SELECT value FROM app_settings WHERE key = ?').get('food-menu-version')?.value === version) return
  const insert = db.prepare('INSERT INTO menu_items (id,name,category,description,price,available,created_at,updated_at) VALUES (@id,@name,@category,@description,@price,@available,@now,@now)')
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare("DELETE FROM menu_items WHERE category <> 'Cigarettes'").run()
    items.forEach(item => insert.run({ ...item, available: 1, now }))
    db.prepare('INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('food-menu-version', version)
  })()
}
export const createCashOrder = ({ reference, phone, tableNumber, itemsJson, subtotal, total }) => {
  const now = new Date().toISOString()
  const result = db.prepare("INSERT INTO orders (order_number,reference,phone,table_number,items_json,subtotal,total,payment_status,payment_method,sms_status,order_status,created_at,updated_at) VALUES (@orderNumber,@reference,@phone,@tableNumber,@itemsJson,@subtotal,@total,'CASH','CASH','NOT_REQUIRED','PAID',@now,@now)").run({ orderNumber:nextOrderNumber(), reference, phone, tableNumber:tableNumber || null, itemsJson, subtotal, total, now })
  return parseOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid))
}
export const confirmCashOrder = (id) => {
  const now = new Date().toISOString()
  const result = db.prepare("UPDATE orders SET payment_status = 'PAID', payment_method = 'CASH', updated_at = ? WHERE id = ? AND payment_status = 'CASH'").run(now, id)
  return result.changes ? parseOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)) : null
}
export const createKhattaUser = ({ name, phone }) => { const now = new Date().toISOString(); const result = db.prepare('INSERT INTO khatta_users (name,phone,active,created_at,updated_at) VALUES (?,?,1,?,?)').run(name, phone, now, now); return db.prepare('SELECT id,name,phone,active,created_at,updated_at FROM khatta_users WHERE id = ?').get(result.lastInsertRowid) }
export const listKhattaUsers = () => db.prepare('SELECT u.id,u.name,u.phone,u.active,u.created_at,u.updated_at,COALESCE(SUM(e.amount),0) AS balance,COUNT(e.id) AS entry_count FROM khatta_users u LEFT JOIN khatta_entries e ON e.khatta_user_id = u.id WHERE u.active = 1 GROUP BY u.id ORDER BY u.name').all()
export const getKhattaStatement = (userId) => { const user = db.prepare('SELECT id,name,phone,active FROM khatta_users WHERE id = ? AND active = 1').get(userId); if (!user) return null; const entries = db.prepare('SELECT id,order_id,order_number,reference,amount,items_json,created_at FROM khatta_entries WHERE khatta_user_id = ? ORDER BY created_at,id').all(userId).map(entry => ({ ...entry, items:JSON.parse(entry.items_json) })); return { user, entries, settlements:listKhattaSettlements(userId), total:entries.reduce((sum, entry) => sum + Number(entry.amount), 0) } }
export const listKhattaSettlements = (userId) => db.prepare('SELECT id,amount,note,created_at FROM khatta_settlements WHERE khatta_user_id = ? ORDER BY created_at DESC,id DESC').all(userId)
export const settleKhattaUser = (userId, amount, note = '') => { const statement = getKhattaStatement(userId); if (!statement) return null; const requested = Number(amount); if (!Number.isInteger(requested) || requested <= 0 || requested > statement.total) throw Object.assign(new Error('Settlement amount must be a positive whole number not greater than the outstanding balance'), { status:400 }); db.transaction(() => { let remaining = requested; const entries = db.prepare('SELECT id,amount FROM khatta_entries WHERE khatta_user_id = ? ORDER BY created_at,id').all(userId); for (const entry of entries) { if (!remaining) break; const applied = Math.min(remaining, Number(entry.amount)); const next = Number(entry.amount) - applied; if (next) db.prepare('UPDATE khatta_entries SET amount = ? WHERE id = ?').run(next, entry.id); else db.prepare('DELETE FROM khatta_entries WHERE id = ?').run(entry.id); remaining -= applied } db.prepare('INSERT INTO khatta_settlements (khatta_user_id,amount,note,created_at) VALUES (?,?,?,?)').run(userId, requested, String(note || '').trim() || null, new Date().toISOString()) })(); return { ...getKhattaStatement(userId), settledAmount:requested, settlements:listKhattaSettlements(userId) } }
export const getSetting = (key, fallback = null) => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? fallback
export const setSetting = (key, value) => db.prepare('INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value))
export const purgeTransientData = () => { const pendingCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); const terminalCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString(); const webhookCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); db.transaction(() => { db.prepare("DELETE FROM payment_sessions WHERE status = 'PENDING' AND updated_at < ?").run(pendingCutoff); db.prepare("DELETE FROM payment_sessions WHERE status IN ('PAID','FAILED') AND updated_at < ?").run(terminalCutoff); db.prepare('DELETE FROM webhook_events WHERE received_at < ?').run(webhookCutoff) })() }
const orderDay = value => { const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone:process.env.APP_TIMEZONE || 'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, part.value])); return `${parts.year}-${parts.month}-${parts.day}` }
export const clearOrdersAfterExport = (orderIds) => { const ids = [...new Set((orderIds || []).map(Number).filter(Number.isInteger))]; if (!ids.length) return; const today = orderDay(new Date()); const candidates = db.prepare(`SELECT id,created_at FROM orders WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).filter(order => orderDay(order.created_at) < today).map(order => order.id); if (candidates.length) db.prepare(`DELETE FROM orders WHERE id IN (${candidates.map(() => '?').join(',')})`).run(...candidates) }
export const hasWebhookEvent = (eventId) => Boolean(db.prepare('SELECT event_id FROM webhook_events WHERE event_id = ?').get(eventId))
export const recordWebhookEvent = (eventId, eventName) => db.prepare('INSERT OR IGNORE INTO webhook_events (event_id,event_name,received_at) VALUES (?,?,?)').run(eventId, eventName, new Date().toISOString()).changes > 0
export const createOrder = (order) => { const now = new Date().toISOString(); const result = db.prepare(`INSERT INTO orders (order_number,reference,phone,items_json,subtotal,total,payment_status,sms_status,order_status,razorpay_order_id,razorpay_payment_id,created_at,updated_at) VALUES (@orderNumber,@reference,@phone,@itemsJson,@subtotal,@total,@paymentStatus,@smsStatus,@orderStatus,@razorpayOrderId,@razorpayPaymentId,@now,@now)`).run({ orderStatus:'PAID', ...order, now }); return { ...order, id: result.lastInsertRowid, createdAt: now } }
export const listOrders = () => db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all().map(parseOrder)
export const findReceipt = (reference) => { const row = db.prepare('SELECT * FROM orders WHERE reference = ?').get(reference); return row ? parseOrder(row) : null }
const parsePaymentSession = row => ({ ...row, items: JSON.parse(row.items_json) })
const parseOrder = row => ({ ...row, items: JSON.parse(row.items_json), createdAt: row.created_at, updatedAt: row.updated_at })
export const newReference = () => crypto.randomBytes(18).toString('hex')
