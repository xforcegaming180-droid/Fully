# Polar.sh Integration Setup Guide

## Overview

This system integrates with Polar.sh to automatically deliver license keys to customers after purchase. When a customer buys from Polar.sh, all data flows through your Railway PostgreSQL database.

### Purchase Flow

```
Customer → Polar.sh → Webhook → Your Server → PostgreSQL → License Key
                                     ↓
                            Discord DM to Admin
```

1. Customer completes purchase on Polar.sh
2. Polar sends webhook to `https://your-railway-url.up.railway.app/webhook/polar`
3. Server parses payment data and stores in `polar_purchases` table
4. Server assigns an available license key from `license_stock` table
5. Customer enters their email on success page to retrieve key
6. Admin receives Discord notification with purchase details

## Database Tables

The server automatically creates these tables on startup:

### `polar_purchases` - Stores all Polar webhook data
```sql
-- Created automatically - stores every purchase from Polar
polar_purchases (
  id, checkout_id, customer_email, product_id, product_name, 
  product_type, amount, currency, license_key, status, 
  discord_id, polar_customer_id, raw_payload, created_at, completed_at
)
```

### `license_stock` - Your license key inventory
```sql
-- Add keys here via /addlicense Discord command
license_stock (
  id, license_key, product_type, status, claimed, 
  claimed_by, claimed_at, customer_email, created_at
)
```

### `purchase_log` - Transaction history
```sql
-- Auto-populated when sales complete
purchase_log (
  id, license_key, customer_email, customer_discord_id,
  product_type, amount, payment_method, transaction_id, purchase_date
)
```

## Environment Variables

Add these to your Railway environment:

```bash
# PostgreSQL (Railway provides this automatically)
DATABASE_URL=postgresql://user:password@host:port/database

# Discord Bot
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_CLIENT_SECRET=your_discord_client_secret
DISCORD_GUILD_ID=your_discord_server_id
ADMIN_DISCORD_ID=your_discord_user_id

# Polar.sh Webhook
POLAR_WEBHOOK_SECRET=your_polar_webhook_secret
POLAR_SKIP_SIGNATURE=false  # Only set true for testing

# Server
PORT=3000
WEBSITE_URL=https://your-railway-url.up.railway.app
```

## Polar.sh Dashboard Setup

### 1. Create Products

In Polar.sh dashboard, create your products. The system auto-maps products by name:

| Product Name Contains | Maps To |
|----------------------|---------|
| "master" + "lifetime" | `master-lifetime` |
| "master" + "monthly" | `master-monthly` |
| "regular" + "lifetime" | `regular-lifetime` |
| "regular" + "monthly" | `regular-monthly` |

Or configure exact mappings in `server/index.js`:
```javascript
const POLAR_PRODUCT_MAP = {
  'prod_abc123': 'regular-monthly',
  'prod_def456': 'regular-lifetime',
  'prod_ghi789': 'master-monthly',
  'prod_jkl012': 'master-lifetime',
};
```

### 2. Set Up Webhook

In your Polar.sh dashboard:

1. Go to **Settings → Webhooks**
2. Click "Add Webhook"
3. Enter webhook URL: `https://your-railway-url.up.railway.app/webhook/polar`
4. Copy the webhook secret and add to Railway as `POLAR_WEBHOOK_SECRET`
5. Enable these events:
   - `checkout.completed` ✅
   - `order.created` ✅
   - `order.paid` ✅

### 3. Configure Success URL

Set your Polar product's success URL to:
```
https://your-railway-url.up.railway.app/success.html
```

The customer will enter their email to claim their key (no checkout_id in URL needed).

## How It Works

### When Polar Webhook Fires:

1. **Webhook received** at `/webhook/polar`
2. **Signature verified** (using `POLAR_WEBHOOK_SECRET`)
3. **Data extracted**:
   - Customer email
   - Product ID & name
   - Payment amount
   - Checkout ID
4. **Product mapped** to internal type (regular/master, monthly/lifetime)
5. **License key assigned** from `license_stock` table
6. **Purchase stored** in `polar_purchases` table
7. **Admin notified** via Discord DM

### When Customer Claims Key:

1. Customer visits `/success.html`
2. Enters email used for payment
3. Server checks `polar_purchases` table
4. Returns license key if found

## API Endpoints

### POST /webhook/polar
Receives webhooks from Polar.sh when purchases are completed.

**What it does:**
- Verifies webhook signature
- Extracts customer email, product, amount from payload
- Assigns license key from `license_stock`
- Stores everything in `polar_purchases`
- Notifies admin via Discord

### POST /api/claim-by-email
Customer claims their license key using email.

**Request:**
```json
{ "email": "customer@example.com" }
```

**Response (success):**
```json
{
  "success": true,
  "licenseKey": "XXXXX-XXXXX-XXXXX",
  "status": "completed"
}
```

### GET /api/claim-key?checkout_id=xxx
Polling endpoint (alternative to email claim).

**Response:**
```json
{ "status": "ready", "key": "XXXXX-XXXXX-XXXXX" }
```

## Adding License Keys

Use the Discord bot `/addlicense` command:

```
/addlicense key:XXXXX-XXXXX-XXXXX tier:swimhub
```

Or add directly to database:
```sql
INSERT INTO license_stock (license_key, product_type, status) 
VALUES ('YOUR-KEY-HERE', 'swimhub', 'available');
```

## Viewing Sales Data

### In PostgreSQL (Railway):

```sql
-- View all purchases
SELECT * FROM polar_purchases ORDER BY created_at DESC;

-- View today's sales
SELECT * FROM polar_purchases WHERE created_at >= CURRENT_DATE;

-- Count sales by product
SELECT product_type, COUNT(*) FROM polar_purchases GROUP BY product_type;

-- View stock levels
SELECT 
  product_type,
  COUNT(*) FILTER (WHERE status = 'available' AND claimed = FALSE) as available,
  COUNT(*) FILTER (WHERE claimed = TRUE) as sold
FROM license_stock GROUP BY product_type;
```

### Via Discord Bot:

```
/stock - View current inventory levels
```

## Troubleshooting

### Webhook not receiving data

1. Check Railway logs: `railway logs`
2. Verify webhook URL is correct
3. Test webhook health: `GET https://your-url/webhook/polar`
4. Set `POLAR_SKIP_SIGNATURE=true` temporarily to debug

### No license keys available

1. Check stock: `SELECT * FROM license_stock WHERE status = 'available'`
2. Add keys via `/addlicense` command
3. Bot will DM admin when out of stock

### Customer can't claim key

1. Check email matches exactly (lowercase)
2. Query: `SELECT * FROM polar_purchases WHERE customer_email = 'email@example.com'`
3. Check status column - should be 'completed'

## Frontend Integration

The `success.html` page automatically:

1. Extracts `checkout_id` from URL parameters
2. Polls `/api/claim-key` every 2 seconds
3. Displays the license key when ready
4. Shows a loading spinner while waiting
5. Times out after 2 minutes with error message

### Example URL
```
https://your-domain.com/success.html?checkout_id=checkout_abc123
```

## Security Features

1. **Webhook Signature Verification**: Uses HMAC-SHA256 with rawBody
2. **Rate Limiting**: Prevents abuse of API endpoints
3. **Row-Level Locking**: Prevents race conditions when assigning keys (FOR UPDATE SKIP LOCKED)
4. **SQL Injection Prevention**: All queries use parameterized statements
5. **Duplicate Prevention**: Webhook event IDs are tracked to prevent duplicate processing

## Troubleshooting

### "Invalid Polar webhook signature"

**Causes:**
- Webhook secret mismatch
- Request body modified before verification
- Missing rawBody middleware

**Solutions:**
1. Verify `POLAR_WEBHOOK_SECRET` matches Polar dashboard
2. Check that no middleware modifies the request body before the webhook handler
3. Set `POLAR_SKIP_SIGNATURE=true` temporarily to bypass (dev only!)

### Keys not appearing on frontend

**Causes:**
- No `checkout_id` in URL
- No available keys in database
- Webhook not processed successfully

**Solutions:**
1. Check browser console for errors
2. Verify URL has `?checkout_id=...` parameter
3. Check server logs for webhook processing
4. Verify database has keys with `status='available'`

```sql
-- Check available keys
SELECT COUNT(*) FROM licenses WHERE status='available';

-- Check if specific checkout has a key
SELECT * FROM licenses WHERE checkout_id='your_checkout_id';
```

### No Discord notification

**Causes:**
- Bot not logged in
- Invalid `ADMIN_DISCORD_ID`
- Bot lacks DM permissions

**Solutions:**
1. Check server logs for Discord login success
2. Verify `ADMIN_DISCORD_ID` is your actual Discord user ID
3. Ensure bot can send DMs (check Privacy Settings)

## Testing

### Test Webhook Locally

```bash
# Generate test signature
SECRET="your_webhook_secret"
PAYLOAD='{"type":"checkout.completed","id":"test","data":{"id":"checkout_test","customer":{"email":"test@example.com"}}}'
TIMESTAMP=$(date +%s)
SIGNATURE=$(echo -n "${TIMESTAMP}.${PAYLOAD}" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)

# Send test webhook
curl -X POST http://localhost:3000/webhook/polar \
  -H "Content-Type: application/json" \
  -H "webhook-signature: v1,${SIGNATURE}" \
  -H "webhook-timestamp: ${TIMESTAMP}" \
  -d "$PAYLOAD"
```

### Test Polling Endpoint

```bash
# Check if key is ready (should return pending if no webhook processed yet)
curl "http://localhost:3000/api/claim-key?checkout_id=checkout_test"
```

## Production Deployment

### Environment Variables Checklist
- [ ] `DATABASE_URL` configured
- [ ] `DISCORD_BOT_TOKEN` set
- [ ] `DISCORD_CLIENT_ID` set
- [ ] `DISCORD_CLIENT_SECRET` set
- [ ] `DISCORD_GUILD_ID` set
- [ ] `ADMIN_DISCORD_ID` set
- [ ] `POLAR_WEBHOOK_SECRET` set
- [ ] `POLAR_SKIP_SIGNATURE` set to `false`
- [ ] `WEBSITE_URL` set to your domain
- [ ] `PORT` set (if not using default 3000)

### Pre-launch Tasks
1. Add initial license keys to database
2. Test webhook with Polar test mode
3. Verify Discord notifications work
4. Test full purchase flow end-to-end
5. Set up monitoring/logging
6. Configure HTTPS/SSL certificate

## Monitoring

Key metrics to monitor:
- Available license key count
- Webhook success/failure rate
- Average time from purchase to key delivery
- Rate limit violations
- Database connection pool status

## Support

For issues related to:
- **Polar.sh**: Contact Polar support
- **Discord bot**: Check Discord.js documentation
- **Database**: Check PostgreSQL logs
- **Server**: Check application logs with `pm2 logs` or `docker logs`
