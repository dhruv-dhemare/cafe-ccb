import 'dotenv/config'
import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as sqliteDb from './db.js'
import * as postgresDb from './db-postgres.js'
import { MENU } from './menu-data.js'

const app = express()
app.set('trust proxy', 1)
const port = process.env.PORT || 3001
const adminPath = process.env.ADMIN_BASE_PATH || '/private-cafe-console'
const jwtSecret = process.env.ADMIN_SESSION_SECRET || 'development-only-change-me'
const razorpayBaseUrl = process.env.RAZORPAY_API_BASE_URL || 'https://api.razorpay.com/v1'
const razorpayConfigured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
const database = process.env.DATABASE_URL ? postgresDb : sqliteDb
const { clearOrdersAfterExport, confirmCashOrder, createCashOrder, createKhattaOrder, createKhattaUser, createPaymentSession, deleteMenu, finalizePaymentSession, findKhattaUserByPhone, findPaymentSessionByReference, findPaymentSessionByRazorpayOrderId, findReceipt, getKhattaStatement, getMenuByIds, getSetting, hasWebhookEvent, listKhattaUsers, listMenu, listOrders, markPaymentSessionFailed, newReference, purgeTransientData, recordWebhookEvent, seedMenu, setSetting, settleKhattaUser, syncFoodMenu, upsertMenu } = database
await seedMenu(MENU)
await syncFoodMenu(MENU.filter(item => item.category !== 'Cigarettes'), 'photo-menu-2026-09-28')

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || true, credentials: true }))
// Webhooks must receive the untouched bytes. This route intentionally comes before express.json().
app.post('/api/payment/webhook', express.raw({ type: 'application/json', limit: '256kb' }), async (req,res) => {
  try {
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) return res.status(503).json({ error:'Webhook secret is not configured' })
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('')
    const received = req.get('X-Razorpay-Signature') || ''
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex')
    if (!safeEqual(received, expected)) return res.status(400).json({ error:'Invalid webhook signature' })
    const eventId = req.get('x-razorpay-event-id')
    if (!eventId) return res.status(400).json({ error:'Missing webhook event id' })
    if (await hasWebhookEvent(eventId)) return res.json({ received:true, duplicate:true })
    const payload = JSON.parse(rawBody.toString('utf8'))
    const event = payload.event
    const payment = payload.payload?.payment?.entity
    const orderEntity = payload.payload?.order?.entity
    const paymentEntity = payment || {}
    const orderId = paymentEntity.order_id || orderEntity?.id
    if (event === 'payment.failed') {
      if (orderId) await markPaymentSessionFailed(orderId)
    } else if (event === 'payment.captured' || event === 'order.paid') {
      const session = orderId ? await findPaymentSessionByRazorpayOrderId(orderId) : null
      if (session && paymentEntity.id && paymentEntity.status === 'captured' && paymentEntity.amount === session.total * 100 && paymentEntity.currency === session.currency) {
        const order = await finalizePaymentSession(session, { id:paymentEntity.id })
        sendOrderConfirmation(order)
        broadcastOrderEvent(order)
      }
    }
    await recordWebhookEvent(eventId, event || 'unknown')
    return res.json({ received:true })
  } catch (error) {
    console.error('[razorpay-webhook]', error.message)
    return res.status(500).json({ error:'Webhook processing failed' })
  }
})
app.use(express.json({ limit: '100kb' }))
app.use(cookieParser())

const adminLimiter = rateLimit({ windowMs:15 * 60 * 1000, limit:30, standardHeaders:true, legacyHeaders:false })
// Keep normal customers fast while limiting accidental refresh storms and automated bursts.
const publicMenuLimiter = rateLimit({ windowMs:15 * 60 * 1000, limit:240, standardHeaders:true, legacyHeaders:false })
const publicOrderLimiter = rateLimit({ windowMs:15 * 60 * 1000, limit:120, standardHeaders:true, legacyHeaders:false })
const publicStatusLimiter = rateLimit({ windowMs:15 * 60 * 1000, limit:300, standardHeaders:true, legacyHeaders:false })
app.use('/api/menu', publicMenuLimiter)
app.use('/api/payment/options', publicOrderLimiter)
app.use('/api/payment/create-order', publicOrderLimiter)
app.use('/api/payment/verify', publicOrderLimiter)
app.use('/api/payment/status', publicStatusLimiter)
app.disable('x-powered-by')
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  next()
})
const adminCookieOptions = { httpOnly:true, sameSite:process.env.NODE_ENV==='production' ? 'none' : 'strict', secure:process.env.NODE_ENV==='production', maxAge:20*60*60*1000, path:adminPath }
const adminOrderStreams = new Set()
const exportDir = path.join(process.cwd(), 'exports')
const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`
const ordersCsv = orders => [['Order','Date','Mobile','Table','Items','Total','Payment'], ...orders.map(order => [order.order_number, order.createdAt, order.phone, order.table_number || '', order.items.map(item => `${item.quantity} x ${item.itemName}`).join('; '), order.total, order.payment_status])].map(row => row.map(csvCell).join(',')).join('\n')
const writeOrderExport = async () => { const allOrders = await listOrders(); const today = localDay(new Date()); const orders = allOrders.filter(order => localDay(order.createdAt) < today); const previousFile = await getSetting('last-order-export', null); const stamp = new Date().toISOString().replaceAll(':','-').replaceAll('.','-'); await fs.mkdir(exportDir, { recursive:true }); const fileName = `orders-${stamp}.csv`; await fs.writeFile(path.join(exportDir, fileName), ordersCsv(orders), 'utf8'); if (previousFile && previousFile !== fileName) { try { await fs.unlink(path.join(exportDir, path.basename(previousFile))) } catch { /* The pending file may already have been removed. */ } } await setSetting('last-order-export', fileName); await setSetting('last-order-export-ids', JSON.stringify(orders.map(order => order.id))); await setSetting('last-order-export-at', new Date().toISOString()); return { fileName, orders } }
let exportTimer = null
const exportTimeZone = process.env.APP_TIMEZONE || 'Asia/Kolkata'
const localParts = value => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone:exportTimeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
const localDay = value => { const parts = localParts(value); return `${parts.year}-${parts.month}-${parts.day}` }
const scheduleOrderExport = async (skipMissedCatchUp = false) => { if (exportTimer) clearTimeout(exportTimer); const enabled = (await getSetting('order-export-enabled', 'true')) === 'true'; const [hours, minutes] = (await getSetting('order-export-time', '23:59')).split(':').map(Number); const now = new Date(); const current = localParts(now); const targetMinutes = hours * 60 + minutes; const currentMinutes = current.hour * 60 + current.minute; const lastExportAt = await getSetting('last-order-export-at', null); if (enabled && !skipMissedCatchUp && currentMinutes >= targetMinutes && (!lastExportAt || localDay(lastExportAt) !== localDay(now))) { try { await writeOrderExport() } catch (error) { console.error('[order-export]', error.message); return scheduleOrderExport(true) } } const localToday = Date.UTC(current.year, current.month - 1, current.day, hours, minutes); const localNow = Date.UTC(current.year, current.month - 1, current.day, current.hour, current.minute, current.second) + now.getMilliseconds(); let delay = localToday - localNow; if (delay <= 0) delay += 24 * 60 * 60 * 1000; exportTimer = setTimeout(async () => { let failed = false; try { if (enabled) await writeOrderExport(); await purgeTransientData() } catch (error) { failed = true; console.error('[daily-maintenance]', error.message) } finally { scheduleOrderExport(failed).catch(error => console.error('[daily-maintenance-schedule]', error.message)) } }, Math.max(1000, delay)) }
scheduleOrderExport().catch(error => console.error('[order-export-schedule]', error.message))
const MENU_CACHE_TTL = 2 * 60 * 1000
let menuCache = { items:null, etag:null, expiresAt:0 }
const getCachedMenu = async () => {
  if (menuCache.items && menuCache.expiresAt > Date.now()) return menuCache
  const items = await listMenu()
  const etag = `"${crypto.createHash('sha256').update(JSON.stringify(items)).digest('hex')}"`
  menuCache = { items, etag, expiresAt:Date.now() + MENU_CACHE_TTL }
  return menuCache
}
const invalidateMenuCache = () => { menuCache = { items:null, etag:null, expiresAt:0 } }
const sendMenuResponse = async (req, res, cacheControl) => {
  const cached = await getCachedMenu()
  res.set('Cache-Control', cacheControl)
  res.set('ETag', cached.etag)
  if (req.get('If-None-Match') === cached.etag) return res.status(304).end()
  return res.json(cached.items)
}
const auth = (req,res,next) => { try { jwt.verify(req.cookies.ccb_admin, jwtSecret); next() } catch { res.status(401).json({ error:'Admin authentication required' }) } }
const adminPasswordHash = () => process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'change-me', 10)
const verifyAdminPassword = password => bcrypt.compare(password || '', adminPasswordHash())
const broadcastOrderEvent = (order) => {
  const message = `event: order-created\ndata: ${JSON.stringify({ orderNumber:order.order_number, reference:order.reference })}\n\n`
  for (const stream of adminOrderStreams) {
    try { stream.res.write(message) } catch { clearInterval(stream.heartbeat); adminOrderStreams.delete(stream) }
  }
}
const safeEqual = (a,b) => { const left=Buffer.from(String(a)); const right=Buffer.from(String(b)); return left.length === right.length && crypto.timingSafeEqual(left,right) }
const normalizePhone = phone => String(phone || '').replace(/\D/g,'')
const validateCart = async (phone, items, tableNumber) => {
  const normalizedPhone = normalizePhone(phone)
  if (!/^\d{10}$/.test(normalizedPhone) || !Array.isArray(items) || !items.length) throw Object.assign(new Error('Valid mobile number and cart are required.'), { status:400 })
  const requested = new Map(items.map(item => [item.id, Number(item.quantity)]))
  if (requested.size !== items.length || [...requested.keys()].some(id => typeof id !== 'string' || !id) || [...requested.values()].some(quantity => !Number.isInteger(quantity) || quantity < 1 || quantity > 20)) throw Object.assign(new Error('Invalid cart quantity.'), { status:400 })
  const menu = await getMenuByIds([...requested.keys()])
  if (menu.length !== requested.size) throw Object.assign(new Error('One or more menu items are unavailable.'), { status:400 })
  if (menu.some(item => !item.available)) throw Object.assign(new Error('One or more selected items are sold out.'), { status:409 })
  const orderItems = menu.map(item => ({ menuItemId:item.id, itemName:item.name, unitPrice:item.price, quantity:requested.get(item.id), subtotal:item.price * requested.get(item.id) }))
  const hasCigarettes = menu.some(item => item.category === 'Cigarettes')
  const hasFood = menu.some(item => item.category !== 'Cigarettes')
  const normalizedTable = String(tableNumber || '').trim().replace(/\s+/g, ' ')
  if (hasFood && !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,19}$/.test(normalizedTable)) throw Object.assign(new Error('A valid table number is required for food orders.'), { status:400 })
  return { phone:normalizedPhone, items:orderItems, total:orderItems.reduce((sum,item) => sum + item.subtotal, 0), hasCigarettes, hasFood, tableNumber:hasFood ? normalizedTable : null }
}
const razorpayRequest = async (path, options = {}) => {
  if (!razorpayConfigured()) throw Object.assign(new Error('Razorpay is not configured.'), { status:503 })
  const authHeader = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')
  const response = await fetch(`${razorpayBaseUrl}${path}`, { ...options, headers:{ Authorization:`Basic ${authHeader}`, 'Content-Type':'application/json', ...(options.headers || {}) } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) { const error = new Error(data.error?.description || 'Razorpay request failed'); error.status = response.status >= 400 && response.status < 500 ? 400 : 502; throw error }
  return data
}
const sendOrderConfirmation = (order) => { if (!order) return; const message = `Cafe Coffee Bar 3.0 order ${order.order_number} confirmed. Amount paid ₹${order.total}. Receipt reference: ${order.reference}`; if (process.env.SMS_PROVIDER === 'mock' || !process.env.SMS_PROVIDER) console.log(`[mock-sms] ${message}`); else console.log('[sms] Provider adapter pending configuration') }

app.get('/api/health', (req,res) => res.json({ ok:true, service:'ccb-api', razorpayConfigured:razorpayConfigured() }))
app.get('/api/menu', async (req,res) => sendMenuResponse(req, res, 'public, max-age=120, stale-while-revalidate=60'))
app.post('/api/payment/options', async (req,res) => {
  try {
    const cart = await validateCart(req.body.phone, req.body.items, req.body.tableNumber)
    const khattaUser = !cart.hasCigarettes ? await findKhattaUserByPhone(cart.phone) : null
    res.json({ khattaEligible:Boolean(khattaUser), total:cart.total, tableNumber:cart.tableNumber })
  } catch (error) { res.status(error.status || 502).json({ error:error.message || 'Unable to load payment options' }) }
})
app.post('/api/payment/create-order', async (req,res) => {
  try {
    const cart = await validateCart(req.body.phone, req.body.items, req.body.tableNumber)
    const { phone, items, total, hasCigarettes, tableNumber } = cart
    const paymentMethod = String(req.body.paymentMethod || '').toUpperCase()
    if (!['KHATTA','CASH','ONLINE'].includes(paymentMethod)) return res.status(400).json({ error:'Choose a payment method to continue.' })
    const reference = newReference()
    const khattaUser = hasCigarettes ? null : await findKhattaUserByPhone(phone)
    if (paymentMethod === 'KHATTA') {
      if (!khattaUser || hasCigarettes) return res.status(400).json({ error:'Khatta is available only for registered food customers.' })
      const order = await createKhattaOrder({ khattaUserId:khattaUser.id, reference, phone, tableNumber, itemsJson:JSON.stringify(items), subtotal:total, total })
      broadcastOrderEvent(order)
      return res.status(201).json({ paymentMethod:'KHATTA', orderNumber:order.order_number, reference:order.reference, phone:order.phone, tableNumber:order.table_number, total:order.total, paymentStatus:order.payment_status })
    }
    if (paymentMethod === 'CASH') {
      const order = await createCashOrder({ reference, phone, tableNumber, itemsJson:JSON.stringify(items), subtotal:total, total })
      broadcastOrderEvent(order)
      return res.status(201).json({ paymentMethod:'CASH', orderNumber:order.order_number, reference:order.reference, phone:order.phone, tableNumber:order.table_number, total:order.total, paymentStatus:order.payment_status })
    }
    const razorpayOrder = await razorpayRequest('/orders', { method:'POST', body:JSON.stringify({ amount:total * 100, currency:'INR', receipt:`ccb_${reference}`, notes:{ reference, phone } }) })
    await createPaymentSession({ reference, phone, tableNumber, itemsJson:JSON.stringify(items), subtotal:total, total, currency:'INR', status:'PENDING', razorpayOrderId:razorpayOrder.id })
    res.status(201).json({ reference, keyId:process.env.RAZORPAY_KEY_ID, razorpayOrderId:razorpayOrder.id, amount:total * 100, currency:'INR' })
  } catch (error) { res.status(error.status || 502).json({ error:error.message || 'Unable to create payment order' }) }
})
app.post('/api/payment/verify', async (req,res) => {
  try {
    const { reference, razorpay_payment_id:paymentId, razorpay_order_id:clientOrderId, razorpay_signature:signature } = req.body
    if (!reference || !paymentId || !clientOrderId || !signature) return res.status(400).json({ error:'Incomplete payment verification payload' })
    const session = await findPaymentSessionByReference(reference)
    if (!session || session.razorpay_order_id !== clientOrderId) return res.status(400).json({ error:'Payment order mismatch' })
    const generated = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '').update(`${session.razorpay_order_id}|${paymentId}`).digest('hex')
    if (!safeEqual(generated, signature)) return res.status(400).json({ error:'Payment signature verification failed' })
    const payment = await razorpayRequest(`/payments/${encodeURIComponent(paymentId)}`)
    if (payment.order_id !== session.razorpay_order_id || payment.amount !== session.total * 100 || payment.currency !== session.currency) return res.status(400).json({ error:'Payment amount or order validation failed' })
    if (payment.status !== 'captured' || payment.captured !== true) return res.status(202).json({ status:'PENDING_CAPTURE', reference, error:'Payment is still being captured. We are confirming it securely.' })
    const order = await finalizePaymentSession(session, { id:payment.id })
    sendOrderConfirmation(order)
    broadcastOrderEvent(order)
    res.json({ orderNumber:order.order_number, reference:order.reference, phone:order.phone, tableNumber:order.table_number, total:order.total, paymentStatus:order.payment_status })
  } catch (error) { res.status(error.status || 502).json({ error:error.message || 'Payment verification failed' }) }
})
app.get('/api/payment/status/:reference', async (req,res) => { const session=await findPaymentSessionByReference(req.params.reference); if(!session)return res.status(404).json({error:'Payment session not found'}); if(session.status==='PAID'){const order=await findReceipt(session.reference);return res.json({status:'PAID',orderNumber:order.order_number,reference:order.reference,phone:order.phone,tableNumber:order.table_number,total:order.total,paymentStatus:order.payment_status})} if(session.status==='FAILED')return res.json({status:'FAILED'}); res.json({status:'PENDING'}) })

app.get('/api/receipts/:reference', async (req,res) => { const order=await findReceipt(req.params.reference); const paymentLabel=order?.payment_status === 'KHATTA' ? 'Order account' : order?.payment_status === 'CASH' ? 'Cash' : `Razorpay · ${order?.payment_status}`; if(!order)return res.status(404).send('Receipt not found'); res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${order.order_number} · Cafe Coffee Bar 3.0</title><style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#10264a;font:14px Arial,sans-serif}.receipt{width:min(680px,calc(100% - 32px));margin:36px auto;padding:42px;background:#fff;border:1px solid #d9dce3;border-top:6px solid #c6933d;box-shadow:0 10px 30px rgba(16,38,74,.1)}.receipt-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding-bottom:26px;border-bottom:1px solid #d9dce3}.eyebrow{margin:0 0 10px;color:#c6933d;font-size:11px;letter-spacing:.16em;text-transform:uppercase}.brand{margin:0;color:#10264a;font:600 28px Georgia,serif}.brand span{color:#c6933d}.address,.meta{margin:7px 0 0;color:#71809b;font-size:12px;line-height:1.5}.order-meta{text-align:right}.items{width:100%;margin:28px 0;border-collapse:collapse}.items th{padding:0 0 11px;color:#71809b;font-size:10px;text-align:left;text-transform:uppercase;letter-spacing:.1em}.items th:nth-child(2),.items th:last-child,.items td:nth-child(2),.items td:last-child{text-align:right}.items td{padding:14px 0;border-top:1px solid #eceef2;font-size:14px}.items td:last-child{font-weight:600}.total{display:flex;justify-content:space-between;padding:20px 0;border-block:1px solid #d9dce3;font-size:15px}.total strong{color:#c6933d;font:600 25px Georgia,serif}.details{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;margin-top:25px;color:#455776;font-size:12px}.details b{display:block;margin-top:4px;color:#10264a;font-weight:600}.thanks{margin:32px 0 0;text-align:center;color:#71809b;font-size:12px}@media(max-width:520px){.receipt{margin:0;width:100%;min-height:100vh;border:0;border-top:5px solid #c6933d;box-shadow:none;padding:28px 20px}.receipt-head{display:block}.order-meta{text-align:left;margin-top:18px}.brand{font-size:24px}.details{grid-template-columns:1fr}}@media print{body{background:#fff}.receipt{width:100%;margin:0;border:0;box-shadow:none}}</style></head><body><main class="receipt"><header class="receipt-head"><div><p class="eyebrow">Payment receipt</p><h1 class="brand">CAFE COFFEE BAR <span>3.0</span></h1><p class="address">Katraj, Pune</p></div><div class="order-meta"><p class="meta">Order number</p><strong>${order.order_number}</strong><p class="meta">${new Date(order.createdAt).toLocaleString('en-IN')}</p></div></header><table class="items"><thead><tr><th>Item</th><th>Qty</th><th>Total</th></tr></thead><tbody>${order.items.map(i=>`<tr><td>${i.itemName}</td><td>${i.quantity}</td><td>₹${i.subtotal}</td></tr>`).join('')}</tbody></table><div class="total"><span>Total paid</span><strong>₹${order.total}</strong></div><div class="details"><div>Payment method<b>${paymentLabel}</b></div><div>Mobile number<b>+91 ${order.phone}</b></div>${order.table_number ? `<div>Table number<b>${order.table_number}</b></div>` : ''}</div><p class="thanks">Thank you for visiting Cafe Coffee Bar 3.0.</p></main></body></html>`) })
app.post(`${adminPath}/api/login`, adminLimiter, async (req,res) => { const { username, password } = req.body; const expectedUser=process.env.ADMIN_USERNAME || 'admin'; if(username !== expectedUser || !(await verifyAdminPassword(password))) return res.status(401).json({ error:'Invalid admin credentials' }); res.cookie('ccb_admin', jwt.sign({ sub:username },jwtSecret,{ expiresIn:'20h' }),adminCookieOptions); res.json({ ok:true }) })
app.post(`${adminPath}/api/logout`, auth, (req,res) => { res.clearCookie('ccb_admin', { path:adminPath }); res.json({ ok:true }) })
app.get(`${adminPath}/api/orders`, auth, async (req,res) => res.json(await listOrders()))
app.get(`${adminPath}/api/orders/export`, auth, async (req,res) => { const result = await writeOrderExport(); const fileName = result.fileName; const orderIds = result.orders.map(order => order.id); const cleanup = async () => { try { await clearOrdersAfterExport(orderIds); await fs.unlink(path.join(exportDir, path.basename(fileName))); await setSetting('last-order-export', ''); await setSetting('last-order-export-ids', '[]'); await setSetting('last-order-export-at', new Date().toISOString()) } catch (error) { console.error('[order-export-cleanup]', error.message) } }; res.once('finish', cleanup); res.type('text/csv').set('Content-Disposition', `attachment; filename="${path.basename(fileName)}"`).send(ordersCsv(result.orders)) })
app.get(`${adminPath}/api/orders/stream`, auth, (req,res) => {
  res.status(200).set({ 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache, no-transform', Connection:'keep-alive' })
  res.flushHeaders()
  res.write('retry: 5000\n\n')
  const stream = { res, heartbeat:setInterval(() => res.write(': keep-alive\n\n'), 30000) }
  adminOrderStreams.add(stream)
  req.on('close', () => { clearInterval(stream.heartbeat); adminOrderStreams.delete(stream) })
})
app.post(`${adminPath}/api/orders/:id/confirm-cash`, auth, async (req,res) => {
  const order = await confirmCashOrder(req.params.id)
  if (!order) return res.status(404).json({ error:'Pending cash order not found' })
  broadcastOrderEvent(order)
  res.json({ ok:true, orderNumber:order.order_number, paymentStatus:order.payment_status })
})
app.post(`${adminPath}/api/cash-orders`, auth, async (req,res) => {
  try {
    const { phone, items, total, tableNumber } = await validateCart(req.body.phone, req.body.items, req.body.tableNumber)
    const order = await createCashOrder({ reference:newReference(), phone, tableNumber, itemsJson:JSON.stringify(items), subtotal:total, total })
    broadcastOrderEvent(order)
    res.status(201).json({ orderNumber:order.order_number, reference:order.reference, phone:order.phone, tableNumber:order.table_number, total:order.total, paymentStatus:order.payment_status })
  } catch (error) { res.status(error.status || 502).json({ error:error.message || 'Unable to create cash order' }) }
})
app.get(`${adminPath}/api/khatta/users`, auth, async (req,res) => res.json(await listKhattaUsers()))
app.post(`${adminPath}/api/khatta/users`, auth, async (req,res) => {
  const phone = normalizePhone(req.body.phone)
  const name = String(req.body.name || '').trim()
  if (!name || !/^\d{10}$/.test(phone)) return res.status(400).json({ error:'Name and a valid 10-digit mobile number are required' })
  try { return res.status(201).json(await createKhattaUser({ name, phone })) } catch (error) { if (error.code === '23505' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error:'A Khatta customer with this mobile number already exists' }); throw error }
})
app.get(`${adminPath}/api/khatta/users/:id/statement`, auth, async (req,res) => {
  try { const statement = await getKhattaStatement(req.params.id); if (!statement) return res.status(404).json({ error:'Khatta customer not found' }); res.json(statement) } catch (error) { console.error('[khatta-statement]', error.message); res.status(500).json({ error:'Unable to load Khatta statement' }) }
})
app.post(`${adminPath}/api/khatta/users/:id/settle`, auth, async (req,res) => {
  if (!(await verifyAdminPassword(req.body.password))) return res.status(401).json({ error:'Password confirmation failed' })
  let statement
  try { statement = await settleKhattaUser(req.params.id, req.body.amount, req.body.note) } catch (error) { return res.status(error.status || 400).json({ error:error.message }) }
  if (!statement) return res.status(404).json({ error:'Khatta customer not found' })
  res.json({ ok:true, settledAmount:statement.settledAmount, remaining:statement.total })
})
app.get(`${adminPath}/api/settings/order-export`, auth, async (req,res) => res.json({ enabled:(await getSetting('order-export-enabled','true')) === 'true', time:await getSetting('order-export-time','23:59'), lastExportAt:await getSetting('last-order-export-at', null) }))
app.post(`${adminPath}/api/settings/order-export`, auth, async (req,res) => { const time=String(req.body.time || ''); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ error:'Enter a valid time in 24-hour HH:MM format' }); await setSetting('order-export-enabled', req.body.enabled === false ? 'false' : 'true'); await setSetting('order-export-time', time); await scheduleOrderExport(); res.json({ ok:true, enabled:req.body.enabled !== false, time }) })
app.get(`${adminPath}/api/menu`, auth, async (req,res) => sendMenuResponse(req, res, 'private, no-cache'))
app.post(`${adminPath}/api/menu`, auth, async (req,res) => { const { id,name,category,description='',price,available=true }=req.body; const type=String(req.body.type || 'FOOD').toUpperCase(); const normalizedCategory=type === 'CIGARETTES' ? 'Cigarettes' : String(category || '').trim(); if(!id||!name||!['FOOD','CIGARETTES'].includes(type)||!normalizedCategory||!Number.isInteger(Number(price))||Number(price)<0)return res.status(400).json({error:'id, name, type, category and a valid price are required'}); const item=await upsertMenu({id,name,category:normalizedCategory,description,price:Number(price),available}); invalidateMenuCache(); res.status(201).json(item) })
app.delete(`${adminPath}/api/menu/:id`, auth, async (req,res) => { const deleted=await deleteMenu(req.params.id); invalidateMenuCache(); res.json({ deleted }) })

app.listen(port, () => console.log(`CCB Express API listening on http://localhost:${port}`))
