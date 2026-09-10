const fs = require('fs');

async function migrate() {
    console.log("Reading database_dump_tenant.sql...");
    const rawSql = fs.readFileSync('database_dump_tenant.sql', 'utf8');
    const lines = rawSql.split('\n');
    
    console.log(`Total lines: ${lines.length}`);
    
    const CHUNK_SIZE_LIMIT = 2 * 1024 * 1024; // 2MB
    let chunks = [];
    let currentChunk = [];
    let currentChunkSize = 0;
    
    const safeStartRegex = /^(INSERT INTO|ALTER TABLE|CREATE INDEX|SELECT pg_catalog\.setval|CREATE PUBLICATION|--)/;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineSize = Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
        
        // If we exceeded chunk size AND this line is a safe start of a new statement
        if (currentChunkSize >= CHUNK_SIZE_LIMIT && safeStartRegex.test(line)) {
            chunks.push(currentChunk.join('\n') + '\n');
            currentChunk = [];
            currentChunkSize = 0;
        }
        
        currentChunk.push(line);
        currentChunkSize += lineSize;
    }
    
    if (currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n') + '\n');
    }
    
    console.log(`Split into ${chunks.length} chunks.`);
    
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6NCwidXNlcm5hbWUiOiJob2dsYXNzX3N5c3RlbSIsInBlcm1pc3Npb25zIjp7ImNhbl9lZGl0Ijp0cnVlLCJpc19hZG1pbiI6ZmFsc2UsImFsbG93ZWRfdGFibGVzIjpbIioiXSwiYW5hbHl0aWNzX2FjY2VzcyI6ZmFsc2UsImFuYWx5dGljc19jYW5fZWRpdCI6ZmFsc2UsImFuYWx5dGljc19hbGxvd2VkX3RhYmxlcyI6WyIqIl19LCJ0ZW5hbnQiOiJ0ZW5hbnRfaG9nbGFzc19zeXN0ZW0iLCJpYXQiOjE3ODg2NDg5MTcsImV4cCI6MjEwNDAwODkxN30.odMhYLJXPi5QaE3iA01kAtcVtnJC1zqyAV8hE4CnaSU";
    
    for (let i = 0; i < chunks.length; i++) {
        console.log(`Sending chunk ${i + 1} of ${chunks.length} (${(Buffer.byteLength(chunks[i]) / 1024 / 1024).toFixed(2)} MB)...`);
        
        try {
            const response = await fetch('https://srstudio.hg-alshour.online/api/database/import-sql', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'text/plain; charset=utf-8'
                },
                body: chunks[i]
            });
            
            const text = await response.text();
            if (!response.ok) {
                console.error(`Chunk ${i + 1} failed! Status: ${response.status}`);
                console.error(text);
                process.exit(1);
            }
        } catch (e) {
            console.error(`Fetch failed on chunk ${i + 1}:`, e);
            process.exit(1);
        }
    }
    console.log("Migration completed successfully!");
}
migrate();
