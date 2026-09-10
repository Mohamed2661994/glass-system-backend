const fs = require('fs');

async function migrate() {
    console.log("Reading database_dump_clean.sql as Buffer (30MB) ...");
    const rawSql = fs.readFileSync('database_dump_clean.sql');
    
    console.log("Sending to Data Studio...");
    
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6NCwidXNlcm5hbWUiOiJob2dsYXNzX3N5c3RlbSIsInBlcm1pc3Npb25zIjp7ImNhbl9lZGl0Ijp0cnVlLCJpc19hZG1pbiI6ZmFsc2UsImFsbG93ZWRfdGFibGVzIjpbIioiXSwiYW5hbHl0aWNzX2FjY2VzcyI6ZmFsc2UsImFuYWx5dGljc19jYW5fZWRpdCI6ZmFsc2UsImFuYWx5dGljc19hbGxvd2VkX3RhYmxlcyI6WyIqIl19LCJ0ZW5hbnQiOiJ0ZW5hbnRfaG9nbGFzc19zeXN0ZW0iLCJpYXQiOjE3ODg2NDg5MTcsImV4cCI6MjEwNDAwODkxN30.odMhYLJXPi5QaE3iA01kAtcVtnJC1zqyAV8hE4CnaSU";
    
    try {
        const response = await fetch('https://srstudio.hg-alshour.online/api/database/import-sql', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'text/plain; charset=utf-8'
            },
            body: rawSql
        });
        
        const data = await response.text();
        console.log(`Status: ${response.status}`);
        console.log(`Response: ${data}`);
    } catch (e) {
        console.error("Fetch failed:", e);
    }
}
migrate();
