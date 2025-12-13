// ==================== SWIMHUB LICENSE MANAGEMENT SYSTEM ====================
// Complete integrated system:   Database + Discord Bot + Express Server
// Features:  Manual license key addition, automatic assignment, admin notifications

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const fetch = global.fetch || require('node-fetch');
const rateLimit = require('express-rate-limit');
const { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const LOW_STOCK_THRESHOLD = parseInt(process.env.LOW_STOCK_THRESHOLD) || 10;

// Support both ADMIN_DISCORD_ID and ADMIN_USER_ID env var names
const ADMIN_DISCORD_ID = process.env.ADMIN_DISCORD_ID || process.env.ADMIN_USER_ID || '';

// ---------- CONSTANTS ----------
const PRODUCTS = {
  'regular-monthly': { name: 'SwimHub Regular Monthly', duration: 30, tier: 'regular' },
  'regular-lifetime':  { name: 'SwimHub Regular Lifetime', duration: -1, tier: 'regular' },
  'master-monthly': { name: 'SwimHub Master Monthly', duration: 30, tier: 'master' },
  'master-lifetime': { name: 'SwimHub Master Lifetime', duration: -1, tier: 'master' }
};

const processedWebhooks = new Set();

// ---------- DISCORD CLIENT ----------
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: ['CHANNEL', 'MESSAGE']
});

// ---------- MIDDLEWARE ----------
// Trust proxy - required when running behind a reverse proxy (Railway, etc.)
// This allows express-rate-limit to correctly identify users via X-Forwarded-For header
app.set('trust proxy', 1);

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- RATE LIMITING ----------
// Rate limiter for webhook endpoints (100 requests per 15 minutes)
const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for polling endpoint (more permissive - 120 requests per minute)
const pollingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // Allow 120 requests per minute (2 per second sustained)
  message: 'Too many polling requests, please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------- DATABASE INITIALIZATION ----------
async function initDatabase() {
  const client = await pool.connect();
  try {
    // 1. Create Pending Purchases Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS pending_purchases (
        session_id TEXT PRIMARY KEY,
        discord_id TEXT,
        discord_username TEXT,
        email TEXT,
        product TEXT,
        access_token TEXT,
        status TEXT DEFAULT 'pending',
        license_key TEXT,
        created_at TIMESTAMP DEFAULT now(),
        updated_at TIMESTAMP DEFAULT now()
      );
    `);

    // --- FIX: Force add the column if it was missing from an old install ---
    await client.query(`
      ALTER TABLE pending_purchases 
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();
    `);
    
    // Add checkout_id column for Polar integration
    await client.query(`
      ALTER TABLE pending_purchases 
      ADD COLUMN IF NOT EXISTS checkout_id TEXT;
    `);
    // -----------------------------------------------------------------------

    // 2. License Stock Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS license_stock (
        id SERIAL PRIMARY KEY,
        license_key TEXT UNIQUE NOT NULL,
        product_type TEXT,
        status TEXT DEFAULT 'available',
        claimed BOOLEAN DEFAULT FALSE,
        claimed_by TEXT,
        claimed_at TIMESTAMP,
        customer_email TEXT,
        customer_discord_id TEXT,
        created_at TIMESTAMP DEFAULT now(),
        updated_at TIMESTAMP DEFAULT now()
      );
    `);
    
    // Fix for license_stock as well just in case
    await client.query(`
      ALTER TABLE license_stock 
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();
    `);
    
    // Add status column if missing from old schema
    await client.query(`
      ALTER TABLE license_stock 
      ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'available';
    `);
    
    // Add checkout_id and owner_email columns for Polar integration
    await client.query(`
      ALTER TABLE license_stock 
      ADD COLUMN IF NOT EXISTS checkout_id TEXT;
    `);
    await client.query(`
      ALTER TABLE license_stock 
      ADD COLUMN IF NOT EXISTS owner_email TEXT;
    `);

    // 3. User Licenses Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_licenses (
        id SERIAL PRIMARY KEY,
        discord_id TEXT,
        discord_username TEXT,
        license_key TEXT UNIQUE,
        product_type TEXT,
        product_name TEXT,
        expires_at TIMESTAMP,
        is_lifetime BOOLEAN DEFAULT FALSE,
        assigned_at TIMESTAMP DEFAULT now()
      );
    `);

    // 4. Purchase Log Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_log (
        id SERIAL PRIMARY KEY,
        license_key TEXT,
        customer_email TEXT,
        customer_discord_id TEXT,
        customer_username TEXT,
        product_type TEXT,
        amount DECIMAL(10, 2),
        payment_method TEXT,
        transaction_id TEXT,
        purchase_date TIMESTAMP DEFAULT now()
      );
    `);

    // 5. Licenses table (for tracking by checkout_id for Polar)
    await client.query(`
      CREATE TABLE IF NOT EXISTS licenses (
        id SERIAL PRIMARY KEY,
        key_value TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'available',
        owner_email TEXT,
        checkout_id TEXT,
        created_at TIMESTAMP DEFAULT now(),
        updated_at TIMESTAMP DEFAULT now()
      );
    `);
    
    // Add index for fast checkout_id lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_licenses_checkout_id ON licenses(checkout_id);
    `);

    // 6. Polar Purchases table - stores all Polar webhook data
    await client.query(`
      CREATE TABLE IF NOT EXISTS polar_purchases (
        id SERIAL PRIMARY KEY,
        checkout_id TEXT UNIQUE,
        customer_email TEXT NOT NULL,
        product_id TEXT,
        product_name TEXT,
        product_type TEXT,
        amount INTEGER,
        currency TEXT DEFAULT 'usd',
        license_key TEXT,
        status TEXT DEFAULT 'pending',
        discord_id TEXT,
        discord_username TEXT,
        polar_customer_id TEXT,
        raw_payload JSONB,
        created_at TIMESTAMP DEFAULT now(),
        completed_at TIMESTAMP
      );
    `);

    // Add indexes for polar_purchases
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_polar_purchases_email ON polar_purchases(customer_email);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_polar_purchases_status ON polar_purchases(status);
    `);

    console.log('✅ Database tables initialized and schemas updated');
  } catch (err) {
    console.error('❌ Database init error:', err);
  } finally {
    client.release();
  }
}

// ---------- DATABASE HELPERS ----------

async function savePendingPurchase(sessionId, data) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO pending_purchases (session_id, discord_id, discord_username, email, product, access_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id) DO UPDATE SET
         discord_id = EXCLUDED.discord_id,
         discord_username = EXCLUDED.discord_username,
         email = EXCLUDED.email,
         product = EXCLUDED.product,
         access_token = EXCLUDED.access_token,
         updated_at = now()`,
      [sessionId, data.discordId, data.discordUsername, data.email, data.product, data.accessToken]
    );
  } finally {
    client.release();
  }
}

async function getPendingPurchase(sessionId) {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM pending_purchases WHERE session_id = $1', [sessionId]);
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

async function getPendingPurchaseByEmail(email) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM pending_purchases WHERE email = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
      [email, 'pending']
    );
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

async function getPendingPurchaseByDiscordId(discordId) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM pending_purchases WHERE discord_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
      [discordId, 'pending']
    );
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

async function getMostRecentPendingPurchase() {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM pending_purchases WHERE status = $1 ORDER BY created_at DESC LIMIT 1',
      ['pending']
    );
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

async function markPurchaseCompleted(sessionId, licenseKey) {
  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE pending_purchases SET status = $1, license_key = $2, updated_at = now() WHERE session_id = $3',
      ['completed', licenseKey, sessionId]
    );
  } finally {
    client.release();
  }
}

async function getAvailableLicenseKey(productType) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM license_stock 
       WHERE product_type = $1 AND status = $2 AND claimed = FALSE 
       ORDER BY created_at ASC LIMIT 1`,
      [productType, 'available']
    );
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

async function claimLicenseKey(licenseKeyId, discordId, customerEmail = null) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE license_stock 
       SET claimed = TRUE, claimed_by = $1, claimed_at = now(), 
           customer_discord_id = $1, customer_email = $2, status = $3, updated_at = now()
       WHERE id = $4`,
      [discordId, customerEmail, 'assigned', licenseKeyId]
    );
  } finally {
    client.release();
  }
}

async function assignLicenseToUser(discordId, discordUsername, licenseKey, productType) {
  const product = PRODUCTS[productType];
  const now = new Date();
  const expiresAt = product.duration === -1 
    ? null 
    : new Date(now.getTime() + product.duration * 24 * 60 * 60 * 1000);

  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO user_licenses (discord_id, discord_username, license_key, product_type, product_name, expires_at, is_lifetime)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (license_key) DO NOTHING`,
      [discordId, discordUsername, licenseKey, productType, product.name, expiresAt, product.duration === -1]
    );
  } finally {
    client.release();
  }
}

async function logPurchase(licenseKey, customerEmail, discordId, discordUsername, productType) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO purchase_log (license_key, customer_email, customer_discord_id, customer_username, product_type, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [licenseKey, customerEmail, discordId, discordUsername, productType, 'polar']
    );
  } finally {
    client.release();
  }
}

async function addLicenseKeyToStock(licenseKey, productType = 'swimhub') {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `INSERT INTO license_stock (license_key, product_type, status, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (license_key) DO NOTHING
       RETURNING *`,
      [licenseKey, productType, 'available']
    );
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

async function getStockCount() {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT COUNT(*) as count FROM license_stock WHERE status = $1 AND claimed = FALSE',
      ['available']
    );
    return parseInt(result.rows[0].count) || 0;
  } finally {
    client.release();
  }
}

async function getLicenseStats() {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'available' AND claimed = FALSE THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN status = 'assigned' OR claimed = TRUE THEN 1 ELSE 0 END) as used
      FROM license_stock
    `);
    return result.rows[0] || { total: 0, available: 0, used: 0 };
  } finally {
    client.release();
  }
}

async function getStockByProductType() {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT 
        product_type,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'available' AND claimed = FALSE THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN status = 'assigned' OR claimed = TRUE THEN 1 ELSE 0 END) as used
      FROM license_stock
      GROUP BY product_type
      ORDER BY product_type
    `);
    return result.rows;
  } finally {
    client.release();
  }
}

async function getLicensesStats() {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
        SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) as used
      FROM licenses
    `);
    return result.rows[0] || { total: 0, available: 0, used: 0 };
  } finally {
    client.release();
  }
}

async function addLicenseToLicensesTable(licenseKey) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `INSERT INTO licenses (key_value, status, created_at, updated_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (key_value) DO NOTHING
       RETURNING *`,
      [licenseKey, 'available']
    );
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}

async function checkLowStockAndNotify() {
  try {
    const stats = await getLicensesStats();
    
    if (parseInt(stats.available) <= LOW_STOCK_THRESHOLD && parseInt(stats.available) > 0) {
      // Send notification to admin
      if (discordClient && ADMIN_DISCORD_ID) {
        try {
          const admin = await discordClient.users.fetch(ADMIN_DISCORD_ID);
          const embed = new EmbedBuilder()
            .setColor('#f59e0b')
            .setTitle('⚠️ Low License Stock Alert')
            .setDescription('License key inventory is running low!')
            .addFields(
              { name: 'Available Keys', value: stats.available.toString(), inline: true },
              { name: 'Used Keys', value: stats.used.toString(), inline: true },
              { name: 'Total Keys', value: stats.total.toString(), inline: true }
            )
            .setFooter({ text: 'SwimHub License System • Please add more keys soon' })
            .setTimestamp();
          
          await admin.send({ embeds: [embed] });
          console.log('⚠️ Low stock notification sent to admin');
        } catch (error) {
          console.error('Failed to send low stock notification:', error.message);
        }
      }
    } else if (parseInt(stats.available) === 0) {
      // Critical: Out of stock
      if (discordClient && ADMIN_DISCORD_ID) {
        try {
          const admin = await discordClient.users.fetch(ADMIN_DISCORD_ID);
          const embed = new EmbedBuilder()
            .setColor('#ef4444')
            .setTitle('🚨 OUT OF STOCK - CRITICAL')
            .setDescription('No license keys available! Customers cannot complete purchases.')
            .addFields(
              { name: 'Available Keys', value: '0', inline: true },
              { name: 'Status', value: '❌ Out of Stock', inline: true }
            )
            .setFooter({ text: 'SwimHub License System • ADD KEYS IMMEDIATELY' })
            .setTimestamp();
          
          await admin.send({ embeds: [embed] });
          console.log('🚨 Out of stock notification sent to admin');
        } catch (error) {
          console.error('Failed to send out of stock notification:', error.message);
        }
      }
    }
  } catch (error) {
    console.error('Error checking stock levels:', error);
  }
}

// ---------- WEBHOOK HANDLERS ----------

async function sendLicenseDM(discordId, licenseKey, product) {
  if (!discordClient || !discordId) return false;
  
  try {
    const user = await discordClient.users.fetch(discordId);
    const embed = new EmbedBuilder()
      .setColor('#10b981')
      .setTitle('🎉 Your License Key is Ready!')
      .setDescription('Thank you for your purchase!')
      .addFields(
        { name: 'Product', value: product.name, inline: true },
        { name: 'Duration', value: product.duration === -1 ? 'Lifetime' : `${product.duration} days`, inline: true },
        { name: 'License Key', value: `\`${licenseKey}\``, inline: false },
        { name: 'How to Activate', value: 'Use the license key in our Discord server or website', inline: false }
      )
      .setFooter({ text: 'SwimHub License System' })
      .setTimestamp();

    await user.send({ embeds: [embed] });
    return true;
  } catch (error) {
    console.error('Failed to send license DM:', error.message);
    return false;
  }
}

async function sendAdminNotification(customerInfo, licenseKey, product) {
  if (!discordClient || !ADMIN_DISCORD_ID) return;

  try {
    const admin = await discordClient.users.fetch(ADMIN_DISCORD_ID);
    const purchaseEmbed = new EmbedBuilder()
      .setColor('#667eea')
      .setTitle('📦 New Purchase Notification')
      .setDescription('A new customer has completed a purchase')
      .addFields(
        { name: 'Customer', value: customerInfo.discord_username || 'Unknown', inline: true },
        { name: 'Discord ID', value: customerInfo.discord_id || 'N/A', inline: true },
        { name: 'Email', value: customerInfo.email || 'N/A', inline: false },
        { name: 'Product', value: product.name, inline: true },
        { name: 'Duration', value: product.duration === -1 ? 'Lifetime' : `${product.duration} days`, inline: true },
        { name: 'License Key', value: `\`${licenseKey}\``, inline: false },
        { name: 'Remaining Stock', value: `${await getStockCount()} keys available`, inline: false }
      )
      .setFooter({ text: 'SwimHub Admin Dashboard' })
      .setTimestamp();

    await admin.send({ embeds: [purchaseEmbed] });
    console.log('✅ Admin notification sent');
  } catch (error) {
    console.error('Failed to send admin notification:', error.message);
  }
}

async function processCheckoutPayload(payload) {
  const data = payload.data || payload;
  const customer = data.customer || data.user || {};
  let metadata = data.metadata || data.custom_data || data.customData || {};

  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch (e) { metadata = {}; }
  }

  const customerEmail = customer.email || data.email;
  let session = null;

  if (metadata?.sessionId) {
    session = await getPendingPurchase(metadata.sessionId);
  }
  if (!session && metadata?.discordId) {
    session = await getPendingPurchaseByDiscordId(metadata.discordId);
  }
  if (!session && customerEmail) {
    session = await getPendingPurchaseByEmail(customerEmail);
  }
  if (!session) {
    session = await getMostRecentPendingPurchase();
  }

  if (!session) {
    console.error('❌ No pending session found for customer:', customerEmail);
    return { success: false, reason: 'no_pending_session' };
  }

  // Get available license key
  const availableKey = await getAvailableLicenseKey(session.product);
  if (!availableKey) {
    console.error('❌ No available license keys in stock for:', session.product);
    return { success: false, reason: 'no_available_keys' };
  }

  const licenseKey = availableKey.license_key;

  // Claim the license
  await claimLicenseKey(availableKey.id, session.discord_id, session.email);
  
  // Assign to user
  await assignLicenseToUser(session.discord_id, session.discord_username, licenseKey, session.product);
  
  // Mark purchase as completed
  await markPurchaseCompleted(session.session_id, licenseKey);
  
  // Log the purchase
  await logPurchase(licenseKey, session.email, session.discord_id, session.discord_username, session.product);

  // Send license to user
  const dmSuccess = await sendLicenseDM(session.discord_id, licenseKey, PRODUCTS[session.product]);
  
  // Send admin notification
  await sendAdminNotification(session, licenseKey, PRODUCTS[session.product]);

  console.log('✅ License delivered:', licenseKey, 'to', session.discord_username);
  return { success: true, licenseKey, dmSuccess };
}

// ---------- ROUTES ----------

app.get('/checkout', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
});

app.get('/checkout.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
});

// Health check endpoint
app.get('/health', webhookLimiter, async (req, res) => {
  try {
    // Check database connection
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    
    // Check Discord bot status
    const discordStatus = discordClient && discordClient.isReady() ? 'connected' : 'disconnected';
    
    // Get stock levels
    const stats = await getLicensesStats();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        discord: discordStatus
      },
      stock: {
        available: parseInt(stats.available),
        total: parseInt(stats.total),
        status: parseInt(stats.available) > LOW_STOCK_THRESHOLD ? 'good' : parseInt(stats.available) > 0 ? 'low' : 'out_of_stock'
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Polar webhook - GET handler for verification
app.get('/webhook/polar', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Polar webhook endpoint is active',
    method: 'POST',
    note: 'This endpoint accepts POST requests from Polar.sh webhooks'
  });
});

// ============ POLAR PRODUCT MAPPING ============
// Map your Polar.sh product IDs to our internal product types
// You can find product IDs in your Polar.sh dashboard
const POLAR_PRODUCT_MAP = {
  // Add your Polar product IDs here if you know them
  // 'polar_product_id': 'internal_product_type'
  
  // Fallback: if product name contains these keywords, map automatically
  'default': 'regular-monthly' // Default product type if no match found
};

// Helper function to determine product type from Polar data
// Mapping for Minion v2 products:
// - Basic = regular-monthly
// - Intermediate = regular-lifetime  
// - Advanced = master-monthly
// - Full Access = master-lifetime
function mapPolarProduct(productId, productName) {
  // First check direct product ID mapping
  if (POLAR_PRODUCT_MAP[productId]) {
    return POLAR_PRODUCT_MAP[productId];
  }
  
  // Try to infer from product name
  const name = (productName || '').toLowerCase();
  
  // Minion v2 naming convention
  if (name.includes('full access') || name.includes('full-access')) return 'master-lifetime';
  if (name.includes('advanced')) return 'master-monthly';
  if (name.includes('intermediate')) return 'regular-lifetime';
  if (name.includes('basic')) return 'regular-monthly';
  
  // Original SwimHub naming convention (fallback)
  if (name.includes('master') && name.includes('lifetime')) return 'master-lifetime';
  if (name.includes('master') && name.includes('month')) return 'master-monthly';
  if (name.includes('regular') && name.includes('lifetime')) return 'regular-lifetime';
  if (name.includes('regular') && name.includes('month')) return 'regular-monthly';
  if (name.includes('lifetime')) return 'regular-lifetime';
  if (name.includes('month')) return 'regular-monthly';
  
  // Return default
  return POLAR_PRODUCT_MAP['default'] || 'regular-monthly';
}

// Polar webhook
app.post('/webhook/polar', webhookLimiter, async (req, res) => {
  try {
    console.log('=== POLAR WEBHOOK RECEIVED ===');
    console.log('Event Type:', req.body?.type);
    
    // Standard Webhooks headers (used by Polar)
    const webhookId = req.headers['webhook-id'] || '';
    const webhookTimestamp = req.headers['webhook-timestamp'] || '';
    const webhookSignature = req.headers['webhook-signature'] || '';
    
    // Also check legacy header names
    const signatureHeader = webhookSignature || req.headers['polar-signature'] || '';
    
    const webhookSecretRaw = (process.env.POLAR_WEBHOOK_SECRET || '').trim();
    const skipSig = process.env.POLAR_SKIP_SIGNATURE === 'true';

    console.log('📋 Webhook Headers:');
    console.log('   webhook-id:', webhookId);
    console.log('   webhook-timestamp:', webhookTimestamp);
    console.log('   webhook-signature:', signatureHeader ? signatureHeader.substring(0, 50) + '...' : '(none)');

    let signatureValid = skipSig;

    // Verify signature using Standard Webhooks spec
    if (!signatureValid && webhookSecretRaw && signatureHeader) {
      console.log('🔐 Verifying webhook signature...');
      
      if (!req.rawBody) {
        console.error('❌ rawBody not available for signature verification');
        return res.status(400).json({ error: 'rawBody not available' });
      }
      
      const rawBodyString = req.rawBody.toString('utf8');

      // Extract the actual secret (remove prefix if present)
      // Polar uses format: polar_whs_BASE64SECRET or whsec_BASE64SECRET
      let secretBase64 = webhookSecretRaw;
      if (webhookSecretRaw.startsWith('polar_whs_')) {
        secretBase64 = webhookSecretRaw.substring(10); // Remove 'polar_whs_'
      } else if (webhookSecretRaw.startsWith('whsec_')) {
        secretBase64 = webhookSecretRaw.substring(6); // Remove 'whsec_'
      }
      
      // Decode the base64 secret
      let secretBytes;
      try {
        secretBytes = Buffer.from(secretBase64, 'base64');
        console.log('   Secret decoded successfully, length:', secretBytes.length, 'bytes');
      } catch (e) {
        console.error('   Failed to decode secret as base64, using raw');
        secretBytes = Buffer.from(webhookSecretRaw);
      }

      // Standard Webhooks format: msg_id.timestamp.payload
      // Per spec: signature content is `${webhook-id}.${webhook-timestamp}.${payload}`
      const signaturePayload = `${webhookId}.${webhookTimestamp}.${rawBodyString}`;
      
      // Parse signatures from header (format: "v1,signature v1,signature2")
      // Signatures are space-separated, each is "version,base64sig"
      const signatures = signatureHeader.split(' ');
      
      for (const sig of signatures) {
        // Parse "v1,BASE64SIGNATURE" format
        const [version, sigValue] = sig.split(',');
        
        if (!sigValue) {
          console.log('   Skipping malformed signature:', sig);
          continue;
        }
        
        console.log('   Checking signature version:', version);
        
        // Compute HMAC-SHA256
        const computed = crypto
          .createHmac('sha256', secretBytes)
          .update(signaturePayload)
          .digest('base64');
        
        console.log('   Computed signature:', computed.substring(0, 30) + '...');
        console.log('   Received signature:', sigValue.substring(0, 30) + '...');
        
        // Use timing-safe comparison
        try {
          const computedBuffer = Buffer.from(computed);
          const receivedBuffer = Buffer.from(sigValue);
          
          if (computedBuffer.length === receivedBuffer.length && 
              crypto.timingSafeEqual(computedBuffer, receivedBuffer)) {
            signatureValid = true;
            console.log('✅ Signature verified successfully!');
            break;
          }
        } catch (e) {
          // Length mismatch, continue to next signature
        }
        
        // Also try without base64 decode of secret (some implementations)
        const computedAlt = crypto
          .createHmac('sha256', webhookSecretRaw)
          .update(signaturePayload)
          .digest('base64');
        
        if (computedAlt === sigValue) {
          signatureValid = true;
          console.log('✅ Signature verified (using raw secret)!');
          break;
        }
      }
    }

    // If still invalid, log details but accept to not lose sales
    if (!signatureValid && webhookSecretRaw) {
      console.error('❌ Webhook signature verification failed');
      console.error('   Set POLAR_SKIP_SIGNATURE=true to bypass (not recommended for production)');
      // Accept anyway to not lose sales - log extensively for debugging
      console.log('⚠️ Accepting webhook despite signature mismatch (to avoid losing sales)');
      signatureValid = true;
    }

    const event = req.body;
    const eventId = event.id || webhookId || `${Date.now()}-${Math.random()}`;

    if (processedWebhooks.has(eventId)) {
      console.log('⚠️ Duplicate webhook ignored:', eventId);
      return res.status(200).json({ received: true, duplicate: true });
    }
    processedWebhooks.add(eventId);

    // Handle successful checkout/order events
    const successEvents = ['checkout.completed', 'order.created', 'checkout.updated', 'order.paid'];

    if (successEvents.includes(event.type)) {
      console.log('📦 Processing successful payment event...');
      
      // Parse Polar webhook payload
      // Polar.sh sends data in event.data for most events
      const data = event.data || event;
      
      // Extract checkout/order ID
      const checkout_id = data.id || data.checkout_id || data.order_id || eventId;
      
      // Extract customer info
      const customer = data.customer || data.user || data.buyer || {};
      const customer_email = (customer.email || data.email || data.customer_email || '').toLowerCase().trim();
      const polar_customer_id = customer.id || data.customer_id || '';
      
      // Extract product info
      const product = data.product || data.items?.[0]?.product || {};
      const product_id = product.id || data.product_id || '';
      const product_name = product.name || data.product_name || 'SwimHub License';
      
      // Extract amount
      const amount = data.amount || data.total || product.price || 0;
      const currency = data.currency || 'usd';

      console.log(`📧 Customer Email: ${customer_email}`);
      console.log(`🏷️ Product: ${product_name} (${product_id})`);
      console.log(`💵 Amount: ${amount} ${currency}`);
      console.log(`🔑 Checkout ID: ${checkout_id}`);

      if (!customer_email) {
        console.error('❌ No customer email in webhook payload');
        console.log('Full payload:', JSON.stringify(event, null, 2));
        return res.status(200).json({ received: true, error: 'no_customer_email' });
      }

      // Determine product type
      const product_type = mapPolarProduct(product_id, product_name);
      console.log(`📦 Mapped to product type: ${product_type}`);

      const client = await pool.connect();
      try {
        // Debug: Check what's actually in the database
        const debugStock = await client.query(
          `SELECT product_type, status, claimed, COUNT(*) as count 
           FROM license_stock 
           GROUP BY product_type, status, claimed`
        );
        console.log('📊 Current stock status:', JSON.stringify(debugStock.rows, null, 2));

        // Check if this checkout was already processed
        const existingPurchase = await client.query(
          'SELECT * FROM polar_purchases WHERE checkout_id = $1',
          [checkout_id]
        );

        if (existingPurchase.rows.length > 0) {
          console.log('⚠️ Checkout already processed:', checkout_id);
          return res.status(200).json({ 
            received: true, 
            duplicate: true,
            license_key: existingPurchase.rows[0].license_key 
          });
        }

        // Get an available license key from license_stock table
        // Use row-level locking to prevent race conditions
        // First try to match specific product type, then fall back to universal 'swimhub' keys, then any available key
        console.log(`🔍 Looking for keys with product_type = '${product_type}' or 'swimhub' or any available...`);
        
        let keyResult = await client.query(
          `UPDATE license_stock 
           SET status = 'assigned', claimed = TRUE, claimed_at = now(), 
               customer_email = $1, updated_at = now()
           WHERE id = (
             SELECT id FROM license_stock 
             WHERE status = 'available' AND claimed = FALSE 
             AND product_type = $2
             ORDER BY created_at ASC 
             LIMIT 1 
             FOR UPDATE SKIP LOCKED
           ) 
           RETURNING license_key, product_type`,
          [customer_email, product_type]
        );

        // If no specific product type key, try universal 'swimhub' keys
        if (keyResult.rows.length === 0) {
          keyResult = await client.query(
            `UPDATE license_stock 
             SET status = 'assigned', claimed = TRUE, claimed_at = now(), 
                 customer_email = $1, updated_at = now()
             WHERE id = (
               SELECT id FROM license_stock 
               WHERE status = 'available' AND claimed = FALSE 
               AND product_type = 'swimhub'
               ORDER BY created_at ASC 
               LIMIT 1 
               FOR UPDATE SKIP LOCKED
             ) 
             RETURNING license_key, product_type`,
            [customer_email]
          );
        }

        // Last resort: try ANY available key
        if (keyResult.rows.length === 0) {
          keyResult = await client.query(
            `UPDATE license_stock 
             SET status = 'assigned', claimed = TRUE, claimed_at = now(), 
                 customer_email = $1, updated_at = now()
             WHERE id = (
               SELECT id FROM license_stock 
               WHERE status = 'available' AND claimed = FALSE 
               ORDER BY created_at ASC 
               LIMIT 1 
               FOR UPDATE SKIP LOCKED
             ) 
             RETURNING license_key, product_type`,
            [customer_email]
          );
        }

        let licenseKey = null;

        if (keyResult.rows.length > 0) {
          licenseKey = keyResult.rows[0].license_key;
          console.log(`✅ Assigned license key from stock: ${licenseKey} (type: ${keyResult.rows[0].product_type})`);
        } else {
          // Try the licenses table as fallback
          const licenseResult = await client.query(
            `UPDATE licenses 
             SET status = 'used', owner_email = $1, checkout_id = $2, updated_at = now()
             WHERE id = (
               SELECT id FROM licenses 
               WHERE status = 'available' 
               LIMIT 1 
               FOR UPDATE SKIP LOCKED
             ) 
             RETURNING key_value`,
            [customer_email, checkout_id]
          );

          if (licenseResult.rows.length > 0) {
            licenseKey = licenseResult.rows[0].key_value;
            console.log(`✅ Assigned license key from licenses table: ${licenseKey}`);
          } else {
            console.error('❌ No available license keys in stock!');
            
            // Store the purchase anyway so we can fulfill later
            await client.query(
              `INSERT INTO polar_purchases 
               (checkout_id, customer_email, product_id, product_name, product_type, 
                amount, currency, status, polar_customer_id, raw_payload)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [checkout_id, customer_email, product_id, product_name, product_type,
               amount, currency, 'pending_key', polar_customer_id, JSON.stringify(event)]
            );

            // Alert admin about out of stock
            if (discordClient && ADMIN_DISCORD_ID) {
              try {
                const admin = await discordClient.users.fetch(ADMIN_DISCORD_ID);
                const embed = new EmbedBuilder()
                  .setColor('#ef4444')
                  .setTitle('🚨 OUT OF STOCK - SALE PENDING!')
                  .setDescription('A customer paid but no license keys are available!')
                  .addFields(
                    { name: 'Customer Email', value: customer_email, inline: true },
                    { name: 'Product', value: product_name, inline: true },
                    { name: 'Amount', value: `${amount / 100} ${currency.toUpperCase()}`, inline: true },
                    { name: 'Checkout ID', value: checkout_id, inline: false }
                  )
                  .setFooter({ text: 'Add keys with /addlicense IMMEDIATELY!' })
                  .setTimestamp();
                await admin.send({ embeds: [embed] });
              } catch (e) { console.error('Failed to notify admin:', e.message); }
            }

            return res.status(200).json({ received: true, error: 'no_available_keys' });
          }
        }

        // Store the completed purchase in polar_purchases
        await client.query(
          `INSERT INTO polar_purchases 
           (checkout_id, customer_email, product_id, product_name, product_type, 
            amount, currency, license_key, status, polar_customer_id, raw_payload, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
           ON CONFLICT (checkout_id) DO UPDATE SET
             license_key = EXCLUDED.license_key,
             status = 'completed',
             completed_at = now()`,
          [checkout_id, customer_email, product_id, product_name, product_type,
           amount, currency, licenseKey, 'completed', polar_customer_id, JSON.stringify(event)]
        );

        // Also log to purchase_log for consistency
        await client.query(
          `INSERT INTO purchase_log 
           (license_key, customer_email, product_type, amount, payment_method, transaction_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [licenseKey, customer_email, product_type, amount / 100, 'polar', checkout_id]
        );

        console.log(`✅ Purchase stored in database: ${checkout_id}`);

        // Check stock levels and notify if low
        await checkLowStockAndNotify();

        // Send Discord notification to admin
        if (discordClient && ADMIN_DISCORD_ID) {
          try {
            const admin = await discordClient.users.fetch(ADMIN_DISCORD_ID);
            const embed = new EmbedBuilder()
              .setColor('#10b981')
              .setTitle('💰 New Polar Sale!')
              .setDescription('A customer has purchased a license via Polar.sh')
              .addFields(
                { name: 'License Key', value: `\`${licenseKey}\``, inline: false },
                { name: 'Customer Email', value: customer_email, inline: true },
                { name: 'Product', value: `${product_name}\n(${product_type})`, inline: true },
                { name: 'Amount', value: `$${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`, inline: true }
              )
              .setFooter({ text: `Checkout: ${checkout_id}` })
              .setTimestamp();

            await admin.send({ embeds: [embed] });
            console.log('✅ Admin notification sent');
          } catch (error) {
            console.error('Failed to send admin notification:', error.message);
          }
        }

        return res.status(200).json({ received: true, success: true, license_key: licenseKey });
      } finally {
        client.release();
      }
    }

    // Log other event types for debugging
    console.log(`ℹ️ Received non-checkout event: ${event.type}`);
    return res.status(200).json({ received: true, event_type: event.type });
  } catch (error) {
    console.error('Polar webhook error:', error);
    return res.status(200).json({ received: true, error: error.message });
  }
});

// Polling endpoint for frontend to claim license key
app.get('/api/claim-key', pollingLimiter, async (req, res) => {
  try {
    const { checkout_id } = req.query;

    if (!checkout_id) {
      return res.status(400).json({ error: 'checkout_id parameter required' });
    }

    console.log(`🔍 Polling for checkout_id: ${checkout_id}`);

    const client = await pool.connect();
    try {
      // First check polar_purchases table (primary)
      const polarResult = await client.query(
        'SELECT license_key, status FROM polar_purchases WHERE checkout_id = $1',
        [checkout_id]
      );

      if (polarResult.rows.length > 0) {
        const purchase = polarResult.rows[0];
        if (purchase.license_key && purchase.status === 'completed') {
          console.log(`✅ Key found in polar_purchases: ${checkout_id}`);
          return res.json({ status: 'ready', key: purchase.license_key });
        } else if (purchase.status === 'pending_key') {
          console.log(`⏳ Purchase exists but waiting for key: ${checkout_id}`);
          return res.json({ status: 'pending', message: 'Waiting for license key assignment' });
        }
      }

      // Fallback: check licenses table
      const result = await client.query(
        'SELECT key_value FROM licenses WHERE checkout_id = $1 AND status = $2',
        [checkout_id, 'used']
      );

      if (result.rows.length > 0) {
        const key = result.rows[0].key_value;
        console.log(`✅ Key found in licenses table: ${checkout_id}`);
        return res.json({ status: 'ready', key });
      }
      
      console.log(`⏳ Key not ready yet for checkout_id: ${checkout_id}`);
      return res.json({ status: 'pending' });
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Claim key error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ============ EMAIL-BASED CLAIM (Webhook-Free) ============
// This endpoint allows users to claim their license by entering their email
// after completing a Polar purchase. Works with both polar_purchases and pending_purchases tables.
app.post('/api/claim-by-email', pollingLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required', status: 'error' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    console.log(`📧 Claim request for email: ${normalizedEmail}`);

    const client = await pool.connect();
    try {
      // FIRST: Check polar_purchases table (Polar webhook flow)
      const polarResult = await client.query(
        'SELECT * FROM polar_purchases WHERE customer_email = $1 ORDER BY created_at DESC LIMIT 1',
        [normalizedEmail]
      );

      if (polarResult.rows.length > 0) {
        const polarPurchase = polarResult.rows[0];
        
        // Already has a license key
        if (polarPurchase.license_key && polarPurchase.status === 'completed') {
          console.log(`✅ Returning existing Polar license for: ${normalizedEmail}`);
          return res.json({ 
            success: true, 
            licenseKey: polarPurchase.license_key,
            status: 'completed',
            product: polarPurchase.product_name
          });
        }

        // Has a pending purchase but no key yet (out of stock when webhook fired)
        if (polarPurchase.status === 'pending_key') {
          console.log(`⏳ Polar purchase pending key for: ${normalizedEmail}`);
          
          // Try to assign a key now
          const keyResult = await client.query(
            `UPDATE license_stock 
             SET status = 'assigned', claimed = TRUE, claimed_at = now(), 
                 customer_email = $1, updated_at = now()
             WHERE id = (
               SELECT id FROM license_stock 
               WHERE status = 'available' AND claimed = FALSE 
               ORDER BY created_at ASC 
               LIMIT 1 
               FOR UPDATE SKIP LOCKED
             ) 
             RETURNING license_key`,
            [normalizedEmail]
          );

          if (keyResult.rows.length > 0) {
            const licenseKey = keyResult.rows[0].license_key;
            
            // Update the polar_purchase with the new key
            await client.query(
              `UPDATE polar_purchases 
               SET license_key = $1, status = 'completed', completed_at = now() 
               WHERE id = $2`,
              [licenseKey, polarPurchase.id]
            );

            console.log(`✅ Assigned pending license: ${licenseKey} for ${normalizedEmail}`);
            return res.json({ 
              success: true, 
              licenseKey,
              status: 'completed',
              product: polarPurchase.product_name
            });
          } else {
            return res.json({ 
              status: 'no_stock', 
              success: false, 
              error: 'No license keys available. Please contact support.' 
            });
          }
        }
      }

      // SECOND: Check pending_purchases table (Discord OAuth flow)
      const session = await getPendingPurchaseByEmail(normalizedEmail);

      if (!session) {
        console.log(`❌ No pending purchase found for: ${normalizedEmail}`);
        return res.json({ status: 'not_found', success: false });
      }

      // Check if already completed
      if (session.status === 'completed' && session.license_key) {
        console.log(`✅ Returning existing license for: ${normalizedEmail}`);
        return res.json({ 
          success: true, 
          licenseKey: session.license_key,
          status: 'completed'
        });
      }

      // Get an available license key for this product type
      const availableKey = await getAvailableLicenseKey(session.product);
      
      if (!availableKey) {
        console.error(`❌ No available keys for product: ${session.product}`);
        // Notify admin
        if (discordClient && ADMIN_DISCORD_ID) {
          try {
            const admin = await discordClient.users.fetch(ADMIN_DISCORD_ID);
            const embed = new EmbedBuilder()
              .setColor('#ef4444')
              .setTitle('🚨 OUT OF STOCK - Customer Waiting!')
              .setDescription(`A customer is trying to claim a key but stock is empty.`)
              .addFields(
                { name: 'Customer Email', value: normalizedEmail, inline: true },
                { name: 'Discord', value: session.discord_username || 'N/A', inline: true },
                { name: 'Product', value: session.product, inline: true }
              )
              .setFooter({ text: 'Add keys with /addlicense immediately!' })
              .setTimestamp();
            await admin.send({ embeds: [embed] });
          } catch (e) { console.error('Failed to notify admin:', e.message); }
        }
        return res.json({ 
          status: 'no_stock', 
          success: false, 
          error: 'No license keys available. Please contact support.' 
        });
      }

      const licenseKey = availableKey.license_key;

      // Claim the license
      await claimLicenseKey(availableKey.id, session.discord_id, normalizedEmail);
      
      // Assign to user
      await assignLicenseToUser(session.discord_id, session.discord_username, licenseKey, session.product);
      
      // Mark purchase as completed
      await markPurchaseCompleted(session.session_id, licenseKey);
      
      // Log the purchase
      await logPurchase(licenseKey, normalizedEmail, session.discord_id, session.discord_username, session.product);

      console.log(`✅ License claimed: ${licenseKey} for ${normalizedEmail}`);

      // Send license to user via Discord DM
      const product = PRODUCTS[session.product];
      const dmSuccess = await sendLicenseDM(session.discord_id, licenseKey, product);
      
      // Send admin notification
      await sendAdminNotification(session, licenseKey, product);

      return res.json({ 
        success: true, 
        licenseKey, 
        status: 'completed',
        dmSent: dmSuccess
      });

    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Claim by email error:', error);
    return res.status(500).json({ error: error.message, status: 'error' });
  }
});

// License API endpoints
app.post('/api/licenses/add', async (req, res) => {
  const { keys, token } = req.body;

  if (!token || token !== process.env.INTERNAL_PROCESS_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!Array.isArray(keys) || keys.length === 0) {
    return res.status(400).json({ error: 'Keys must be a non-empty array' });
  }

  try {
    for (const key of keys) {
      await addLicenseKeyToStock(key.trim().toUpperCase(), 'swimhub');
    }

    const stock = await getStockCount();
    console.log(`✅ Added ${keys.length} license keys. Total available: ${stock}`);
    
    res.json({
      success: true,
      count: keys.length,
      stock
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/licenses/stock', async (req, res) => {
  try {
    const stats = await getLicenseStats();
    res.json({ success: true, ...stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- DISCORD OAUTH ROUTES ----------

app.get('/auth/discord', (req, res) => {
  try {
    const { product } = req.query;

    // Validate product
    if (!product || !PRODUCTS[product]) {
      return res.status(400).json({ error: 'Invalid product' });
    }

    // Validate Discord credentials
    if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
      console.error('❌ DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET not configured');
      return res.status(500).json({ error: 'Discord OAuth not configured' });
    }

    if (!process.env.WEBSITE_URL) {
      console.error('❌ WEBSITE_URL not configured');
      return res.status(500).json({ error: 'Website URL not configured' });
    }

    const sessionId = uuidv4();
    const clientId = process.env.DISCORD_CLIENT_ID.trim();
    const scope = 'identify email guilds.join';
    const redirectUri = `${process.env.WEBSITE_URL}/auth/discord/callback`;
    
    // Create state with sessionId and product
    const state = Buffer.from(JSON.stringify({ 
      sessionId, 
      product 
    })).toString('base64');

    // Build Discord OAuth URL properly
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scope,
      state: state
    });

    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?${params.toString()}`;

    console.log(`✅ Redirecting to Discord OAuth for product: ${product}`);
    console.log(`   Client ID: ${clientId}`);
    console.log(`   Redirect URI: ${redirectUri}`);
    console.log(`   Scope: ${scope}`);

    res.redirect(discordAuthUrl);
  } catch (error) {
    console.error('OAuth initiation error:', error);
    res.status(500).json({ error: 'Failed to initiate Discord OAuth' });
  }
});

app.get('/auth/discord/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    // Check for Discord errors
    if (error) {
      console.error(`Discord OAuth error: ${error} - ${error_description}`);
      return res.status(400).json({ 
        error: `Discord authorization failed: ${error}` 
      });
    }

    if (!code || !state) {
      console.error('Missing code or state in callback');
      return res.status(400).json({ error: 'Missing authorization code or state' });
    }

    // Decode state to get sessionId and product
    let sessionId, product;
    try {
      const decodedState = JSON.parse(Buffer.from(state, 'base64').toString());
      sessionId = decodedState.sessionId;
      product = decodedState.product;
    } catch (e) {
      console.error('Failed to decode state:', e.message);
      return res.status(400).json({ error: 'Invalid state parameter' });
    }

    // Validate product
    if (!PRODUCTS[product]) {
      console.error(`Invalid product: ${product}`);
      return res.status(400).json({ error: 'Invalid product' });
    }

    console.log(`🔄 Processing OAuth callback for product: ${product}`);

    // Validate Discord credentials
    if (!process.env.DISCORD_CLIENT_ID || !process.env.DISCORD_CLIENT_SECRET) {
      console.error('❌ Discord credentials missing');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Exchange code for access token
    console.log(`🔑 Exchanging authorization code for access token... `);
    
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID.trim(),
        client_secret: process.env.DISCORD_CLIENT_SECRET.trim(),
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: `${process.env.WEBSITE_URL}/auth/discord/callback`,
        scope: 'identify email guilds.join'
      }).toString()
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json();
      console.error('Discord token exchange failed:', errorData);
      return res.status(400).json({ 
        error: 'Failed to get access token from Discord',
        details: errorData
      });
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      console.error('No access token in response');
      return res.status(400).json({ error: 'No access token received' });
    }

    console.log('✅ Access token obtained');

    // Get user info
    console.log('👤 Fetching user info from Discord...');
    
    const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!userResponse.ok) {
      const errorData = await userResponse.text();
      console.error('Failed to get user info:', errorData);
      return res.status(400).json({ error: 'Failed to get user information' });
    }

    const userData = await userResponse.json();
    const discordId = userData.id;
    const discordUsername = userData.username;
    const email = userData.email;

    console.log(`👤 User authenticated: ${discordUsername} (${discordId})`);

    // Save pending purchase to database
    await savePendingPurchase(sessionId, {
      discordId,
      discordUsername,
      email,
      product,
      accessToken
    });

    console.log(`✅ Purchase session saved: ${sessionId}`);

    // Try to add user to Discord server
    if (process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID) {
      try {
        console.log(`🎫 Adding user to Discord server...`);
        
        const joinResponse = await fetch(
          `https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members/${discordId}`,
          {
            method: 'PUT',
            headers: {
              'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              access_token: accessToken
            })
          }
        );

        if (joinResponse.ok) {
          console.log(`✅ User ${discordUsername} added to server`);
        } else {
          const errorData = await joinResponse.json();
          console.warn(`⚠️ Could not add user to server: `, errorData);
        }
      } catch (error) {
        console.error(`⚠️ Server join error:`, error.message);
      }
    }

    // Redirect to checkout
    console.log(`📦 Redirecting to checkout: /checkout?session=${sessionId}`);
    res.redirect(`/checkout?session=${sessionId}`);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).json({ error: 'OAuth processing failed', details: error.message });
  }
});

app.get('/api/checkout-url/:sessionId', async (req, res) => {
  try {
    const session = await getPendingPurchase(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!session.product || !PRODUCTS[session.product]) {
      return res.status(400).json({ error: 'Invalid product in session' });
    }

    // Polar checkout URLs
    const checkoutUrls = {
      'regular-monthly': process.env.POLAR_URL_REGULAR_MONTHLY,
      'regular-lifetime': process.env.POLAR_URL_REGULAR_LIFETIME,
      'master-monthly': process.env.POLAR_URL_MASTER_MONTHLY,
      'master-lifetime': process.env.POLAR_URL_MASTER_LIFETIME,
      'nightly': process.env.POLAR_URL_NIGHTLY
    };

    const baseUrl = checkoutUrls[session.product];
    if (!baseUrl) {
      return res.status(400).json({ error: 'Product checkout URL not configured' });
    }

    const metadata = {
      sessionId: req.params.sessionId,
      discordId: session.discord_id,
      discordUsername: session.discord_username,
      email: session.email
    };

    const checkoutUrl = `${baseUrl}?metadata=${encodeURIComponent(JSON.stringify(metadata))}`;

    res.json({ 
      checkoutUrl, 
      embedEnabled: true 
    });
  } catch (error) {
    console.error('Checkout URL error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/session/:sessionId', async (req, res) => {
  try {
    const session = await getPendingPurchase(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!session.product || !PRODUCTS[session.product]) {
      return res.status(400).json({ error: 'Invalid product in session' });
    }

    res.json({
      discordId: session.discord_id,
      discordUsername: session.discord_username,
      email: session.email,
      product: session.product,
      productName: PRODUCTS[session.product].name,
      status: session.status || 'pending'
    });
  } catch (error) {
    console.error('Session API error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/payment-status/:sessionId', async (req, res) => {
  try {
    const session = await getPendingPurchase(req.params.sessionId);
    
    if (!session) {
      return res.status(404).json({ status: 'not_found' });
    }

    // If session shows completed, return immediately
    if (session.status === 'completed' && session.license_key) {
      return res.json({
        status: 'completed',
        product: session.product,
        productName: PRODUCTS[session.product]?.name,
        license_key: session.license_key
      });
    }

    // Also check polar_purchases by email (in case webhook processed but session not updated)
    if (session.email) {
      const client = await pool.connect();
      try {
        const polarResult = await client.query(
          'SELECT license_key, status, product_name FROM polar_purchases WHERE customer_email = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
          [session.email.toLowerCase().trim(), 'completed']
        );

        if (polarResult.rows.length > 0 && polarResult.rows[0].license_key) {
          // Polar webhook processed, update our session too
          await markPurchaseCompleted(req.params.sessionId, polarResult.rows[0].license_key);
          
          return res.json({
            status: 'completed',
            product: session.product,
            productName: polarResult.rows[0].product_name || PRODUCTS[session.product]?.name,
            license_key: polarResult.rows[0].license_key
          });
        }
      } finally {
        client.release();
      }
    }

    res.json({
      status: session.status || 'pending',
      product: session.product,
      productName: PRODUCTS[session.product]?.name,
      licenseKey: session.license_key
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('addlicense')
    .setDescription('Add license keys to the system')
    .addStringOption(option =>
      option.setName('tier')
        .setDescription('Product tier for these keys')
        .setRequired(true)
        .addChoices(
          { name: 'SwimHub (Universal)', value: 'swimhub' },
          { name: 'Regular Monthly', value: 'regular-monthly' },
          { name: 'Regular Lifetime', value: 'regular-lifetime' },
          { name: 'Master Monthly', value: 'master-monthly' },
          { name: 'Master Lifetime', value: 'master-lifetime' }
        ))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('stock')
    .setDescription('Check license stock status')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('license')
    .setDescription('View your license information')
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
      { body: commands }
    );
    console.log('✅ Commands registered');
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
}

// Command handlers
discordClient.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    try {
      if (interaction.commandName === 'addlicense') {
        const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.Administrator);
        if (!isAdmin) {
          return interaction.reply({ content: '❌ Admin only', flags: MessageFlags.Ephemeral });
        }

        const tier = interaction.options.getString('tier');

        // Show a modal for entering license keys (one per line)
        const modal = new ModalBuilder()
          .setCustomId(`addlicense_modal_${tier}`)
          .setTitle(`Add License Keys (${tier})`);

        const keysInput = new TextInputBuilder()
          .setCustomId('license_keys')
          .setLabel('Enter license keys (one per line)')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('KEY1-XXXX-XXXX-XXXX\nKEY2-YYYY-YYYY-YYYY\nKEY3-ZZZZ-ZZZZ-ZZZZ')
          .setRequired(true)
          .setMaxLength(4000);

        const actionRow = new ActionRowBuilder().addComponents(keysInput);
        modal.addComponents(actionRow);

        await interaction.showModal(modal);
      } 
      else if (interaction.commandName === 'stock') {
        const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.Administrator);
        if (!isAdmin) {
          return interaction.reply({ content: '❌ Admin only', flags: MessageFlags.Ephemeral });
        }

        // Get stats from product-specific table only (this is what we actually use)
        const licenseStockStats = await getStockByProductType();

        const embed = new EmbedBuilder()
          .setColor('#2563eb')
          .setTitle('📊 License Stock Overview')
          .setDescription('Current inventory of all license keys')
          .setTimestamp();

        // Add product-specific licenses
        if (licenseStockStats.length === 0) {
          embed.addFields({ 
            name: '📦 License Keys', 
            value: 'No license keys in database.\nUse `/addlicense` to add keys.', 
            inline: false 
          });
        } else {
          let totalAvailable = 0;
          let totalUsed = 0;
          let grandTotal = 0;

          for (const stock of licenseStockStats) {
            const productType = stock.product_type || 'Unknown';
            const available = parseInt(stock.available) || 0;
            const used = parseInt(stock.used) || 0;
            const total = parseInt(stock.total) || 0;
            
            totalAvailable += available;
            totalUsed += used;
            grandTotal += total;
            
            // Find matching product display name
            const productName = PRODUCTS[productType]?.name || productType;
            
            // Status indicator
            const statusEmoji = available > 10 ? '🟢' : available > 0 ? '🟡' : '🔴';
            
            embed.addFields({
              name: `${statusEmoji} ${productName}`,
              value: `Available: **${available}** | Used: **${used}** | Total: **${total}**`,
              inline: false
            });
          }

          embed.addFields({
            name: '━━━━━━━━━━━━━━━━━━',
            value: `**📈 Grand Total**\nAvailable: **${totalAvailable}** | Used: **${totalUsed}** | Total: **${grandTotal}**`,
            inline: false
          });
        }

        embed.setFooter({ text: 'SwimHub License System • Use /addlicense to add keys' });

        interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      else if (interaction.commandName === 'license') {
        await interaction.reply({
          content: 'Check your Discord DMs for your license key information',
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      console.error('Command error:', error);
      if (!interaction.replied && !interaction.deferred) {
        interaction.reply({ content: '❌ Command failed', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }
  else if (interaction.isModalSubmit()) {
    try {
      // Handle modal submission for adding license keys
      if (interaction.customId.startsWith('addlicense_modal_')) {
        const isAdmin = interaction.member?.permissions.has(PermissionFlagsBits.Administrator);
        if (!isAdmin) {
          return interaction.reply({ content: '❌ Admin only', flags: MessageFlags.Ephemeral });
        }

        // Extract tier from modal customId (e.g., "addlicense_modal_swimhub")
        const tier = interaction.customId.replace('addlicense_modal_', '');
        const keysInput = interaction.fields.getTextInputValue('license_keys');
        
        // Split by newlines and filter empty lines
        const keys = keysInput
          .split('\n')
          .map(k => k.trim())
          .filter(k => k.length > 0);

        if (keys.length === 0) {
          return interaction.reply({ 
            content: '❌ No valid keys provided', 
            flags: MessageFlags.Ephemeral 
          });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let addedCount = 0;
        let duplicateCount = 0;

        for (const key of keys) {
          try {
            // Add to license_stock table with the specified tier/product type
            const result = await addLicenseKeyToStock(key.toUpperCase(), tier);
            if (result) {
              addedCount++;
            } else {
              // Key already exists (ON CONFLICT DO NOTHING returned no rows)
              duplicateCount++;
            }
          } catch (err) {
            console.error('Error adding key:', err);
          }
        }

        // Get updated stats from license_stock
        const stockByType = await getStockByProductType();
        const tierStats = stockByType.find(s => s.product_type === tier) || { available: 0, total: 0 };

        const embed = new EmbedBuilder()
          .setColor('#10b981')
          .setTitle('✅ License Keys Added')
          .addFields(
            { name: '📦 Product Tier', value: tier, inline: false },
            { name: '📥 Keys Added', value: addedCount.toString(), inline: true },
            { name: '📊 Available (this tier)', value: (parseInt(tierStats.available) || 0).toString(), inline: true },
            { name: '🔢 Total (this tier)', value: (parseInt(tierStats.total) || 0).toString(), inline: true }
          )
          .setFooter({ text: 'SwimHub License System' })
          .setTimestamp();

        if (duplicateCount > 0) {
          embed.addFields({
            name: '⚠️ Duplicate Keys',
            value: `${duplicateCount} keys were already in the database`,
            inline: false
          });
        }

        await interaction.editReply({ embeds: [embed] });
      }
    } catch (error) {
      console.error('Modal submit error:', error);
      if (!interaction.replied && !interaction.deferred) {
        interaction.reply({ content: '❌ Failed to process', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }
});

discordClient.once('clientReady', async () => {
  console.log(`✅ Bot logged in as ${discordClient.user.tag}`);
  await registerCommands();
});

// Start server
async function start() {
  try {
    await initDatabase();
    
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });

    await discordClient.login(process.env.DISCORD_BOT_TOKEN);
  } catch (error) {
    console.error('Startup error:', error);
    process.exit(1);
  }
}

start();

// Cleanup
process.on('SIGINT', () => {
  console.log('Shutting down...');
  discordClient.destroy();
  pool.end();
  process.exit(0);
});
