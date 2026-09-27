import 'dotenv/config'
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg
const root = path.dirname(fileURLToPath(import.meta.url))
const sqlitePath = process.env.SQLITE_PATH || process.env.DATABASE_PATH || path.join(root, 'ccb.sqlite')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the migration target.')

const source = new Database(sqlitePath, { readonly:true })
const target = new Pool({ connectionString:process.env.DATABASE_URL, max:2, ssl:{ rejectUnauthorized:false } })

const schema = `
CREATE TABLE IF NOT EXISTS menu_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, description TEXT, price INTEGER NOT NULL CHECK(price >= 0), available BOOLEAN NOT NULL DEFAULT TRUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (id BIGSERIAL PRIMARY KEY, order_number TEXT UNIQUE NOT NULL, reference TEXT UNIQUE NOT NULL, phone TEXT NOT NULL, items_json TEXT NOT NULL, subtotal INTEGER NOT NULL, total INTEGER NOT NULL, payment_status TEXT NOT NULL, sms_status TEXT NOT NULL, order_status TEXT NOT NULL DEFAULT 'PAID', razorpay_order_id TEXT, razorpay_payment_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payment_sessions (id BIGSERIAL PRIMARY KEY, reference TEXT UNIQUE NOT NULL, phone TEXT NOT NULL, items_json TEXT NOT NULL, subtotal INTEGER NOT NULL, total INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, razorpay_order_id TEXT UNIQUE NOT NULL, razorpay_payment_id TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, event_name TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS khatta_users (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS khatta_entries (id BIGSERIAL PRIMARY KEY, khatta_user_id BIGINT NOT NULL REFERENCES khatta_users(id) ON DELETE CASCADE, order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT, amount INTEGER NOT NULL CHECK(amount >= 0), items_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(order_id));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS khatta_user_id BIGINT;
`

const menu = source.prepare('SELECT id,name,category,description,price,available,created_at,updated_at FROM menu_items ORDER BY rowid').all()
const orders = source.prepare('SELECT id,order_number,reference,phone,items_json,subtotal,total,payment_status,sms_status,order_status,razorpay_order_id,razorpay_payment_id,created_at,updated_at FROM orders ORDER BY id').all()
const sessions = source.prepare('SELECT id,reference,phone,items_json,subtotal,total,currency,status,razorpay_order_id,razorpay_payment_id,created_at,updated_at FROM payment_sessions ORDER BY id').all()
const events = source.prepare('SELECT event_id,event_name,received_at FROM webhook_events ORDER BY event_id').all()

const client = await target.connect()
try {
  await client.query('BEGIN')
  await client.query(schema)

  for (const item of menu) await client.query('INSERT INTO menu_items (id,name,category,description,price,available,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,description=EXCLUDED.description,price=EXCLUDED.price,available=EXCLUDED.available,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at', [item.id,item.name,item.category,item.description,item.price,Boolean(item.available),item.created_at,item.updated_at])
  for (const order of orders) await client.query('INSERT INTO orders (id,order_number,reference,phone,items_json,subtotal,total,payment_status,sms_status,order_status,razorpay_order_id,razorpay_payment_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO UPDATE SET order_number=EXCLUDED.order_number,reference=EXCLUDED.reference,phone=EXCLUDED.phone,items_json=EXCLUDED.items_json,subtotal=EXCLUDED.subtotal,total=EXCLUDED.total,payment_status=EXCLUDED.payment_status,sms_status=EXCLUDED.sms_status,order_status=EXCLUDED.order_status,razorpay_order_id=EXCLUDED.razorpay_order_id,razorpay_payment_id=EXCLUDED.razorpay_payment_id,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at', [order.id,order.order_number,order.reference,order.phone,order.items_json,order.subtotal,order.total,order.payment_status,order.sms_status,order.order_status,order.razorpay_order_id,order.razorpay_payment_id,order.created_at,order.updated_at])
  for (const session of sessions) await client.query('INSERT INTO payment_sessions (id,reference,phone,items_json,subtotal,total,currency,status,razorpay_order_id,razorpay_payment_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO UPDATE SET reference=EXCLUDED.reference,phone=EXCLUDED.phone,items_json=EXCLUDED.items_json,subtotal=EXCLUDED.subtotal,total=EXCLUDED.total,currency=EXCLUDED.currency,status=EXCLUDED.status,razorpay_order_id=EXCLUDED.razorpay_order_id,razorpay_payment_id=EXCLUDED.razorpay_payment_id,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at', [session.id,session.reference,session.phone,session.items_json,session.subtotal,session.total,session.currency,session.status,session.razorpay_order_id,session.razorpay_payment_id,session.created_at,session.updated_at])
  for (const event of events) await client.query('INSERT INTO webhook_events (event_id,event_name,received_at) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO UPDATE SET event_name=EXCLUDED.event_name,received_at=EXCLUDED.received_at', [event.event_id,event.event_name,event.received_at])

  await client.query("SELECT setval(pg_get_serial_sequence('orders','id'), COALESCE((SELECT MAX(id) FROM orders), 1), (SELECT COUNT(*) > 0 FROM orders))")
  await client.query("SELECT setval(pg_get_serial_sequence('payment_sessions','id'), COALESCE((SELECT MAX(id) FROM payment_sessions), 1), (SELECT COUNT(*) > 0 FROM payment_sessions))")
  await client.query('COMMIT')

  const checks = [
    ['menu_items', menu.length],
    ['orders', orders.length],
    ['payment_sessions', sessions.length],
    ['webhook_events', events.length]
  ]
  for (const [table, expected] of checks) {
    const actual = Number((await target.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count)
    if (actual !== expected) throw new Error(`${table}: expected ${expected}, found ${actual}`)
    console.log(`${table}: ${actual} rows verified`)
  }
  console.log('SQLite to PostgreSQL migration completed. The SQLite database was not modified.')
} catch (error) {
  await client.query('ROLLBACK')
  throw error
} finally {
  client.release()
  await target.end()
  source.close()
}
