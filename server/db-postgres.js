import crypto from 'node:crypto'
import pg from 'pg'

const { Pool } = pg
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  ssl: { rejectUnauthorized: false }
}) : null

if (pool) await pool.query(`
CREATE TABLE IF NOT EXISTS menu_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, description TEXT, price INTEGER NOT NULL CHECK(price >= 0), available BOOLEAN NOT NULL DEFAULT TRUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id BIGSERIAL PRIMARY KEY, order_number TEXT UNIQUE NOT NULL, reference TEXT UNIQUE NOT NULL, phone TEXT NOT NULL, table_number TEXT, items_json TEXT NOT NULL, subtotal INTEGER NOT NULL, total INTEGER NOT NULL, payment_status TEXT NOT NULL, sms_status TEXT NOT NULL, order_status TEXT NOT NULL DEFAULT 'PAID', razorpay_order_id TEXT, razorpay_payment_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payment_sessions (id BIGSERIAL PRIMARY KEY, reference TEXT UNIQUE NOT NULL, phone TEXT NOT NULL, table_number TEXT, items_json TEXT NOT NULL, subtotal INTEGER NOT NULL, total INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, razorpay_order_id TEXT UNIQUE NOT NULL, razorpay_payment_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, event_name TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS khatta_users (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS khatta_entries (id BIGSERIAL PRIMARY KEY, khatta_user_id BIGINT NOT NULL REFERENCES khatta_users(id) ON DELETE CASCADE, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT, amount INTEGER NOT NULL CHECK(amount >= 0), items_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(order_id));
`)
if (pool) await pool.query('DELETE FROM menu_items WHERE category = $1', ['Breakfast'])
if (pool) await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS khatta_user_id BIGINT')
if (pool) await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_number TEXT')
if (pool) await pool.query('ALTER TABLE payment_sessions ADD COLUMN IF NOT EXISTS table_number TEXT')

const parsePaymentSession = row => ({ ...row, items: JSON.parse(row.items_json) })
const parseOrder = row => ({ ...row, items: JSON.parse(row.items_json), createdAt: row.created_at, updatedAt: row.updated_at })

export const seedMenu = async (items) => {
  const now = new Date().toISOString()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const item of items) await client.query('INSERT INTO menu_items (id,name,category,description,price,available,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (id) DO NOTHING', [item.id, item.name, item.category, item.description || '', item.price, true, now])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

export const replaceMenu = async (items) => {
  const now = new Date().toISOString()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM menu_items')
    for (const item of items) await client.query('INSERT INTO menu_items (id,name,category,description,price,available,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [item.id, item.name, item.category, item.description || '', item.price, true, now])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

export const listMenu = async () => (await pool.query('SELECT id,name,category,description,price,available FROM menu_items ORDER BY created_at, id')).rows.map(item => ({ ...item, available:Boolean(item.available) }))

export const getMenuByIds = async (ids) => {
  if (!ids.length) return []
  return (await pool.query('SELECT id,name,category,description,price,available FROM menu_items WHERE id = ANY($1::text[])', [ids])).rows.map(item => ({ ...item, available:Boolean(item.available) }))
}

export const upsertMenu = async (item) => {
  const now = new Date().toISOString()
  await pool.query('INSERT INTO menu_items (id,name,category,description,price,available,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,price=EXCLUDED.price,available=EXCLUDED.available,updated_at=EXCLUDED.updated_at', [item.id, item.name, item.category, item.description || '', item.price, Boolean(item.available), now])
  return (await listMenu()).find(menuItem => menuItem.id === item.id)
}

export const deleteMenu = async (id) => (await pool.query('DELETE FROM menu_items WHERE id = $1', [id])).rowCount > 0

export const createPaymentSession = async (session) => {
  const now = new Date().toISOString()
  await pool.query('INSERT INTO payment_sessions (reference,phone,table_number,items_json,subtotal,total,currency,status,razorpay_order_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)', [session.reference, session.phone, session.tableNumber || null, session.itemsJson, session.subtotal, session.total, session.currency, session.status, session.razorpayOrderId, now])
  return findPaymentSessionByReference(session.reference)
}

export const findPaymentSessionByReference = async (reference) => {
  const row = (await pool.query('SELECT * FROM payment_sessions WHERE reference = $1', [reference])).rows[0]
  return row ? parsePaymentSession(row) : null
}

export const findPaymentSessionByRazorpayOrderId = async (orderId) => {
  const row = (await pool.query('SELECT * FROM payment_sessions WHERE razorpay_order_id = $1', [orderId])).rows[0]
  return row ? parsePaymentSession(row) : null
}

export const markPaymentSessionFailed = async (orderId) => (await pool.query("UPDATE payment_sessions SET status = 'FAILED', updated_at = $1 WHERE razorpay_order_id = $2 AND status != 'PAID'", [new Date().toISOString(), orderId])).rowCount > 0

export const finalizePaymentSession = async (session, payment) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existing = (await client.query('SELECT * FROM orders WHERE razorpay_payment_id = $1 OR razorpay_order_id = $2 LIMIT 1', [payment.id, session.razorpay_order_id])).rows[0]
    if (existing) { await client.query('COMMIT'); return parseOrder(existing) }
    const now = new Date().toISOString()
    const count = (await client.query('SELECT COUNT(*)::int AS count FROM orders')).rows[0].count
    const orderNumber = `CCB-${String(count + 1).padStart(3, '0')}`
    const inserted = (await client.query("INSERT INTO orders (order_number,reference,phone,table_number,items_json,subtotal,total,payment_status,sms_status,order_status,razorpay_order_id,razorpay_payment_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'PAID',$8,'PAID',$9,$10,$11,$11) RETURNING *", [orderNumber, session.reference, session.phone, session.table_number || null, session.items_json, session.subtotal, session.total, 'PENDING', session.razorpay_order_id, payment.id, now])).rows[0]
    await client.query("UPDATE payment_sessions SET status = 'PAID', razorpay_payment_id = $1, updated_at = $2 WHERE reference = $3", [payment.id, now, session.reference])
    await client.query('COMMIT')
    return parseOrder(inserted)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

export const findKhattaUserByPhone = async phone => {
  const row = (await pool.query('SELECT id,name,phone,active FROM khatta_users WHERE phone = $1 AND active = TRUE', [phone])).rows[0]
  return row || null
}

export const createKhattaOrder = async ({ khattaUserId, reference, phone, tableNumber, itemsJson, subtotal, total }) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const now = new Date().toISOString()
    const count = (await client.query('SELECT COUNT(*)::int AS count FROM orders')).rows[0].count
    const orderNumber = `CCB-${String(count + 1).padStart(3, '0')}`
    const order = (await client.query("INSERT INTO orders (order_number,reference,phone,table_number,items_json,subtotal,total,payment_status,sms_status,order_status,khatta_user_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'KHATTA','NOT_REQUIRED','PAID',$8,$9,$9) RETURNING *", [orderNumber, reference, phone, tableNumber || null, itemsJson, subtotal, total, khattaUserId, now])).rows[0]
    await client.query('INSERT INTO khatta_entries (khatta_user_id,order_id,amount,items_json,created_at) VALUES ($1,$2,$3,$4,$5)', [khattaUserId, order.id, total, itemsJson, now])
    await client.query('COMMIT')
    return parseOrder(order)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
export const syncFoodMenu = async (items, version) => {
  const current = (await pool.query('SELECT value FROM app_settings WHERE key = $1', ['food-menu-version'])).rows[0]
  if (current?.value === version) return
  const client = await pool.connect()
  const now = new Date().toISOString()
  try {
    await client.query('BEGIN')
    await client.query("DELETE FROM menu_items WHERE category <> 'Cigarettes'")
    for (const item of items) await client.query('INSERT INTO menu_items (id,name,category,description,price,available,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)', [item.id, item.name, item.category, item.description || '', item.price, true, now])
    await client.query('INSERT INTO app_settings (key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', ['food-menu-version', version])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

export const createCashOrder = async ({ reference, phone, tableNumber, itemsJson, subtotal, total }) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const now = new Date().toISOString()
    const count = (await client.query('SELECT COUNT(*)::int AS count FROM orders')).rows[0].count
    const orderNumber = `CCB-${String(count + 1).padStart(3, '0')}`
    const order = (await client.query("INSERT INTO orders (order_number,reference,phone,table_number,items_json,subtotal,total,payment_status,sms_status,order_status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'CASH','NOT_REQUIRED','PAID',$8,$8) RETURNING *", [orderNumber, reference, phone, tableNumber || null, itemsJson, subtotal, total, now])).rows[0]
    await client.query('COMMIT')
    return parseOrder(order)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
export const confirmCashOrder = async (id) => {
  const updated = (await pool.query("UPDATE orders SET payment_status = 'PAID', updated_at = $1 WHERE id = $2 AND payment_status = 'CASH' RETURNING *", [new Date().toISOString(), id])).rows[0]
  return updated ? parseOrder(updated) : null
}

export const createKhattaUser = async ({ name, phone }) => {
  const now = new Date().toISOString()
  const result = await pool.query('INSERT INTO khatta_users (name,phone,active,created_at,updated_at) VALUES ($1,$2,TRUE,$3,$3) RETURNING id,name,phone,active,created_at,updated_at', [name, phone, now])
  return result.rows[0]
}

export const listKhattaUsers = async () => (await pool.query('SELECT u.id,u.name,u.phone,u.active,u.created_at,u.updated_at,COALESCE(SUM(e.amount),0)::int AS balance,COUNT(e.id)::int AS entry_count FROM khatta_users u LEFT JOIN khatta_entries e ON e.khatta_user_id = u.id WHERE u.active = TRUE GROUP BY u.id ORDER BY u.name')).rows

export const getKhattaStatement = async userId => {
  const user = (await pool.query('SELECT id,name,phone,active FROM khatta_users WHERE id = $1 AND active = TRUE', [userId])).rows[0]
  if (!user) return null
  const entries = (await pool.query('SELECT e.id,e.order_id,o.order_number,o.reference,e.amount,e.items_json,e.created_at FROM khatta_entries e JOIN orders o ON o.id = e.order_id WHERE e.khatta_user_id = $1 ORDER BY e.created_at,e.id', [userId])).rows.map(entry => ({ ...entry, items:JSON.parse(entry.items_json) }))
  return { user, entries, total:entries.reduce((sum, entry) => sum + Number(entry.amount), 0) }
}

export const settleKhattaUser = async (userId, entryIds) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const user = (await client.query('SELECT id,name,phone FROM khatta_users WHERE id = $1 AND active = TRUE', [userId])).rows[0]
    if (!user) { await client.query('ROLLBACK'); return null }
    const entries = (await client.query('SELECT e.id,e.order_id,o.order_number,o.reference,e.amount,e.items_json,e.created_at FROM khatta_entries e JOIN orders o ON o.id = e.order_id WHERE e.khatta_user_id = $1 AND e.id = ANY($2::bigint[]) ORDER BY e.created_at,e.id', [userId, entryIds])).rows.map(entry => ({ ...entry, items:JSON.parse(entry.items_json) }))
    const total = entries.reduce((sum, entry) => sum + Number(entry.amount), 0)
    await client.query('DELETE FROM khatta_entries WHERE khatta_user_id = $1 AND id = ANY($2::bigint[])', [userId, entryIds])
    await client.query('COMMIT')
    return { user, entries, total }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

export const hasWebhookEvent = async eventId => Boolean((await pool.query('SELECT event_id FROM webhook_events WHERE event_id = $1', [eventId])).rows[0])
export const recordWebhookEvent = async (eventId, eventName) => (await pool.query('INSERT INTO webhook_events (event_id,event_name,received_at) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING', [eventId, eventName, new Date().toISOString()])).rowCount > 0
export const listOrders = async () => (await pool.query('SELECT * FROM orders ORDER BY created_at DESC, id DESC')).rows.map(parseOrder)

export const findReceipt = async (reference) => {
  const row = (await pool.query('SELECT * FROM orders WHERE reference = $1', [reference])).rows[0]
  return row ? parseOrder(row) : null
}

export const newReference = () => crypto.randomBytes(18).toString('hex')
