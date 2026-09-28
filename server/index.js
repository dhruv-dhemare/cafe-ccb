import 'dotenv/config'
import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
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
const { confirmCashOrder, createCashOrder, createKhattaOrder, createKhattaUser, createPaymentSession, deleteMenu, finalizePaymentSession, findKhattaUserByPhone, findPaymentSessionByReference, findPaymentSessionByRazorpayOrderId, findReceipt, getKhattaStatement, getMenuByIds, hasWebhookEvent, listKhattaUsers, listMenu, listOrders, markPaymentSessionFailed, newReference, recordWebhookEvent, seedMenu, settleKhattaUser, syncFoodMenu, upsertMenu } = database
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
const adminCookieOptions = { httpOnly:true, sameSite:process.env.NODE_ENV==='production' ? 'none' : 'strict', secure:process.env.NODE_ENV==='production', maxAge:20*60*60*1000, path:adminPath }
const adminOrderStreams = new Set()
const khattaSettlementTokens = new Map()
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
app.get('/api/menu', async (req,res) => res.json(await listMenu()))
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
  const statement = await getKhattaStatement(req.params.id)
  if (!statement) return res.status(404).json({ error:'Khatta customer not found' })
  const settlementToken = crypto.randomBytes(24).toString('hex')
  khattaSettlementTokens.set(settlementToken, { userId:String(req.params.id), entryIds:statement.entries.map(entry => String(entry.id)), expiresAt:Date.now() + 10 * 60 * 1000 })
  res.json({ ...statement, settlementToken })
})
app.post(`${adminPath}/api/khatta/users/:id/settle`, auth, async (req,res) => {
  const token = khattaSettlementTokens.get(req.body.settlementToken)
  if (!token || token.userId !== String(req.params.id) || token.expiresAt < Date.now() || req.body.downloadConfirmed !== true) return res.status(400).json({ error:'Download and confirm the Khatta statement before clearing it' })
  if (!(await verifyAdminPassword(req.body.password))) return res.status(401).json({ error:'Password confirmation failed' })
  const statement = await settleKhattaUser(req.params.id, token.entryIds)
  if (!statement) return res.status(404).json({ error:'Khatta customer not found' })
  if (!statement.entries.length) return res.status(409).json({ error:'This Khatta statement has already been settled' })
  khattaSettlementTokens.delete(req.body.settlementToken)
  res.json({ ok:true, total:statement.total, entries:statement.entries.length })
})
app.get(`${adminPath}/api/menu`, auth, async (req,res) => res.json(await listMenu()))
app.post(`${adminPath}/api/menu`, auth, async (req,res) => { const { id,name,category,description='',price,available=true }=req.body; if(!id||!name||!category||!Number.isInteger(Number(price))||Number(price)<0)return res.status(400).json({error:'id, name, category and a valid price are required'}); res.status(201).json(await upsertMenu({id,name,category,description,price:Number(price),available})) })
app.delete(`${adminPath}/api/menu/:id`, auth, async (req,res) => res.json({ deleted:await deleteMenu(req.params.id) }))

app.listen(port, () => console.log(`CCB Express API listening on http://localhost:${port}`))
