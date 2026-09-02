const API_KEY = process.env.INTER_BRANCH_API_KEY || "TEST_API_KEY_123";
const fullUrl = "http://localhost:3001/api/inter-branch/webhook/products?q=";

async function run() {
  try {
    const res = await fetch(fullUrl, {
      method: "GET",
      headers: { "x-api-key": API_KEY }
    });
    console.log("Status:", res.status);
    const text = await res.text();
    console.log("Body:", text.slice(0, 100)); // limit output
  } catch (err) {
    console.error(err);
  }
}
run();
