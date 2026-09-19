/**
 * Google Drive Backup Helper (OAuth2)
 * Usage:
 *   node gdrive-helper.js upload <filePath>
 *   node gdrive-helper.js download <outputPath>
 *   node gdrive-helper.js list
 *
 * First run: node scripts/gdrive-authorize.js  (one-time browser login)
 */

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

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
const FOLDER_ID = process.env.GDRIVE_FOLDER_ID || "1sOVQgZ2A_Vfr2KfZ5I1yjjwSIMH3R3Iw";
const MAX_FILES = 5;

function getAuth() {
  let clientId, clientSecret, refreshToken;

  if (fs.existsSync(TOKEN_PATH) && fs.existsSync(CREDENTIALS_PATH)) {
    try {
      const content = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
      const { client_id, client_secret } = content.installed || content.web;
      const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
      clientId = client_id;
      clientSecret = client_secret;
      refreshToken = tokens.refresh_token;
    } catch (e) {}
  }

  if (!clientId || !clientSecret || !refreshToken) {
    clientId = process.env.GDRIVE_CLIENT_ID;
    clientSecret = process.env.GDRIVE_CLIENT_SECRET;
    refreshToken = process.env.GDRIVE_REFRESH_TOKEN;
  }

  if (!clientId || !clientSecret || !refreshToken) {
    console.error(
      "ERROR: No valid Google Drive credentials found in credentials/ or .env.",
    );
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return oauth2Client;
}

async function uploadFile(filePath) {
  const auth = getAuth();
  const drive = google.drive({ version: "v3", auth });
  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

  console.log(`Uploading ${fileName} (${sizeMB} MB) to Google Drive...`);

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [FOLDER_ID],
    },
    media: {
      mimeType: "application/sql",
      body: fs.createReadStream(filePath),
    },
    fields: "id,name,createdTime",
  });

  console.log(`Uploaded: ${res.data.name} (ID: ${res.data.id})`);

  // Cleanup old files (keep last MAX_FILES)
  await cleanupOldFiles(drive);

  return res.data;
}

async function downloadLatest(outputPath) {
  const auth = getAuth();
  const drive = google.drive({ version: "v3", auth });

  // List files sorted by creation time (newest first)
  const list = await drive.files.list({
    q: `'${FOLDER_ID}' in parents and trashed=false`,
    orderBy: "createdTime desc",
    pageSize: 1,
    fields: "files(id,name,createdTime,size)",
  });

  if (!list.data.files || list.data.files.length === 0) {
    console.log("NO_FILES");
    process.exit(1);
  }

  const file = list.data.files[0];
  const sizeMB = (parseInt(file.size || "0") / 1024 / 1024).toFixed(2);
  console.log(
    `Downloading: ${file.name} (${sizeMB} MB, uploaded: ${file.createdTime})`,
  );

  const dest = fs.createWriteStream(outputPath);
  const res = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "stream" },
  );

  await new Promise((resolve, reject) => {
    res.data.pipe(dest);
    dest.on("finish", resolve);
    dest.on("error", reject);
  });

  const downloadedSize = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(
    2,
  );
  console.log(`Downloaded: ${downloadedSize} MB => ${outputPath}`);
  console.log("DOWNLOAD_OK");
}

async function listFiles() {
  const auth = getAuth();
  const drive = google.drive({ version: "v3", auth });

  const list = await drive.files.list({
    q: `'${FOLDER_ID}' in parents and trashed=false`,
    orderBy: "createdTime desc",
    pageSize: 20,
    fields: "files(id,name,createdTime,size)",
  });

  if (!list.data.files || list.data.files.length === 0) {
    console.log("No files found.");
    return;
  }

  console.log(`Found ${list.data.files.length} file(s):`);
  for (const f of list.data.files) {
    const sizeMB = (parseInt(f.size || "0") / 1024 / 1024).toFixed(2);
    console.log(`  ${f.name} | ${sizeMB} MB | ${f.createdTime}`);
  }
}

async function cleanupOldFiles(drive) {
  const list = await drive.files.list({
    q: `'${FOLDER_ID}' in parents and trashed=false`,
    orderBy: "createdTime desc",
    pageSize: 100,
    fields: "files(id,name)",
  });

  const files = list.data.files || [];
  if (files.length > MAX_FILES) {
    const toDelete = files.slice(MAX_FILES);
    for (const f of toDelete) {
      await drive.files.delete({ fileId: f.id });
      console.log(`Deleted old backup: ${f.name}`);
    }
  }
  console.log(
    `Drive backups: ${Math.min(files.length, MAX_FILES)} file(s) kept`,
  );
}

// ── CLI ──
const [, , command, arg] = process.argv;

(async () => {
  try {
    switch (command) {
      case "upload":
        if (!arg) {
          console.error("Usage: node gdrive-helper.js upload <filePath>");
          process.exit(1);
        }
        await uploadFile(arg);
        break;
      case "download":
        if (!arg) {
          console.error("Usage: node gdrive-helper.js download <outputPath>");
          process.exit(1);
        }
        await downloadLatest(arg);
        break;
      case "list":
        await listFiles();
        break;
      default:
        console.error(
          "Usage: node gdrive-helper.js <upload|download|list> [path]",
        );
        process.exit(1);
    }
  } catch (err) {
    console.error("ERROR:", err.message);
    process.exit(1);
  }
})();
