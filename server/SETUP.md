# SwimHub - Complete Deployment Guide

Deploy your SwimHub website + Discord bot on Railway with Polar.sh payments.

---

## 📋 What You'll Have When Done

1. Website live at `https://your-app.up.railway.app`
2. Discord bot that auto-delivers license keys
3. Polar.sh payment processing (supports Card, Crypto, and more)
4. All purchase notifications sent to your Discord DMs

---

## 🔧 Prerequisites

- GitHub account
- Discord account  
- Polar.sh account (for payments)
- Railway account (free tier works)

---

# PART 1: DISCORD SETUP

## Step 1.1: Create Discord Application

1. Go to **https://discord.com/developers/applications**
2. Click the blue **"New Application"** button (top right)
3. Enter name: `SwimHub`
4. Click **Create**

## Step 1.2: Get OAuth2 Credentials

1. In left sidebar, click **OAuth2** → **General**
2. You'll see **Client ID** - copy this and save it somewhere
3. Under **Client Secret**, click **Reset Secret**
4. Copy the secret and save it (you won't see it again!)

**Save these:**
```
DISCORD_CLIENT_ID = (the client ID you copied)
DISCORD_CLIENT_SECRET = (the secret you copied)
```

## Step 1.3: Create the Bot

1. In left sidebar, click **Bot**
2. Click **"Add Bot"** → Click **"Yes, do it!"**
3. Under the bot username, click **"Reset Token"**
4. Copy the token and save it (you won't see it again!)

**Save this:**
```
DISCORD_BOT_TOKEN = (the token you copied)
```

## Step 1.4: Configure Bot Settings

Still on the **Bot** page, scroll down and configure:

| Setting | Value |
|---------|-------|
| Public Bot | ❌ **OFF** |
| Server Members Intent | ✅ **ON** |
| Message Content Intent | ✅ **ON** |

Click **Save Changes** if prompted.

## Step 1.5: Invite Bot to Your Server

1. In left sidebar, click **OAuth2** → **URL Generator**
2. Under **Scopes**, check:
   - ✅ `bot`
   - ✅ `applications.commands`
3. Under **Bot Permissions**, check:
   - ✅ Send Messages
   - ✅ Embed Links
   - ✅ Read Message History
4. Copy the **Generated URL** at the bottom
5. Open it in a new tab
6. Select your Discord server
7. Click **Authorize**

✅ Bot is now in your server!

## Step 1.6: Get Your Discord IDs

**Enable Developer Mode first:**
1. Open Discord
2. Go to Settings (gear icon)
3. App Settings → Advanced
4. Turn on **Developer Mode**

**Now get your IDs:**

| What to copy | How |
|--------------|-----|
| Server ID | Right-click your server icon → **Copy Server ID** |
| Your User ID | Right-click your name → **Copy User ID** |

**Save these:**
```
DISCORD_GUILD_ID = (your server ID)
ADMIN_USER_ID = (your user ID)
```

---

# PART 2: POLAR.SH SETUP

## Step 2.1: Create Polar.sh Account

1. Go to **https://polar.sh** and sign up / log in
2. Create a new organization or use personal account
3. Go to **Dashboard**

## Step 2.2: Create Your Products

1. Go to **Products** in the sidebar
2. Click **"Create Product"**
3. Create these products:

| Product Name | Price | Type |
|--------------|-------|------|
| SwimHub Regular (Monthly) | $3.50 | One-time |
| SwimHub Regular (Lifetime) | $7.00 | One-time |
| SwimHub Master (Monthly) | $8.00 | One-time |
| SwimHub Master (Lifetime) | $16.00 | One-time |
| SwimHub Nightly | $40.00 | One-time |

**Tip:** Enable all payment methods (Card, Apple Pay, etc.)

## Step 2.3: Get Checkout Links

For EACH product you created:
1. Click on the product
2. Click **"Create checkout link"** or go to **Checkout Links**
3. Select the product and click **Create**
4. Copy the checkout link - it looks like: `https://buy.polar.sh/polar_cl_XXXXXXXXXXXX`

**Save these:**
```
POLAR_URL_REGULAR_MONTHLY = https://buy.polar.sh/polar_cl_xxxxx
POLAR_URL_REGULAR_LIFETIME = https://buy.polar.sh/polar_cl_xxxxx
POLAR_URL_MASTER_MONTHLY = https://buy.polar.sh/polar_cl_xxxxx
POLAR_URL_MASTER_LIFETIME = https://buy.polar.sh/polar_cl_xxxxx
POLAR_URL_NIGHTLY = https://buy.polar.sh/polar_cl_xxxxx
```

**Important:** Set the **Success URL** for each checkout link to:
```
https://YOUR-RAILWAY-URL/success.html?checkout_id={CHECKOUT_ID}
```

⚠️ **Webhook setup comes AFTER Railway deployment** (Step 5.2)

---

# PART 3: GITHUB SETUP

## Step 3.1: Create GitHub Repository

1. Go to **https://github.com** and log in
2. Click **+** (top right) → **New repository**
3. Name it: `swimhub`
4. Keep it **Public** or **Private** (either works)
5. Click **Create repository**

## Step 3.2: Push Your Code

Open terminal/PowerShell in your Swimhub folder and run:

```powershell
cd "c:\Users\Antplay\Documents\Swimhub"
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/swimhub.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

✅ Code is now on GitHub!

---

# PART 4: RAILWAY DEPLOYMENT

## Step 4.1: Create Railway Account

1. Go to **https://railway.app**
2. Click **"Login"** → **"Login with GitHub"**
3. Authorize Railway

## Step 4.2: Create New Project

1. Click **"New Project"**
2. Select **"Deploy from GitHub repo"**
3. Find and select your `swimhub` repository
4. Railway will start deploying (it will fail - that's OK, we need to configure it)

## Step 4.3: Set Root Directory

1. Click on your service (the one showing your repo name)
2. Go to **Settings** tab
3. Scroll to **Root Directory**
4. Enter: `server`
5. Railway will redeploy

## Step 4.4: Add PostgreSQL Database

1. Click **"New"** button (top right of your project)
2. Select **"Database"**
3. Select **"Add PostgreSQL"**
4. Railway creates the database and automatically sets `DATABASE_URL`

✅ Database ready!

## Step 4.5: Add Environment Variables

1. Click on your service (the Node.js one, not PostgreSQL)
2. Go to **Variables** tab
3. Click **"New Variable"** for each of these:

```
DISCORD_BOT_TOKEN = (from Step 1.3)
DISCORD_CLIENT_ID = (from Step 1.2)
DISCORD_CLIENT_SECRET = (from Step 1.2)
DISCORD_GUILD_ID = (from Step 1.6)
ADMIN_USER_ID = (from Step 1.6)

POLAR_URL_REGULAR_MONTHLY = (from Step 2.3)
POLAR_URL_REGULAR_LIFETIME = (from Step 2.3)
POLAR_URL_MASTER_MONTHLY = (from Step 2.3)
POLAR_URL_MASTER_LIFETIME = (from Step 2.3)
POLAR_URL_NIGHTLY = (from Step 2.3)

NODE_ENV = production
WEBSITE_URL = https://placeholder.up.railway.app
```

⚠️ We'll add `POLAR_WEBHOOK_SECRET` and update `WEBSITE_URL` after getting the domain.

## Step 4.6: Generate Domain

1. Go to **Settings** tab
2. Scroll to **Networking** section
3. Click **"Generate Domain"**
4. You'll get a URL like: `https://swimhub-production-abc123.up.railway.app`
5. Copy this URL!

## Step 4.7: Update WEBSITE_URL

1. Go back to **Variables** tab
2. Find `WEBSITE_URL`
3. Change it from `https://placeholder.up.railway.app` to your actual Railway URL
4. Railway will redeploy

✅ Your website is now live!

---

# PART 5: FINAL CONFIGURATION

## Step 5.1: Add Discord OAuth Redirect

1. Go back to **https://discord.com/developers/applications**
2. Select your SwimHub app
3. Go to **OAuth2** → **General**
4. Under **Redirects**, click **"Add Redirect"**
5. Enter: `https://swimhub-production.up.railway.app/auth/discord/callback`
   - Replace `YOUR-RAILWAY-URL` with your actual Railway domain
   swimhub-production.up.railway.app
6. Click **Save Changes**

## Step 5.2: Configure Polar.sh Webhook

1. Go to **https://polar.sh** → Your organization/account
2. Go to **Settings** → **Webhooks**
3. Click **"Add Endpoint"**
4. Configure:
   - **Endpoint URL**: `https://YOUR-RAILWAY-URL/webhook/polar`
     (e.g., `https://swimhub-production.up.railway.app/webhook/polar`)
   - **Events**: Select these events:
     - ✅ `checkout.completed`
     - ✅ `order.created`
   - **Secret**: Polar will generate one, or you can enter your own
5. Click **Create**
6. Copy the **Webhook Secret** shown

## Step 5.3: Add Webhook Secret to Railway

1. Go back to Railway → Your service → **Variables**
2. Add new variable:
   ```
   POLAR_WEBHOOK_SECRET = (the secret you copied from Polar)
   ```
3. Railway will redeploy

✅ Everything is connected!

---

# PART 6: ADD LICENSE KEYS

Before anyone can buy, you need to add license keys to stock.

## Step 6.1: Use /addkey Command

1. Go to your Discord server
2. Type `/addkey`
3. Select the product type from dropdown
4. In the popup modal, paste your keys (one per line):
   ```
   KEY-XXXXX-XXXXX-1
   KEY-XXXXX-XXXXX-2
   KEY-XXXXX-XXXXX-3
   ```
5. Submit

## Step 6.2: Check Stock

Type `/stock` to see how many keys you have for each product.

---

# 🧪 TESTING

## Test the Full Flow

1. Visit your Railway URL
2. Click on **Purchase**
3. Click any **"Purchase Monthly"** or **"Purchase Lifetime"** button
4. Authorize with Discord
5. Review order → Click **"Proceed to Secure Checkout"**
6. Complete a test payment on Polar.sh
7. You should:
   - See the success page
   - Receive the license key in Discord DMs
   - YOU receive purchase notification in your DMs

---

# 🤖 BOT COMMANDS

## User Commands
| Command | Description |
|---------|-------------|
| `/license` | View your purchased licenses |

## Admin Commands (Requires Administrator permission)
| Command | Description |
|---------|-------------|
| `/addkey` | Add license keys to stock (opens UI modal) |
| `/stock` | Check available keys for all products |
| `/givekey @user product` | Manually give a key to someone |

---

# 📨 NOTIFICATIONS YOU'LL RECEIVE

All notifications come to your Discord DMs:

## Purchase Successful (Green)
```
💰 New Purchase!
Product: SwimHub Regular (Monthly)
User: @username
Delivery Status: ✅ Sent to DMs
🔑 License Key: KEY-XXXXX-XXXXX
```

## Manual Delivery Needed (Orange)
```
💰 New Purchase - ⚠️ MANUAL DELIVERY NEEDED
User has DMs closed. Please deliver the key manually.
Product: SwimHub Regular (Monthly)
User: @username
🔑 License Key: KEY-XXXXX-XXXXX
```

## Out of Stock (Red)
```
⚠️ OUT OF STOCK!
Someone tried to purchase but we're out of keys!
Product: SwimHub Regular (Monthly)
```

---

# 🔧 TROUBLESHOOTING

## Bot commands not showing?
- Wait up to 1 hour for Discord to sync
- Or kick and re-invite the bot

## OAuth "Invalid redirect" error?
- Make sure the redirect URL in Discord Developer Portal EXACTLY matches:
  `https://YOUR-RAILWAY-URL.up.railway.app/auth/discord/callback`
- Include `https://` and no trailing slash

## Webhook not working?
- Check Railway logs for errors
- Make sure webhook URL is correct in Fungies
- Verify the event types are selected

## Database errors?
- Make sure PostgreSQL is added in Railway
- Tables auto-create on first run

## Bot not responding?
- Check Railway logs
- Make sure all environment variables are set
- Verify bot token is correct

---

# 📁 PROJECT STRUCTURE

```
Swimhub/
├── index.html          ← Landing page
├── purchase.html       ← Pricing page
├── checkout.html       ← Order review (after Discord OAuth)
├── success.html        ← "Check your DMs" page
├── privacy.html        ← Privacy policy
├── terms.html          ← Terms of service
├── styles.css          ← All styling
├── script.js           ← Animations & interactions
└── server/
    ├── index.js        ← Bot + API + serves website
    ├── package.json    ← Dependencies
    ├── .env.example    ← Environment variables template
    └── SETUP.md        ← This guide
```

---

# ✅ CHECKLIST

Before going live, verify:

- [ ] Discord bot is in your server
- [ ] All environment variables set in Railway
- [ ] OAuth redirect URL added in Discord Developer Portal
- [ ] Fungies webhook configured
- [ ] License keys added with `/addkey`
- [ ] Test purchase completed successfully

---

# 🎉 You're Done!

Your SwimHub system is now fully operational:
- ✅ Website live on Railway
- ✅ Discord OAuth for buyer verification
- ✅ Auto server join
- ✅ Fungies payment processing
- ✅ Automatic license delivery via DM
- ✅ All purchase logs sent to your DMs
- ✅ Manual delivery notifications when DMs fail
