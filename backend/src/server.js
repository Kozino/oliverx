import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = Number(process.env.PORT || 3001);
const API_PREFIX = '/api';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',').map(value => value.trim()).filter(Boolean);
const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SERVICE_ROLE_KEY);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS.'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-ID'],
  maxAge: 600
}));
app.use(express.json({ limit: '64kb' }));
app.use(`${API_PREFIX}/auth`, rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(`${API_PREFIX}`, rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false }));

const authOptions = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
const serviceClient = configured ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, authOptions) : null;
const authClient = configured ? () => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, authOptions) : null;

class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') { super(message); this.status = status; this.code = code; }
}
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const requireConfigured = (_req, _res, next) => configured ? next() : next(new HttpError(503, 'Database service is not configured. Add the Supabase environment variables to the backend service.', 'SERVICE_NOT_CONFIGURED'));
const requireAuth = asyncRoute(async (req, _res, next) => {
  if (!configured) throw new HttpError(503, 'Database service is not configured. Add the Supabase environment variables to the backend service.', 'SERVICE_NOT_CONFIGURED');
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Sign in is required.', 'AUTH_REQUIRED');
  const { data: authData, error: authError } = await serviceClient.auth.getUser(token);
  if (authError || !authData?.user) throw new HttpError(401, 'Your session is invalid or expired. Please sign in again.', 'SESSION_INVALID');
  const { data: profile, error: profileError } = await serviceClient.from('profiles')
    .select('user_id,email,full_name,username,phone,country,display_currency,role,status,created_at,preferences')
    .eq('user_id', authData.user.id).maybeSingle();
  if (profileError) throw new HttpError(500, 'Could not load your account profile.', 'PROFILE_LOOKUP_FAILED');
  if (!profile) throw new HttpError(403, 'Your profile has not finished provisioning. Contact support.', 'PROFILE_MISSING');
  if (profile.status !== 'active') throw new HttpError(403, 'This account is not active.', 'ACCOUNT_INACTIVE');
  req.authUser = authData.user;
  req.profile = profile;
  req.accessToken = token;
  next();
});
const requireAdmin = (req, res, next) => {
  if (req.profile?.role !== 'admin') return next(new HttpError(403, 'Administrator access is required.', 'ADMIN_REQUIRED'));
  next();
};
const dbResult = (result, message = 'Database operation failed.') => {
  if (result.error) throw new HttpError(400, message, 'DATABASE_OPERATION_FAILED');
  return result.data;
};
const parseOrThrow = (schema, value) => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map(issue => issue.message).join(' '), 'VALIDATION_FAILED');
  return parsed.data;
};
const nowIso = () => new Date().toISOString();
const publicProfile = profile => ({
  user_id: profile.user_id,
  email: profile.email,
  full_name: profile.full_name,
  username: profile.username,
  phone: profile.phone,
  country: profile.country,
  display_currency: profile.display_currency,
  role: profile.role,
  status: profile.status,
  created_at: profile.created_at,
  preferences: profile.preferences || {}
});
const profileSelect = 'user_id,email,full_name,username,phone,country,display_currency,role,status,created_at,preferences';

async function audit(actorId, action, targetType, targetId = null, details = {}) {
  if (!serviceClient) return;
  const result = await serviceClient.from('audit_logs').insert({
    actor_user_id: actorId, action, target_type: targetType, target_id: targetId,
    details: details || {}, created_at: nowIso()
  });
  if (result.error) console.error('audit insert failed', result.error.code || 'database_error');
}
async function getUserPortfolio(userId) {
  const { data, error } = await serviceClient.from('portfolios')
    .select('id,name,currency,created_at').eq('user_id', userId).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (error) throw new HttpError(500, 'Could not load the portfolio.', 'PORTFOLIO_LOOKUP_FAILED');
  return data;
}
async function getCashBalance(userId, currency = 'USD') {
  const { data, error } = await serviceClient.from('account_ledger').select('amount').eq('user_id', userId).eq('currency', currency);
  if (error) throw new HttpError(500, 'Could not calculate the account ledger balance.', 'LEDGER_LOOKUP_FAILED');
  return (data || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
}
async function requireInstrument(instrumentId, includeInactive = false) {
  const query = serviceClient.from('instruments').select('*').eq('id', instrumentId);
  if (!includeInactive) query.eq('is_active', true);
  const { data, error } = await query.maybeSingle();
  if (error) throw new HttpError(500, 'Could not look up the instrument.', 'INSTRUMENT_LOOKUP_FAILED');
  if (!data) throw new HttpError(404, 'Instrument was not found or is unavailable.', 'INSTRUMENT_NOT_FOUND');
  return data;
}
async function userBootstrap(req) {
  const uid = req.authUser.id;
  const portfolio = await getUserPortfolio(uid);
  const [instrumentsResult, positionsResult, ordersResult, requestsResult, activityResult, watchlistResult, alertsResult, notificationsResult, ticketsResult, modelsResult, researchResult] = await Promise.all([
    serviceClient.from('instruments').select('id,symbol,name,asset_class,description,currency,quote_price,quote_change_percent,coupon_rate,maturity_date,indicative_yield,issuer,is_active,updated_at').eq('is_active', true).order('symbol'),
    portfolio ? serviceClient.from('positions').select('id,quantity,average_cost,updated_at,instrument:instruments(id,symbol,name,asset_class,currency,quote_price,quote_change_percent,coupon_rate,maturity_date,indicative_yield)').eq('portfolio_id', portfolio.id).eq('user_id', uid).order('updated_at', { ascending: false }) : Promise.resolve({ data: [], error: null }),
    serviceClient.from('orders').select('id,portfolio_id,instrument_id,side,order_type,quantity,limit_price,status,created_at,updated_at,client_note,instrument:instruments(symbol,name,asset_class,currency,quote_price)').eq('user_id', uid).order('created_at', { ascending: false }).limit(100),
    serviceClient.from('account_requests').select('id,request_type,amount,currency,recipient_label,status,created_at,reviewed_at,review_note').eq('user_id', uid).order('created_at', { ascending: false }).limit(100),
    serviceClient.from('account_activity').select('id,event_type,title,description,amount,currency,created_at,status').eq('user_id', uid).order('created_at', { ascending: false }).limit(100),
    serviceClient.from('watchlist_entries').select('id,instrument_id,created_at,instrument:instruments(id,symbol,name,asset_class,currency,quote_price,quote_change_percent)').eq('user_id', uid).order('created_at', { ascending: false }),
    serviceClient.from('price_alerts').select('id,instrument_id,condition,threshold,is_active,triggered_at,created_at,instrument:instruments(id,symbol,name,asset_class,currency,quote_price)').eq('user_id', uid).order('created_at', { ascending: false }),
    serviceClient.from('notifications').select('id,title,body,category,is_read,created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(100),
    serviceClient.from('support_tickets').select('id,subject,message,status,created_at,updated_at,admin_reply').eq('user_id', uid).order('created_at', { ascending: false }).limit(100),
    serviceClient.from('portfolio_models').select('id,name,summary,allocation,risk_label,created_at,updated_at').eq('is_published', true).order('created_at', { ascending: false }).limit(100),
    serviceClient.from('research_articles').select('id,title,summary,body,category,created_at,updated_at').eq('is_published', true).order('created_at', { ascending: false }).limit(100)
  ]);
  const checked = [instrumentsResult, positionsResult, ordersResult, requestsResult, activityResult, watchlistResult, alertsResult, notificationsResult, ticketsResult, modelsResult, researchResult];
  if (checked.some(item => item.error)) throw new HttpError(500, 'Could not load account data.', 'BOOTSTRAP_FAILED');
  const accountCurrency = portfolio?.currency || req.profile.display_currency || 'USD';
  const cashBalance = await getCashBalance(uid, accountCurrency);
  const instruments = instrumentsResult.data || [];
  const positions = positionsResult.data || [];
  const hasUnpricedOrUnconverted = positions.some(position => position.instrument?.quote_price == null || position.instrument?.currency !== accountCurrency);
  const marketValue = hasUnpricedOrUnconverted ? null : positions.reduce((sum, position) => sum + Number(position.quantity) * Number(position.instrument?.quote_price || 0), 0);
  return {
    profile: publicProfile(req.profile),
    portfolio,
    summary: { currency: accountCurrency, cash_balance: cashBalance, market_value: marketValue, total_value: marketValue == null ? null : cashBalance + marketValue, open_positions: positions.length },
    instruments,
    positions,
    orders: ordersResult.data || [],
    account_requests: requestsResult.data || [],
    activity: activityResult.data || [],
    watchlist: watchlistResult.data || [],
    price_alerts: alertsResult.data || [],
    notifications: notificationsResult.data || [],
    support_tickets: ticketsResult.data || [],
    portfolio_models: modelsResult.data || [],
    research_articles: researchResult.data || []
  };
}

app.get(`${API_PREFIX}/health`, (_req, res) => {
  res.json({ ok: true, service: 'OLTREVIX BROKERAGE API', configured, database: configured ? 'configured' : 'not_configured', timestamp: nowIso() });
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, message: { error: 'Too many sign-in attempts. Try again later.', code: 'AUTH_RATE_LIMIT' }, standardHeaders: 'draft-7', legacyHeaders: false });
const registerSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(128),
  full_name: z.string().trim().min(2).max(100),
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  country: z.string().trim().max(80).optional().or(z.literal('')),
  display_currency: z.enum(['USD','QAR','GBP','EUR']).default('USD')
});
app.post(`${API_PREFIX}/auth/register`, requireConfigured, loginLimiter, asyncRoute(async (req, res) => {
  const body = parseOrThrow(registerSchema, req.body);
  const { data, error } = await authClient().auth.signUp({
    email: body.email,
    password: body.password,
    options: { data: { full_name: body.full_name, username: body.username || null, phone: body.phone || null, country: body.country || null, display_currency: body.display_currency } }
  });
  if (error) throw new HttpError(400, 'Could not create the account. Check the details or contact support.', 'REGISTRATION_FAILED');
  res.status(201).json({
    confirmation_required: !data.session,
    message: data.session ? 'Account created.' : 'Check your email to confirm the account.',
    session: data.session ? { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at } : null,
    user: data.user ? { id: data.user.id, email: data.user.email } : null
  });
}));
app.post(`${API_PREFIX}/auth/login`, requireConfigured, loginLimiter, asyncRoute(async (req, res) => {
  const body = parseOrThrow(z.object({ email: z.string().trim().email(), password: z.string().min(1).max(128) }), req.body);
  const { data, error } = await authClient().auth.signInWithPassword({ email: body.email, password: body.password });
  if (error || !data.session) throw new HttpError(401, 'Email or password is incorrect.', 'INVALID_CREDENTIALS');
  res.json({ session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at }, user: { id: data.user.id, email: data.user.email } });
}));
app.post(`${API_PREFIX}/auth/refresh`, requireConfigured, asyncRoute(async (req, res) => {
  const body = parseOrThrow(z.object({ refresh_token: z.string().min(1) }), req.body);
  const { data, error } = await authClient().auth.refreshSession({ refresh_token: body.refresh_token });
  if (error || !data.session) throw new HttpError(401, 'Session could not be refreshed. Please sign in again.', 'REFRESH_FAILED');
  res.json({ session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token, expires_at: data.session.expires_at }, user: { id: data.user.id, email: data.user.email } });
}));
app.post(`${API_PREFIX}/auth/forgot-password`, requireConfigured, loginLimiter, asyncRoute(async (req, res) => {
  const body = parseOrThrow(z.object({ email: z.string().trim().email() }), req.body);
  const { error } = await authClient().auth.resetPasswordForEmail(body.email, { redirectTo: `${FRONTEND_URL.replace(/\/$/, '')}/reset-password` });
  if (error) throw new HttpError(400, 'Password reset could not be requested. Try again later.', 'RESET_REQUEST_FAILED');
  res.json({ message: 'If an account matches that address, a password reset email will be sent.' });
}));
app.post(`${API_PREFIX}/auth/update-password`, requireConfigured, requireAuth, asyncRoute(async (req, res) => {
  const body = parseOrThrow(z.object({ password: z.string().min(10).max(128) }), req.body);
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${req.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: body.password })
  });
  if (!response.ok) throw new HttpError(400, 'Password could not be updated.', 'PASSWORD_UPDATE_FAILED');
  res.json({ message: 'Password updated.' });
}));
app.get(`${API_PREFIX}/me`, requireAuth, (req, res) => res.json({ profile: publicProfile(req.profile) }));

app.get(`${API_PREFIX}/bootstrap`, requireAuth, asyncRoute(async (req, res) => res.json(await userBootstrap(req))));
app.get(`${API_PREFIX}/instruments`, requireAuth, asyncRoute(async (req, res) => {
  const classValue = req.query.asset_class;
  const validClasses = ['stocks', 'government_bonds', 'commodities'];
  if (classValue && !validClasses.includes(classValue)) throw new HttpError(400, 'Unsupported asset class.', 'INVALID_ASSET_CLASS');
  let query = serviceClient.from('instruments').select('id,symbol,name,asset_class,description,currency,quote_price,quote_change_percent,coupon_rate,maturity_date,indicative_yield,issuer,is_active,updated_at').eq('is_active', true).order('symbol');
  if (classValue) query = query.eq('asset_class', classValue);
  if (req.query.q) query = query.or(`symbol.ilike.%${String(req.query.q).slice(0,40)}%,name.ilike.%${String(req.query.q).slice(0,80)}%`);
  const { data, error } = await query;
  if (error) throw new HttpError(500, 'Could not load instruments.', 'INSTRUMENTS_FAILED');
  res.json({ instruments: data || [] });
}));
app.get(`${API_PREFIX}/portfolio`, requireAuth, asyncRoute(async (req, res) => {
  const portfolio = await getUserPortfolio(req.authUser.id);
  const accountCurrency = portfolio?.currency || req.profile.display_currency || 'USD';
  if (!portfolio) {
    const cash = await getCashBalance(req.authUser.id, accountCurrency);
    return res.json({ portfolio: null, positions: [], summary: { currency: accountCurrency, cash_balance: cash, market_value: 0, total_value: cash } });
  }
  const { data, error } = await serviceClient.from('positions').select('id,quantity,average_cost,updated_at,instrument:instruments(id,symbol,name,asset_class,currency,quote_price)').eq('portfolio_id', portfolio.id).eq('user_id', req.authUser.id).order('updated_at', { ascending: false });
  if (error) throw new HttpError(500, 'Could not load positions.', 'POSITIONS_FAILED');
  const cash = await getCashBalance(req.authUser.id, accountCurrency);
  const rows = data || []; const unknown = rows.some(row => row.instrument?.quote_price == null || row.instrument?.currency !== accountCurrency);
  const market = unknown ? null : rows.reduce((sum, row) => sum + Number(row.quantity) * Number(row.instrument?.quote_price || 0), 0);
  res.json({ portfolio, positions: rows, summary: { currency: accountCurrency, cash_balance: cash, market_value: market, total_value: market == null ? null : cash + market } });
}));

const orderSchema = z.object({ instrument_id: z.string().uuid(), side: z.enum(['buy','sell']), order_type: z.enum(['market','limit']).default('market'), quantity: z.number().positive().max(100000000), limit_price: z.number().positive().nullable().optional(), client_note: z.string().trim().max(240).optional().or(z.literal('')) }).superRefine((body, ctx) => {
  if (body.order_type === 'limit' && body.limit_price == null) ctx.addIssue({ code: 'custom', path: ['limit_price'], message: 'A positive limit price is required for limit requests.' });
});
app.get(`${API_PREFIX}/orders`, requireAuth, asyncRoute(async (req, res) => {
  const { data, error } = await serviceClient.from('orders').select('id,portfolio_id,instrument_id,side,order_type,quantity,limit_price,status,created_at,updated_at,client_note,instrument:instruments(symbol,name,asset_class,currency,quote_price)').eq('user_id', req.authUser.id).order('created_at', { ascending: false }).limit(100);
  if (error) throw new HttpError(500, 'Could not load order requests.', 'ORDERS_FAILED');
  res.json({ orders: data || [] });
}));
app.post(`${API_PREFIX}/orders`, requireAuth, asyncRoute(async (req, res) => {
  const body = parseOrThrow(orderSchema, req.body);
  if (body.order_type === 'limit' && !body.limit_price) throw new HttpError(400, 'A limit price is required for a limit order.', 'LIMIT_PRICE_REQUIRED');
  const instrument = await requireInstrument(body.instrument_id);
  const portfolio = await getUserPortfolio(req.authUser.id);
  if (!portfolio) throw new HttpError(409, 'No portfolio is available for this account.', 'PORTFOLIO_NOT_READY');
  const { data, error } = await serviceClient.from('orders').insert({
    user_id: req.authUser.id, portfolio_id: portfolio.id, instrument_id: instrument.id,
    side: body.side, order_type: body.order_type, quantity: body.quantity,
    limit_price: body.order_type === 'limit' ? body.limit_price : null,
    client_note: body.client_note || null, status: 'awaiting_broker'
  }).select('id,status,created_at,instrument_id,side,order_type,quantity,limit_price').single();
  if (error) throw new HttpError(400, 'Order request could not be saved.', 'ORDER_CREATE_FAILED');
  await serviceClient.from('account_activity').insert({ user_id: req.authUser.id, event_type: 'order_request', title: 'Order request submitted', description: `${body.side.toUpperCase()} ${instrument.symbol} · awaiting execution integration`, amount: null, currency: instrument.currency, status: 'awaiting_broker' });
  res.status(201).json({ order: data, execution: 'not_connected', message: 'Order request saved. It has not been routed or executed; a broker integration is required.' });
}));
app.post(`${API_PREFIX}/orders/:id/cancel`, requireAuth, asyncRoute(async (req, res) => {
  const { data, error } = await serviceClient.from('orders').update({ status: 'cancelled', updated_at: nowIso() }).eq('id', req.params.id).eq('user_id', req.authUser.id).eq('status', 'awaiting_broker').select('id,status').maybeSingle();
  if (error) throw new HttpError(400, 'Order request could not be cancelled.', 'ORDER_CANCEL_FAILED');
  if (!data) throw new HttpError(404, 'Pending order request was not found.', 'ORDER_NOT_FOUND');
  res.json({ order: data });
}));

const requestSchema = z.object({ request_type: z.enum(['funding','withdrawal','transfer']), amount: z.number().positive().max(100000000), currency: z.enum(['USD','QAR','GBP','EUR']).default('USD'), recipient_label: z.string().trim().max(120).optional().or(z.literal('')), user_note: z.string().trim().max(300).optional().or(z.literal('')) }).superRefine((body, ctx) => {
  if (body.request_type === 'transfer' && !body.recipient_label) ctx.addIssue({ code: 'custom', path: ['recipient_label'], message: 'A recipient identifier is required for transfer requests.' });
});
app.get(`${API_PREFIX}/account-requests`, requireAuth, asyncRoute(async (req, res) => {
  const { data, error } = await serviceClient.from('account_requests').select('id,request_type,amount,currency,recipient_label,status,created_at,reviewed_at,review_note').eq('user_id', req.authUser.id).order('created_at', { ascending: false }).limit(100);
  if (error) throw new HttpError(500, 'Could not load account requests.', 'REQUESTS_FAILED');
  res.json({ requests: data || [] });
}));
app.post(`${API_PREFIX}/account-requests`, requireAuth, asyncRoute(async (req, res) => {
  const body = parseOrThrow(requestSchema, req.body);
  const portfolio = await getUserPortfolio(req.authUser.id);
  const accountCurrency = portfolio?.currency || req.profile.display_currency || 'USD';
  if (body.currency !== accountCurrency) throw new HttpError(400, `Requests must use the portfolio currency (${accountCurrency}). Currency conversion is not configured.`, 'PORTFOLIO_CURRENCY_REQUIRED');
  if (body.request_type !== 'funding') {
    const available = await getCashBalance(req.authUser.id, accountCurrency);
    if (body.amount > available) throw new HttpError(400, 'The request exceeds the available ledger balance.', 'INSUFFICIENT_LEDGER_BALANCE');
  }
  const { data, error } = await serviceClient.from('account_requests').insert({
    user_id: req.authUser.id, request_type: body.request_type, amount: body.amount,
    currency: body.currency, recipient_label: body.recipient_label || null,
    user_note: body.user_note || null, status: 'pending'
  }).select('id,request_type,amount,currency,recipient_label,status,created_at').single();
  if (error) throw new HttpError(400, 'Request could not be saved.', 'REQUEST_CREATE_FAILED');
  await serviceClient.from('account_activity').insert({ user_id: req.authUser.id, event_type: `${body.request_type}_request`, title: `${body.request_type[0].toUpperCase()+body.request_type.slice(1)} request created`, description: 'Awaiting review; no funds have moved.', amount: null, currency: body.currency, status: 'pending' });
  res.status(201).json({ request: data, message: 'Request saved for review. No payment, withdrawal or transfer has been executed.' });
}));
app.post(`${API_PREFIX}/account-requests/:id/cancel`, requireAuth, asyncRoute(async (req, res) => {
  const { data, error } = await serviceClient.from('account_requests').update({ status: 'cancelled', updated_at: nowIso() }).eq('id', req.params.id).eq('user_id', req.authUser.id).eq('status', 'pending').select('id,status').maybeSingle();
  if (error) throw new HttpError(400, 'Request could not be cancelled.', 'REQUEST_CANCEL_FAILED');
  if (!data) throw new HttpError(404, 'Pending request was not found.', 'REQUEST_NOT_FOUND');
  res.json({ request: data });
}));

app.get(`${API_PREFIX}/watchlist`, requireAuth, asyncRoute(async (req, res) => {
  const { data, error } = await serviceClient.from('watchlist_entries').select('id,instrument_id,created_at,instrument:instruments(id,symbol,name,asset_class,currency,quote_price,quote_change_percent)').eq('user_id', req.authUser.id).order('created_at', { ascending: false });
  if (error) throw new HttpError(500, 'Could not load the watchlist.', 'WATCHLIST_FAILED');
  res.json({ watchlist: data || [] });
}));
app.post(`${API_PREFIX}/watchlist`, requireAuth, asyncRoute(async (req, res) => {
  const body = parseOrThrow(z.object({ instrument_id: z.string().uuid() }), req.body);
  await requireInstrument(body.instrument_id);
  const { data, error } = await serviceClient.from('watchlist_entries').upsert({ user_id: req.authUser.id, instrument_id: body.instrument_id }, { onConflict: 'user_id,instrument_id' }).select('id,instrument_id,created_at').single();
  if (error) throw new HttpError(400, 'Instrument could not be added to the watchlist.', 'WATCHLIST_ADD_FAILED');
  res.status(201).json({ entry: data });
}));
app.delete(`${API_PREFIX}/watchlist/:instrumentId`, requireAuth, asyncRoute(async (req, res) => {
  const { error } = await serviceClient.from('watchlist_entries').delete().eq('user_id', req.authUser.id).eq('instrument_id', req.params.instrumentId);
  if (error) throw new HttpError(400, 'Watchlist entry could not be removed.', 'WATCHLIST_REMOVE_FAILED');
  res.status(204).end();
}));

app.get(`${API_PREFIX}/price-alerts`, requireAuth, asyncRoute(async (req, res) => {
  const { data, error } = await serviceClient.from('price_alerts').select('id,instrument_id,condition,threshold,is_active,triggered_at,created_at,instrument:instruments(id,symbol,name,asset_class,currency,quote_price)').eq('user_id', req.authUser.id).order('created_at', { ascending: false });
  if (error) throw new HttpError(500, 'Could not load price alerts.', 'ALERTS_FAILED');
  res.json({ alerts: data || [] });
}));
app.post(`${API_PREFIX}/price-alerts`, requireAuth, asyncRoute(async (req, res) => {
  const body = parseOrThrow(z.object({ instrument_id: z.string().uuid(), condition: z.enum(['above','below']), threshold: z.number().positive().max(100000000) }), req.body);
  await requireInstrument(body.instrument_id);
  const { data, error } = await serviceClient.from('price_alerts').insert({ user_id: req.authUser.id, ...body, is_active: true }).select('id,instrument_id,condition,threshold,is_active,created_at').single();
  if (error) throw new HttpError(400, 'Price alert could not be saved.', 'ALERT_CREATE_FAILED');
  res.status(201).json({ alert: data });
}));
app.delete(`${API_PREFIX}/price-alerts/:id`, requireAuth, asyncRoute(async (req, res) => {
  const { error } = await serviceClient.from('price_alerts').delete().eq('user_id', req.authUser.id).eq('id', req.params.id);
  if (error) throw new HttpError(400, 'Price alert could not be removed.', 'ALERT_DELETE_FAILED');
  res.status(204).end();
}));
app.post(`${API_PREFIX}/price-alerts/:id/check`, requireAuth, asyncRoute(async (req, res) => {
  const { data: alert, error } = await serviceClient.from('price_alerts').select('id,instrument_id,condition,threshold,is_active,instrument:instruments(id,symbol,quote_price)').eq('id', req.params.id).eq('user_id', req.authUser.id).maybeSingle();
  if (error || !alert) throw new HttpError(404, 'Alert was not found.', 'ALERT_NOT_FOUND');
  if (!alert.is_active) throw new HttpError(409, 'This alert is no longer active.', 'ALERT_INACTIVE');
  const quote = alert.instrument?.quote_price;
  if (quote == null) throw new HttpError(409, 'No market quote is available for this instrument.', 'QUOTE_UNAVAILABLE');
  const triggered = alert.condition === 'above' ? Number(quote) >= Number(alert.threshold) : Number(quote) <= Number(alert.threshold);
  if (triggered) {
    await serviceClient.from('price_alerts').update({ is_active: false, triggered_at: nowIso() }).eq('id', alert.id).eq('user_id', req.authUser.id);
    await serviceClient.from('notifications').insert({ user_id: req.authUser.id, title: 'Price alert triggered', body: `${alert.instrument.symbol} met the saved threshold.`, category: 'price_alert' });
  }
  res.json({ triggered, quote, symbol: alert.instrument.symbol });
}));

app.get(`${API_PREFIX}/support-tickets`, requireAuth, asyncRoute(async (req, res) => {
  const { data, error } = await serviceClient.from('support_tickets').select('id,subject,message,status,created_at,updated_at,admin_reply').eq('user_id', req.authUser.id).order('created_at', { ascending: false }).limit(100);
  if (error) throw new HttpError(500, 'Could not load support tickets.', 'SUPPORT_LOAD_FAILED');
  res.json({ tickets: data || [] });
}));
app.post(`${API_PREFIX}/support-tickets`, requireAuth, asyncRoute(async (req, res) => {
  const body = parseOrThrow(z.object({ subject: z.string().trim().min(3).max(140), message: z.string().trim().min(5).max(5000) }), req.body);
  const { data, error } = await serviceClient.from('support_tickets').insert({ user_id: req.authUser.id, subject: body.subject, message: body.message, status: 'open' }).select('id,subject,message,status,created_at').single();
  if (error) throw new HttpError(400, 'Support request could not be created.', 'SUPPORT_CREATE_FAILED');
  res.status(201).json({ ticket: data });
}));
app.patch(`${API_PREFIX}/profile`, requireAuth, asyncRoute(async (req, res) => {
  const body = parseOrThrow(z.object({ full_name: z.string().trim().min(2).max(100).optional(), username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/).optional().or(z.literal('')), phone: z.string().trim().max(40).optional().or(z.literal('')), country: z.string().trim().max(80).optional().or(z.literal('')), display_currency: z.enum(['USD','QAR','GBP','EUR']).optional(), preferences: z.record(z.boolean()).optional() }).strict(), req.body);
  const profilePatch = { ...body, ...(body.username !== undefined ? { username: body.username || null } : {}), updated_at: nowIso() };
  const { data, error } = await serviceClient.from('profiles').update(profilePatch).eq('user_id', req.authUser.id).select(profileSelect).single();
  if (error) throw new HttpError(400, 'Profile could not be updated.', 'PROFILE_UPDATE_FAILED');
  res.json({ profile: publicProfile(data) });
}));
app.get(`${API_PREFIX}/notifications`, requireAuth, asyncRoute(async (req, res) => {
  const { data, error } = await serviceClient.from('notifications').select('id,title,body,category,is_read,created_at').eq('user_id', req.authUser.id).order('created_at', { ascending: false }).limit(100);
  if (error) throw new HttpError(500, 'Could not load notifications.', 'NOTIFICATIONS_FAILED');
  res.json({ notifications: data || [] });
}));
app.post(`${API_PREFIX}/notifications/:id/read`, requireAuth, asyncRoute(async (req, res) => {
  const { data, error } = await serviceClient.from('notifications').update({ is_read: true }).eq('id', req.params.id).eq('user_id', req.authUser.id).select('id,is_read').maybeSingle();
  if (error || !data) throw new HttpError(404, 'Notification was not found.', 'NOTIFICATION_NOT_FOUND');
  res.json({ notification: data });
}));
app.get(`${API_PREFIX}/activity`, requireAuth, asyncRoute(async (req, res) => {
  const { data, error } = await serviceClient.from('account_activity').select('id,event_type,title,description,amount,currency,created_at,status').eq('user_id', req.authUser.id).order('created_at', { ascending: false }).limit(200);
  if (error) throw new HttpError(500, 'Could not load account activity.', 'ACTIVITY_FAILED');
  res.json({ activity: data || [] });
}));

// Admin APIs are role-checked on every request. No endpoint posts to a bank, broker or exchange.
app.get(`${API_PREFIX}/admin/bootstrap`, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const [users, orders, requests, instruments, tickets, auditRows, models, research] = await Promise.all([
    serviceClient.from('profiles').select(profileSelect).order('created_at', { ascending: false }).limit(200),
    serviceClient.from('orders').select('id,user_id,instrument_id,side,order_type,quantity,limit_price,status,created_at,instrument:instruments(symbol,name,asset_class)').order('created_at', { ascending: false }).limit(200),
    serviceClient.from('account_requests').select('id,user_id,request_type,amount,currency,recipient_label,status,created_at,reviewed_at,review_note').order('created_at', { ascending: false }).limit(200),
    serviceClient.from('instruments').select('*').order('symbol'),
    serviceClient.from('support_tickets').select('id,user_id,subject,message,status,created_at,updated_at,admin_reply').order('created_at', { ascending: false }).limit(200),
    serviceClient.from('audit_logs').select('id,actor_user_id,action,target_type,target_id,details,created_at').order('created_at', { ascending: false }).limit(200),
    serviceClient.from('portfolio_models').select('id,name,summary,allocation,risk_label,is_published,created_at,updated_at').order('created_at', { ascending: false }).limit(300),
    serviceClient.from('research_articles').select('id,title,summary,body,category,is_published,created_at,updated_at').order('created_at', { ascending: false }).limit(300)
  ]);
  const all = [users, orders, requests, instruments, tickets, auditRows, models, research];
  if (all.some(result => result.error)) throw new HttpError(500, 'Could not load admin workspace.', 'ADMIN_BOOTSTRAP_FAILED');
  const accountIds = [...new Set([...(orders.data || []), ...(requests.data || []), ...(tickets.data || [])].map(row => row.user_id).filter(Boolean))];
  let profileRows = [];
  if (accountIds.length) {
    const profileResults = await Promise.all(Array.from({ length: Math.ceil(accountIds.length / 100) }, (_, index) =>
      serviceClient.from('profiles').select('user_id,full_name,email').in('user_id', accountIds.slice(index * 100, (index + 1) * 100))
    ));
    if (profileResults.some(result => result.error)) throw new HttpError(500, 'Could not load account names for admin records.', 'ADMIN_PROFILES_FAILED');
    profileRows = profileResults.flatMap(result => result.data || []);
  }
  const profileMap = new Map(profileRows.map(profile => [profile.user_id, profile]));
  const withProfile = row => ({ ...row, profile: profileMap.get(row.user_id) || null });
  const [{ count: userCount }, { count: pendingRequests }, { count: openTickets }] = await Promise.all([
    serviceClient.from('profiles').select('user_id', { count: 'exact', head: true }),
    serviceClient.from('account_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    serviceClient.from('support_tickets').select('id', { count: 'exact', head: true }).in('status', ['open','in_progress'])
  ]);
  res.json({ profile: publicProfile(req.profile), summary: { users: userCount || 0, pending_requests: pendingRequests || 0, open_tickets: openTickets || 0 }, users: users.data || [], orders: (orders.data || []).map(withProfile), requests: (requests.data || []).map(withProfile), instruments: instruments.data || [], support_tickets: (tickets.data || []).map(withProfile), audit: auditRows.data || [], portfolio_models: models.data || [], research_articles: research.data || [] });
}));
app.patch(`${API_PREFIX}/admin/users/:id/status`, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const body = parseOrThrow(z.object({ status: z.enum(['active','suspended']) }), req.body);
  if (req.params.id === req.authUser.id) throw new HttpError(400, 'You cannot change your own admin account status here.', 'SELF_STATUS_CHANGE_BLOCKED');
  const { data, error } = await serviceClient.from('profiles').update({ status: body.status, updated_at: nowIso() }).eq('user_id', req.params.id).select('user_id,status').maybeSingle();
  if (error || !data) throw new HttpError(404, 'Account was not found.', 'ACCOUNT_NOT_FOUND');
  await audit(req.authUser.id, 'account_status_changed', 'profile', data.user_id, { status: body.status });
  res.json({ profile: data });
}));
app.patch(`${API_PREFIX}/admin/account-requests/:id`, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const body = parseOrThrow(z.object({ status: z.enum(['approved','rejected']), review_note: z.string().trim().max(500).optional().or(z.literal('')) }), req.body);
  const { data, error } = await serviceClient.from('account_requests').update({ status: body.status, review_note: body.review_note || null, reviewed_by: req.authUser.id, reviewed_at: nowIso(), updated_at: nowIso() }).eq('id', req.params.id).eq('status', 'pending').select('id,status,request_type,amount,currency,user_id').maybeSingle();
  if (error || !data) throw new HttpError(404, 'Pending request was not found.', 'PENDING_REQUEST_NOT_FOUND');
  await audit(req.authUser.id, `account_request_${body.status}`, 'account_request', data.id, { request_type: data.request_type });
  res.json({ request: data, execution: 'not_connected', message: 'Review status updated. This does not move money or execute a payment.' });
}));
const instrumentSchema = z.object({ symbol: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9._-]+$/), name: z.string().trim().min(2).max(120), asset_class: z.enum(['stocks','government_bonds','commodities']), description: z.string().trim().max(2000).optional().or(z.literal('')), currency: z.enum(['USD','QAR','GBP','EUR']).default('USD'), quote_price: z.number().positive().nullable().optional(), quote_change_percent: z.number().min(-100).max(100).nullable().optional(), coupon_rate: z.number().min(0).max(100).nullable().optional(), maturity_date: z.string().date().nullable().optional(), indicative_yield: z.number().min(0).max(100).nullable().optional(), issuer: z.string().trim().max(120).optional().or(z.literal('')), is_active: z.boolean().default(true) });
app.post(`${API_PREFIX}/admin/instruments`, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const body = parseOrThrow(instrumentSchema, req.body);
  const { data, error } = await serviceClient.from('instruments').insert({ ...body, symbol: body.symbol.toUpperCase(), updated_at: nowIso() }).select('*').single();
  if (error) throw new HttpError(400, 'Instrument could not be created. Check that the symbol is unique.', 'INSTRUMENT_CREATE_FAILED');
  await audit(req.authUser.id, 'instrument_created', 'instrument', data.id, { symbol: data.symbol, asset_class: data.asset_class });
  res.status(201).json({ instrument: data });
}));
app.patch(`${API_PREFIX}/admin/instruments/:id`, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const partialSchema = instrumentSchema.partial().strict();
  const body = parseOrThrow(partialSchema, req.body);
  if (!Object.keys(body).length) throw new HttpError(400, 'At least one field is required.', 'EMPTY_UPDATE');
  const patch = { ...body, ...(body.symbol ? { symbol: body.symbol.toUpperCase() } : {}), updated_at: nowIso() };
  const { data, error } = await serviceClient.from('instruments').update(patch).eq('id', req.params.id).select('*').maybeSingle();
  if (error || !data) throw new HttpError(404, 'Instrument was not found or could not be updated.', 'INSTRUMENT_UPDATE_FAILED');
  await audit(req.authUser.id, 'instrument_updated', 'instrument', data.id, { symbol: data.symbol });
  res.json({ instrument: data });
}));
app.patch(`${API_PREFIX}/admin/orders/:id`, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const body = parseOrThrow(z.object({ status: z.enum(['reviewed','rejected','cancelled']) }), req.body);
  const { data, error } = await serviceClient.from('orders').update({ status: body.status, updated_at: nowIso() }).eq('id', req.params.id).in('status', ['awaiting_broker','reviewed']).select('id,status').maybeSingle();
  if (error || !data) throw new HttpError(404, 'Order request was not found or is no longer reviewable.', 'ORDER_REVIEW_FAILED');
  await audit(req.authUser.id, `order_${body.status}`, 'order', data.id, {});
  res.json({ order: data, execution: 'not_connected' });
}));
app.patch(`${API_PREFIX}/admin/support-tickets/:id`, requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const body = parseOrThrow(z.object({ status: z.enum(['in_progress','resolved','closed']), admin_reply: z.string().trim().max(5000).optional().or(z.literal('')) }), req.body);
  const { data, error } = await serviceClient.from('support_tickets').update({ status: body.status, admin_reply: body.admin_reply || null, updated_at: nowIso() }).eq('id', req.params.id).select('id,status,admin_reply').maybeSingle();
  if (error || !data) throw new HttpError(404, 'Support ticket was not found.', 'TICKET_UPDATE_FAILED');
  await audit(req.authUser.id, 'support_ticket_updated', 'support_ticket', data.id, { status: body.status });
  res.json({ ticket: data });
}));

app.use((req, _res, next) => next(new HttpError(404, `Route ${req.method} ${req.path} was not found.`, 'NOT_FOUND')));
app.use((error, _req, res, _next) => {
  const status = Number(error.status) || (error.message === 'Origin is not allowed by CORS.' ? 403 : 500);
  const message = status >= 500 && !error.status ? 'Unexpected server error.' : error.message;
  if (status >= 500) console.error('request failed', error.code || error.name || 'server_error');
  res.status(status).json({ error: message, code: error.code || 'SERVER_ERROR' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`OLTREVIX API listening on 0.0.0.0:${PORT}; Supabase ${configured ? 'configured' : 'not configured'}`));
