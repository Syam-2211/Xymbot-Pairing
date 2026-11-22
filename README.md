<div align="center">
  <h1>🔗 Xymbot Pairing Server</h1>
  <p><i>The official WhatsApp Pairing Code generator for Xymbot</i></p>
</div>

---

## 🌟 About
This is a lightweight, standalone web application built with Express.js and Baileys. It provides a web interface where users can choose to scan a **QR Code** or enter their phone number to receive an 8-digit **WhatsApp Pairing Code**.

Once connected, the server securely stores credentials under the custom session name chosen by the client. Xymbot loads the named session from this service using its license key; clients do not need to copy or configure a long Base64 session string.

## 🚀 Deployment

You can deploy this pairing site for free on services like Render, Koyeb, or Railway.

### Deploy on Render.com (Recommended)
1. Push this repository to your GitHub account.
2. Go to [Render Dashboard](https://dashboard.render.com) and click **New +** -> **Web Service**.
3. Connect your repository.
4. Set the **Build Command** to: `npm install`
5. Set the **Start Command** to: `npm start`
6. In **Environment**, add the variables listed below.
7. Click **Deploy Web Service**.

### Render Environment Variables

Set these in **Render Dashboard → your service → Environment**. Keep the bot token and MongoDB URI private.

| Variable | Value |
|---|---|
| `MONGO_URI` | MongoDB connection URI for your database. Ensure your MongoDB network access settings allow the Render service to connect. |
| `TELEGRAM_BOT_TOKEN` | Token for your Telegram bot, created with `@BotFather`. |
| `OWNER_ID` | Your numeric Telegram user ID. Owner commands only work for this account in a private chat with the bot. |
| `OWNER_CONTACT` | Optional public contact, such as `@yourusername` or a Telegram link, shown by the bot if message forwarding is unavailable. |
| `SITE_URL` | Optional public URL for the pairing and license website; used in the bot's `/start` message. |

After setting the variables, redeploy the service and open a private chat with `@sneha_auth_bot`. The website is the client portal for requesting a license key, checking a key's status, and contacting the owner. Website key requests are saved in MongoDB and forwarded to the owner for approval; approving a request creates a 30-day key, which the owner sends to the contact supplied by the client. Requests and named-session storage require a working `MONGO_URI`, `TELEGRAM_BOT_TOKEN`, and `OWNER_ID`.

### Telegram License Commands

Only the configured owner can manage licenses and website requests. Owner commands are restricted to a private chat with the bot.

Owner commands:
- `/gen 30` creates a 30-day key; `/gen life` creates a lifetime key.
- `/keys` lists the latest 20 keys; `/check <key>` shows full status and bound session.
- `/reset <key>` unbinds a key; `/remove <key>` permanently deletes one key.
- `/killall CONFIRM` permanently deletes every license key.
- `/stats` shows license totals.
- `/requests` lists pending website requests.
- `/approve <request-id>` approves a request and creates a 30-day key; send that key to the client's supplied contact.
- `/reject <request-id>` rejects a pending request.
- `/contact <message>` forwards a private message to the owner.

Clients can request keys, check their status, and contact the owner from the License Portal on the website. Status checks show whether a key is active, unused, or expired; they do not activate or bind the key.

## 💻 Local Testing
If you want to test the server on your own computer:

```bash
# Clone the repository
git clone https://github.com/YOUR_GITHUB_USERNAME/Xymbot-Pairing.git
cd Xymbot-Pairing

# Install dependencies
npm install

# Start the server
npm start
```
Then, open your web browser and go to `http://localhost:8000`.

## ⚙️ How it Works
1. User chooses between scanning a QR code or entering their phone number.
2. The server initializes a temporary `@whiskeysockets/baileys` socket.
3. The server either generates a QR image or requests an 8-digit Pairing Code.
4. User links their WhatsApp account.
5. The server stores the multi-file credentials in MongoDB under the user's unique session name.
6. Xymbot fetches the credential files from the pairing service using `SESSION_NAME` and `LICENSE_KEY`.
