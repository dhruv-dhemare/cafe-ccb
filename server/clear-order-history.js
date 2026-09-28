import 'dotenv/config'
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg
const root = path.dirname(fileURLToPath(import.meta.url))
const sqlitePath = process.env.DATABASE_PATH || path.join(root, 'ccb.sqlite')
const useSqlite = process.argv.includes('--sqlite') || !process.env.DATABASE_URL

if (useSqlite) {
  const db = new Database(sqlitePath)
  try {
    const counts = {
      orders: db.prepare('SELECT COUNT(*) AS count FROM orders WHERE id NOT IN (SELECT order_id FROM khatta_entries)').get().count,
      khattaOrdersPreserved: db.prepare('SELECT COUNT(*) AS count FROM orders WHERE id IN (SELECT order_id FROM khatta_entries)').get().count,
      payment_sessions: db.prepare('SELECT COUNT(*) AS count FROM payment_sessions').get().count,
      webhook_events: db.prepare('SELECT COUNT(*) AS count FROM webhook_events').get().count,
    }
    db.transaction(() => {
      db.prepare('DELETE FROM payment_sessions').run()
      db.prepare('DELETE FROM orders WHERE id NOT IN (SELECT order_id FROM khatta_entries)').run()
      db.prepare('DELETE FROM webhook_events').run()
    })()
    console.log(JSON.stringify({ database:'sqlite', cleared:counts }))
  } finally {
    db.close()
  }
} else {
  const pool = new Pool({ connectionString:process.env.DATABASE_URL, max:1, ssl:{ rejectUnauthorized:false } })
  const client = await pool.connect()
  try {
    const counts = {}
    counts.orders = Number((await client.query('SELECT COUNT(*)::int AS count FROM orders WHERE id NOT IN (SELECT order_id FROM khatta_entries)')).rows[0].count)
    counts.khattaOrdersPreserved = Number((await client.query('SELECT COUNT(*)::int AS count FROM orders WHERE id IN (SELECT order_id FROM khatta_entries)')).rows[0].count)
    counts.payment_sessions = Number((await client.query('SELECT COUNT(*)::int AS count FROM payment_sessions')).rows[0].count)
    counts.webhook_events = Number((await client.query('SELECT COUNT(*)::int AS count FROM webhook_events')).rows[0].count)
    await client.query('BEGIN')
    try {
      await client.query('DELETE FROM payment_sessions')
      await client.query('DELETE FROM orders WHERE id NOT IN (SELECT order_id FROM khatta_entries)')
      await client.query('DELETE FROM webhook_events')
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    console.log(JSON.stringify({ database:'postgres', cleared:counts }))
  } finally {
    client.release()
    await pool.end()
  }
}
