# 🏊 SwimHub Complete Setup Guide

## Table of Contents
1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Part 1: Discord Bot Setup](#part-1-discord-bot-setup)
4. [Part 2: Polar.sh Payment Setup](#part-2-polarsh-payment-setup)
5. [Part 3: Database Setup](#part-3-database-setup)
6. [Part 4: Server Deployment](#part-4-server-deployment)
7. [Part 5: Managing License Keys](#part-5-managing-license-keys)
8. [Part 6: Testing the Flow](#part-6-testing-the-flow)
9. [Troubleshooting](#troubleshooting)

---

## Overview

### Your 4 Products
| Product | Price | Duration |
|---------|-------|----------|
| SwimHub Regular Monthly | $3.50 | 30 days |
| SwimHub Regular Lifetime | $7.00 | Forever |
| SwimHub Master Monthly | $7.00 | 30 days |
| SwimHub Master Lifetime | $15.00 | Forever |

### How the Purchase Flow Works
```
Customer clicks "Purchase" → Discord OAuth → Checkout page → Polar.sh payment
    ↓
Polar sends webhook → Server assigns license key → Key stored with checkout_id
    ↓
Customer redirected to success page → Page polls server → License key displayed
    ↓
Admin receives Discord DM notification
```

---

## Prerequisites

You'll need accounts on:
- [GitHub](https://github.com) - for code hosting
- [Discord Developer Portal](https://discord.com/developers) - for the bot
- [Polar.sh](https://polar.sh) - for payments
- [Railway](https://railway.app) - for hosting (or any Node.js host)
- [PostgreSQL Database](https://railway.app) - Railway provides this free

---

## Part 1: Discord Bot Setup

### Step 1.1: Create Discord Application

1. Go to **https://discord.com/developers/applications**
2. Click **"New Application"** (blue button, top right)
3. Name it: `SwimHub`
4. Click **Create**

### Step 1.2: Get OAuth2 Credentials

1. In left sidebar → **OAuth2** → **General**
2. Copy the **Client ID** → Save as `DISCORD_CLIENT_ID`
3. Under **Client Secret** → Click **Reset Secret**
4. Copy the secret → Save as `DISCORD_CLIENT_SECRET`

### Step 1.3: Create the Bot

1. Left sidebar → **Bot**
2. Click **"Add Bot"** → **"Yes, do it!"**
3. Under the bot username → Click **"Reset Token"**
4. Copy the token → Save as `DISCORD_BOT_TOKEN`

### Step 1.4: Configure Bot Settings

On the **Bot** page, configure:

| Setting | Value |
|---------|-------|
| Public Bot | ❌ OFF |
| Server Members Intent | ✅ ON |
| Message Content Intent | ✅ ON |

### Step 1.5: Invite Bot to Your Server

1. Left sidebar → **OAuth2** → **URL Generator**
2. Under **Scopes**, check:
   - ✅ `bot`
   - ✅ `applications.commands`
3. Under **Bot Permissions**, check:
   - ✅ Send Messages
   - ✅ Embed Links
   - ✅ Read Message History
4. Copy the **Generated URL**
5. Open it in browser → Select your server → **Authorize**

### Step 1.6: Get Discord IDs

**Enable Developer Mode:**
1. Discord → Settings (gear) → App Settings → Advanced
2. Turn on **Developer Mode**

**Get IDs:**
- **Server ID:** Right-click server icon → **Copy Server ID** → Save as `DISCORD_GUILD_ID`
- **Your User ID:** Right-click your name → **Copy User ID** → Save as `ADMIN_DISCORD_ID`

---

## Part 2: Polar.sh Payment Setup

### Step 2.1: Create Polar Account

1. Go to [polar.sh](https://polar.sh)
2. Sign up / Log in
3. Create an organization for SwimHub

### Step 2.2: Create 4 Products

Create these products in Polar:

| Product Name | Price | Type |
|--------------|-------|------|
| SwimHub Regular Monthly | $3.50 | One-time |
| SwimHub Regular Lifetime | $7.00 | One-time |
| SwimHub Master Monthly | $7.00 | One-time |
| SwimHub Master Lifetime | $15.00 | One-time |

### Step 2.3: Get Checkout URLs

For each product:
1. Go to product settings
2. Copy the checkout URL
3. Save as environment variables:

```
POLAR_URL_REGULAR_MONTHLY=https://polar.sh/checkout/xxxxxx
POLAR_URL_REGULAR_LIFETIME=https://polar.sh/checkout/xxxxxx
POLAR_URL_MASTER_MONTHLY=https://polar.sh/checkout/xxxxxx
POLAR_URL_MASTER_LIFETIME=https://polar.sh/checkout/xxxxxx
```

### Step 2.4: Configure Success URL

For **each product** in Polar:
1. Go to product → Edit → Success URL
2. Set to: `https://YOUR-DOMAIN.com/success.html?checkout_id={{CHECKOUT_ID}}`

**⚠️ Replace `YOUR-DOMAIN.com` with your actual domain!**

### Step 2.5: Set Up Webhook

1. In Polar dashboard → Webhooks
2. Add new webhook:
   - **URL:** `https://YOUR-DOMAIN.com/webhook/polar`
   - **Events:** Enable all:
     - ✅ `checkout.completed`
     - ✅ `order.created`
     - ✅ `checkout.updated`
     - ✅ `payment.success`
3. Copy the **Webhook Secret** → Save as `POLAR_WEBHOOK_SECRET`

---

## Part 3: Database Setup

### Option A: Railway PostgreSQL (Recommended)

1. Go to [Railway](https://railway.app)
2. Create new project
3. Add PostgreSQL service
4. Copy the connection string → Save as `DATABASE_URL`

Format: `postgresql://user:password@host:port/database`

### Option B: Any PostgreSQL Host

Use any PostgreSQL provider (Supabase, Neon, etc.) and get the connection string.

---

## Part 4: Server Deployment

### Step 4.1: Create Environment File

Create `.env` file in the `server` folder:

```env
# ===========================================
# SWIMHUB CONFIGURATION
# ===========================================

# Database
DATABASE_URL=postgresql://user:password@host:port/database

# Discord Bot
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_client_id_here
DISCORD_CLIENT_SECRET=your_client_secret_here
DISCORD_GUILD_ID=your_server_id_here
ADMIN_DISCORD_ID=your_user_id_here

# Polar.sh Payments
POLAR_WEBHOOK_SECRET=your_webhook_secret_here
POLAR_SKIP_SIGNATURE=false

# Polar Product URLs
POLAR_URL_REGULAR_MONTHLY=https://polar.sh/checkout/xxxxx
POLAR_URL_REGULAR_LIFETIME=https://polar.sh/checkout/xxxxx
POLAR_URL_MASTER_MONTHLY=https://polar.sh/checkout/xxxxx
POLAR_URL_MASTER_LIFETIME=https://polar.sh/checkout/xxxxx

# Server Settings
PORT=3000
WEBSITE_URL=https://your-domain.com

# Internal Token (generate a random string)
INTERNAL_PROCESS_TOKEN=generate-a-random-secure-string-here

# Alert Settings
LOW_STOCK_THRESHOLD=10
```

### Step 4.2: Deploy to Railway

**Option A: GitHub Integration (Recommended)**

1. Push your code to GitHub
2. In Railway → New Project → Deploy from GitHub repo
3. Add all environment variables from above
4. Railway will auto-detect Node.js and deploy

**Option B: Railway CLI**

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize project
cd server
railway init

# Deploy
railway up

# Add environment variables
railway variables set DATABASE_URL="your_url"
railway variables set DISCORD_BOT_TOKEN="your_token"
# ... add all variables
```

### Step 4.3: Get Your Domain

After deploying:
1. Railway → Your project → Settings → Generate Domain
2. Copy the URL (e.g., `https://swimhub.up.railway.app`)
3. Update:
   - `WEBSITE_URL` in Railway
   - Polar webhook URL
   - Polar success URLs

---

## Part 5: Managing License Keys

### Method 1: Discord Bot Commands (Recommended)

Your Discord bot has these admin commands:

#### `/addlicense` - Add License Keys
1. Type `/addlicense` in your Discord server
2. A popup modal appears
3. Paste your license keys (one per line):
   ```
   SWIM-XXXX-XXXX-XXXX
   SWIM-YYYY-YYYY-YYYY
   SWIM-ZZZZ-ZZZZ-ZZZZ
   ```
4. Click Submit
5. Keys are added to the database!

#### `/stock` - Check Inventory
1. Type `/stock` in Discord
2. See current inventory:
   - Available keys
   - Used keys
   - Total keys

### Method 2: API Endpoint

```bash
curl -X POST https://your-domain.com/api/licenses/add \
  -H "Content-Type: application/json" \
  -d '{
    "keys": ["KEY1-XXXX-XXXX", "KEY2-YYYY-YYYY"],
    "token": "your_INTERNAL_PROCESS_TOKEN"
  }'
```

### Method 3: Direct Database

```sql
-- Add a single key
INSERT INTO licenses (key_value, status) VALUES ('SWIM-XXXX-XXXX-XXXX', 'available');

-- Add multiple keys
INSERT INTO licenses (key_value, status) VALUES 
  ('SWIM-0001-AAAA-BBBB', 'available'),
  ('SWIM-0002-CCCC-DDDD', 'available'),
  ('SWIM-0003-EEEE-FFFF', 'available');

-- Check stock
SELECT status, COUNT(*) FROM licenses GROUP BY status;
```

---

## Part 6: Testing the Flow

### Step 6.1: Add Test Keys

Use `/addlicense` in Discord to add a few test keys.

### Step 6.2: Test Purchase Flow

1. Go to your website → Click "Purchase"
2. Select a product (e.g., Regular Monthly)
3. Authorize with Discord
4. Complete a test payment on Polar
5. Verify:
   - ✅ Redirected to success page
   - ✅ License key appears after a few seconds
   - ✅ Admin receives Discord DM notification

### Step 6.3: Verify Webhook

Check your server logs for:
```
=== POLAR WEBHOOK RECEIVED ===
✅ Signature verified
📦 Processing checkout: checkout_xxx for user@email.com
✅ Assigned license key: SWIM-XXXX-XXXX-XXXX
✅ Admin notification sent
```

---

## Troubleshooting

### "Invalid Polar webhook signature"

**Causes:**
- Wrong webhook secret
- Body modified before verification

**Fix:**
1. Copy webhook secret from Polar exactly
2. Ensure no extra spaces
3. For testing only: Set `POLAR_SKIP_SIGNATURE=true`

### License key not showing on success page

**Check:**
1. Is `checkout_id` in the URL? → `success.html?checkout_id=xxx`
2. Are there available keys? → Use `/stock` command
3. Check browser console for errors

**Fix:**
```sql
-- Verify key was assigned
SELECT * FROM licenses WHERE checkout_id = 'your_checkout_id';
```

### Discord bot not responding

**Check:**
1. Is bot online? Check server member list
2. Are commands registered? May take up to 1 hour
3. Check logs: `railway logs`

**Fix:**
```bash
# Force re-register commands by restarting
railway restart
```

### No Discord notification

**Check:**
1. `ADMIN_DISCORD_ID` is correct
2. Bot can send you DMs (privacy settings)
3. Bot has correct permissions

---

## Quick Reference

### Environment Variables Checklist

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection | `postgresql://...` |
| `DISCORD_BOT_TOKEN` | Bot token from Discord dev portal | `MTIzNDU...` |
| `DISCORD_CLIENT_ID` | Application client ID | `1234567890` |
| `DISCORD_CLIENT_SECRET` | OAuth2 client secret | `aBcDeFg...` |
| `DISCORD_GUILD_ID` | Your server ID | `9876543210` |
| `ADMIN_DISCORD_ID` | Your user ID for notifications | `1111111111` |
| `POLAR_WEBHOOK_SECRET` | From Polar webhook settings | `whsec_...` |
| `POLAR_URL_REGULAR_MONTHLY` | Checkout URL | `https://polar.sh/checkout/...` |
| `POLAR_URL_REGULAR_LIFETIME` | Checkout URL | `https://polar.sh/checkout/...` |
| `POLAR_URL_MASTER_MONTHLY` | Checkout URL | `https://polar.sh/checkout/...` |
| `POLAR_URL_MASTER_LIFETIME` | Checkout URL | `https://polar.sh/checkout/...` |
| `WEBSITE_URL` | Your deployed domain | `https://swimhub.up.railway.app` |
| `PORT` | Server port | `3000` |
| `INTERNAL_PROCESS_TOKEN` | Random secret for API | `random-string-here` |
| `LOW_STOCK_THRESHOLD` | Alert when keys below this | `10` |

### Discord Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `/addlicense` | Admin | Add license keys (modal input) |
| `/stock` | Admin | View inventory status |
| `/license` | Everyone | View your license info |

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook/polar` | POST | Polar webhook receiver |
| `/api/claim-key?checkout_id=x` | GET | Poll for license key |
| `/api/licenses/add` | POST | Add keys programmatically |
| `/api/licenses/stock` | GET | Check stock count |
| `/health` | GET | Server health check |

---

## Success! 🎉

Once everything is set up:
1. ✅ Customers can purchase through your website
2. ✅ Polar handles all payments
3. ✅ License keys auto-assign on purchase
4. ✅ Customers see their key on the success page
5. ✅ You get Discord notifications
6. ✅ You can manage stock with `/addlicense` and `/stock`

**Need help?** Check the logs:
```bash
railway logs
```
