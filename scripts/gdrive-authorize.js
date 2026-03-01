/**
 * One-time OAuth2 Authorization for Google Drive
 * Run this once: node scripts/gdrive-authorize.js
 * It opens the browser, you login, and it saves the refresh token.
 */

const { google } = require("googleapis");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const CREDENTIALS_PATH = path.join(
  __dirname,
  "..",
  "credentials",
  "oauth-client.json",
);
const TOKEN_PATH = path.join(
  __dirname,
  "..",
  "credentials",
  "gdrive-token.json",
);
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const PORT = 3333;

async function authorize() {
  const content = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  const { client_id, client_secret } = content.installed || content.web;

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    `http://localhost:${PORT}/callback`,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\n=== Google Drive Authorization ===\n");
  console.log("Opening browser for authorization...\n");

  // Start a temporary HTTP server to receive the callback
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400);
        res.end("No code received");
        return;
      }

      const { tokens } = await oauth2Client.getToken(code);

      // Save tokens
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <html>
          <body style="font-family:Arial; text-align:center; padding:50px; background:#1a1a2e; color:#e0e0e0;">
            <h1 style="color:#00d4aa;">✅ تم التفعيل بنجاح!</h1>
            <p>Authorization successful! You can close this window.</p>
            <p>Token saved to: credentials/gdrive-token.json</p>
          </body>
        </html>
      `);

      console.log("\n✅ Authorization successful!");
      console.log(`Token saved to: ${TOKEN_PATH}\n`);

      setTimeout(() => {
        server.close();
        process.exit(0);
      }, 1000);
    } catch (err) {
      console.error("Error:", err.message);
      res.writeHead(500);
      res.end("Error: " + err.message);
    }
  });

  server.listen(PORT, () => {
    console.log(`Waiting for callback on http://localhost:${PORT}/callback\n`);

    // Open the browser
    const { exec } = require("child_process");
    exec(`start "" "${authUrl}"`);
  });
}

authorize().catch(console.error);
