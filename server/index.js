import 'dotenv/config'
import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import { createOrder, createPaymentSession, deleteMenu, finalizePaymentSession, findPaymentSessionByReference, findPaymentSessionByRazorpayOrderId, findReceipt, getMenuByIds, hasWebhookEvent, listMenu, listOrders, markPaymentSessionFailed, newReference, nextOrderNumber, recordWebhookEvent, seedMenu, updateOrderStatus, upsertMenu } from './db.js'
import { MENU } from './menu-data.js'

const app = express()
const port = process.env.PORT || 3001
const adminPath = process.env.ADMIN_BASE_PATH || '/private-cafe-console'
const jwtSecret = process.env.ADMIN_SESSION_SECRET || 'development-only-change-me'
const razorpayBaseUrl = process.env.RAZORPAY_API_BASE_URL || 'https://api.razorpay.com/v1'
const razorpayConfigured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
seedMenu(MENU)

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
    if (hasWebhookEvent(eventId)) return res.json({ received:true, duplicate:true })
    const payload = JSON.parse(rawBody.toString('utf8'))
    const event = payload.event
    const payment = payload.payload?.payment?.entity
    const orderEntity = payload.payload?.order?.entity
    const paymentEntity = payment || {}
    const orderId = paymentEntity.order_id || orderEntity?.id
    if (event === 'payment.failed') {
      if (orderId) markPaymentSessionFailed(orderId)
    } else if (event === 'payment.captured' || event === 'order.paid') {
      const session = orderId ? findPaymentSessionByRazorpayOrderId(orderId) : null
      if (session && paymentEntity.id && paymentEntity.status === 'captured' && paymentEntity.amount === session.total * 100 && paymentEntity.currency === session.currency) {
        const order = finalizePaymentSession(session, { id:paymentEntity.id })
        sendOrderConfirmation(order)
      }
    }
    recordWebhookEvent(eventId, event || 'unknown')
    return res.json({ received:true })
  } catch (error) {
    console.error('[razorpay-webhook]', error.message)
    return res.status(500).json({ error:'Webhook processing failed' })
  }
})
app.use(express.json({ limit: '100kb' }))
app.use(cookieParser())

const adminLimiter = rateLimit({ windowMs:15 * 60 * 1000, limit:30, standardHeaders:true, legacyHeaders:false })
const auth = (req,res,next) => { try { jwt.verify(req.cookies.ccb_admin, jwtSecret); next() } catch { res.status(401).json({ error:'Admin authentication required' }) } }
const safeEqual = (a,b) => { const left=Buffer.from(String(a)); const right=Buffer.from(String(b)); return left.length === right.length && crypto.timingSafeEqual(left,right) }
const normalizePhone = phone => String(phone || '').replace(/\D/g,'')
const validateCart = (phone, items) => {
  const normalizedPhone = normalizePhone(phone)
  if (!/^\d{10}$/.test(normalizedPhone) || !Array.isArray(items) || !items.length) throw Object.assign(new Error('Valid mobile number and cart are required.'), { status:400 })
  const requested = new Map(items.map(item => [item.id, Number(item.quantity)]))
  if (requested.size !== items.length || [...requested.keys()].some(id => typeof id !== 'string' || !id) || [...requested.values()].some(quantity => !Number.isInteger(quantity) || quantity < 1 || quantity > 20)) throw Object.assign(new Error('Invalid cart quantity.'), { status:400 })
  const menu = getMenuByIds([...requested.keys()])
  if (menu.length !== requested.size) throw Object.assign(new Error('One or more menu items are unavailable.'), { status:400 })
  if (menu.some(item => !item.available)) throw Object.assign(new Error('One or more selected items are sold out.'), { status:409 })
  const orderItems = menu.map(item => ({ menuItemId:item.id, itemName:item.name, unitPrice:item.price, quantity:requested.get(item.id), subtotal:item.price * requested.get(item.id) }))
  return { phone:normalizedPhone, items:orderItems, total:orderItems.reduce((sum,item) => sum + item.subtotal, 0) }
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
app.get('/api/menu', (req,res) => res.json(listMenu()))
app.post('/api/payment/create-order', async (req,res) => {
  try {
    const { phone, items, total } = validateCart(req.body.phone, req.body.items)
    const reference = newReference()
    const razorpayOrder = await razorpayRequest('/orders', { method:'POST', body:JSON.stringify({ amount:total * 100, currency:'INR', receipt:`ccb_${reference}`, notes:{ reference, phone } }) })
    createPaymentSession({ reference, phone, itemsJson:JSON.stringify(items), subtotal:total, total, currency:'INR', status:'PENDING', razorpayOrderId:razorpayOrder.id })
    res.status(201).json({ reference, keyId:process.env.RAZORPAY_KEY_ID, razorpayOrderId:razorpayOrder.id, amount:total * 100, currency:'INR' })
  } catch (error) { res.status(error.status || 502).json({ error:error.message || 'Unable to create payment order' }) }
})
app.post('/api/payment/verify', async (req,res) => {
  try {
    const { reference, razorpay_payment_id:paymentId, razorpay_order_id:clientOrderId, razorpay_signature:signature } = req.body
    if (!reference || !paymentId || !clientOrderId || !signature) return res.status(400).json({ error:'Incomplete payment verification payload' })
    const session = findPaymentSessionByReference(reference)
    if (!session || session.razorpay_order_id !== clientOrderId) return res.status(400).json({ error:'Payment order mismatch' })
    const generated = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '').update(`${session.razorpay_order_id}|${paymentId}`).digest('hex')
    if (!safeEqual(generated, signature)) return res.status(400).json({ error:'Payment signature verification failed' })
    const payment = await razorpayRequest(`/payments/${encodeURIComponent(paymentId)}`)
    if (payment.order_id !== session.razorpay_order_id || payment.amount !== session.total * 100 || payment.currency !== session.currency) return res.status(400).json({ error:'Payment amount or order validation failed' })
    if (payment.status !== 'captured' || payment.captured !== true) return res.status(202).json({ status:'PENDING_CAPTURE', reference, error:'Payment is still being captured. We are confirming it securely.' })
    const order = finalizePaymentSession(session, { id:payment.id })
    sendOrderConfirmation(order)
    res.json({ orderNumber:order.order_number, reference:order.reference, phone:order.phone, total:order.total, paymentStatus:order.payment_status })
  } catch (error) { res.status(error.status || 502).json({ error:error.message || 'Payment verification failed' }) }
})
app.get('/api/payment/status/:reference', (req,res) => { const session=findPaymentSessionByReference(req.params.reference); if(!session)return res.status(404).json({error:'Payment session not found'}); if(session.status==='PAID'){const order=findReceipt(session.reference);return res.json({status:'PAID',orderNumber:order.order_number,reference:order.reference,phone:order.phone,total:order.total,paymentStatus:order.payment_status})} if(session.status==='FAILED')return res.json({status:'FAILED'}); res.json({status:'PENDING'}) })

// Development-only fallback. The real frontend never calls this route.
app.post('/api/orders/mock-checkout', (req,res) => {
  if (process.env.RAZORPAY_MODE !== 'mock') return res.status(410).json({ error:'Mock checkout is disabled' })
  try { const { phone, items, total } = validateCart(req.body.phone, req.body.items); const reference=newReference(); const order=createOrder({ orderNumber:nextOrderNumber(), reference, phone, itemsJson:JSON.stringify(items), items, subtotal:total, total, paymentStatus:'PAID', smsStatus:'MOCKED', razorpayOrderId:`mock_order_${reference.slice(0,10)}`, razorpayPaymentId:`mock_payment_${reference.slice(0,10)}` }); sendOrderConfirmation(order); res.status(201).json({ orderNumber:order.orderNumber, reference, phone:order.phone, total:order.total, paymentStatus:order.paymentStatus }) } catch (error) { res.status(error.status || 400).json({ error:error.message }) }
})
app.get('/api/receipts/:reference', (req,res) => { const order=findReceipt(req.params.reference); if(!order)return res.status(404).send('Receipt not found'); res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${order.order_number} · Cafe Coffee Bar 3.0</title><style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#10264a;font:14px Arial,sans-serif}.receipt{width:min(680px,calc(100% - 32px));margin:36px auto;padding:42px;background:#fff;border:1px solid #d9dce3;border-top:6px solid #c6933d;box-shadow:0 10px 30px rgba(16,38,74,.1)}.receipt-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding-bottom:26px;border-bottom:1px solid #d9dce3}.eyebrow{margin:0 0 10px;color:#c6933d;font-size:11px;letter-spacing:.16em;text-transform:uppercase}.brand{margin:0;color:#10264a;font:600 28px Georgia,serif}.brand span{color:#c6933d}.address,.meta{margin:7px 0 0;color:#71809b;font-size:12px;line-height:1.5}.order-meta{text-align:right}.items{width:100%;margin:28px 0;border-collapse:collapse}.items th{padding:0 0 11px;color:#71809b;font-size:10px;text-align:left;text-transform:uppercase;letter-spacing:.1em}.items th:nth-child(2),.items th:last-child,.items td:nth-child(2),.items td:last-child{text-align:right}.items td{padding:14px 0;border-top:1px solid #eceef2;font-size:14px}.items td:last-child{font-weight:600}.total{display:flex;justify-content:space-between;padding:20px 0;border-block:1px solid #d9dce3;font-size:15px}.total strong{color:#c6933d;font:600 25px Georgia,serif}.details{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;margin-top:25px;color:#455776;font-size:12px}.details b{display:block;margin-top:4px;color:#10264a;font-weight:600}.thanks{margin:32px 0 0;text-align:center;color:#71809b;font-size:12px}@media(max-width:520px){.receipt{margin:0;width:100%;min-height:100vh;border:0;border-top:5px solid #c6933d;box-shadow:none;padding:28px 20px}.receipt-head{display:block}.order-meta{text-align:left;margin-top:18px}.brand{font-size:24px}.details{grid-template-columns:1fr}}@media print{body{background:#fff}.receipt{width:100%;margin:0;border:0;box-shadow:none}}</style></head><body><main class="receipt"><header class="receipt-head"><div><p class="eyebrow">Payment receipt</p><h1 class="brand">CAFE COFFEE BAR <span>3.0</span></h1><p class="address">Katraj, Pune</p></div><div class="order-meta"><p class="meta">Order number</p><strong>${order.order_number}</strong><p class="meta">${new Date(order.createdAt).toLocaleString('en-IN')}</p></div></header><table class="items"><thead><tr><th>Item</th><th>Qty</th><th>Total</th></tr></thead><tbody>${order.items.map(i=>`<tr><td>${i.itemName}</td><td>${i.quantity}</td><td>₹${i.subtotal}</td></tr>`).join('')}</tbody></table><div class="total"><span>Total paid</span><strong>₹${order.total}</strong></div><div class="details"><div>Payment method<b>Razorpay · ${order.payment_status}</b></div><div>Mobile number<b>+91 ${order.phone}</b></div></div><p class="thanks">Thank you for visiting Cafe Coffee Bar 3.0.</p></main></body></html>`) })
app.post(`${adminPath}/api/login`, adminLimiter, async (req,res) => { const { username, password } = req.body; const expectedUser=process.env.ADMIN_USERNAME || 'admin'; const hash=process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'change-me', 10); if(username !== expectedUser || !(await bcrypt.compare(password || '', hash))) return res.status(401).json({ error:'Invalid admin credentials' }); res.cookie('ccb_admin', jwt.sign({ sub:username },jwtSecret,{ expiresIn:'8h' }),{ httpOnly:true, sameSite:process.env.NODE_ENV==='production' ? 'none' : 'strict', secure:process.env.NODE_ENV==='production', maxAge:8*60*60*1000 }); res.json({ ok:true }) })
app.post(`${adminPath}/api/logout`, auth, (req,res) => { res.clearCookie('ccb_admin'); res.json({ ok:true }) })
app.get(`${adminPath}/api/orders`, auth, (req,res) => res.json(listOrders()))
app.patch(`${adminPath}/api/orders/:id/status`, auth, (req,res) => { const allowed=['PAID','COMPLETED','CANCELLED']; if(!allowed.includes(req.body.status))return res.status(400).json({error:'Invalid order status'}); const updated=updateOrderStatus(req.params.id,req.body.status); if(!updated)return res.status(404).json({error:'Order not found'}); res.json({ok:true,status:req.body.status}) })
app.get(`${adminPath}/api/menu`, auth, (req,res) => res.json(listMenu()))
app.post(`${adminPath}/api/menu`, auth, (req,res) => { const { id,name,category,description='',price,available=true }=req.body; if(!id||!name||!category||!Number.isInteger(Number(price))||Number(price)<0)return res.status(400).json({error:'id, name, category and a valid price are required'}); res.status(201).json(upsertMenu({id,name,category,description,price:Number(price),available})) })
app.delete(`${adminPath}/api/menu/:id`, auth, (req,res) => res.json({ deleted:deleteMenu(req.params.id) }))

app.listen(port, () => console.log(`CCB Express API listening on http://localhost:${port}`))
