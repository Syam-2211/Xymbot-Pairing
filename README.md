<div align="center">
  <h1>🔗 Xymbot Pairing Server</h1>
  <p><i>The official WhatsApp Pairing Code generator for Xymbot</i></p>
</div>

---

## 🌟 About
This is a lightweight, standalone web application built with Express.js and Baileys. It provides a beautiful web interface where users can choose to scan a **QR Code** or enter their phone number to receive an 8-digit **WhatsApp Pairing Code**. 

Once connected, this server automatically generates a WhatsApp **Base64 Session ID** (`XYMBOT~...`) and sends it directly to the user's WhatsApp with tap-to-copy formatting!

## 🚀 Deployment

You can deploy this pairing site for free on services like Render, Koyeb, or Railway.

### Deploy on Render.com (Recommended)
1. Push this repository to your GitHub account.
2. Go to [Render Dashboard](https://dashboard.render.com) and click **New +** -> **Web Service**.
3. Connect your repository.
4. Set the **Build Command** to: `npm install`
5. Set the **Start Command** to: `npm start`
6. Click **Deploy Web Service**!

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
Then, open your web browser and go to `http://localhost:3000`.

## ⚙️ How it Works
1. User chooses between scanning a QR code or entering their phone number.
2. The server initializes a temporary `@whiskeysockets/baileys` socket.
3. The server either generates a Base64 QR Image or requests an 8-digit Pairing Code.
4. User links their WhatsApp account.
5. The server encodes `creds.json` into a Base64 Session ID (`XYMBOT~...`).
6. The server messages the Session ID directly to the user on WhatsApp and cleans up session files.
