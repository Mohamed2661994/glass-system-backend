const { Client } = require('pg');
const fs = require('fs');

const client = new Client({
  connectionString: 'postgresql://postgres.elorfmpjtbojzythlyzf:DWyKR1VlPFvBnd1T@aws-0-eu-west-2.pooler.supabase.com:5432/postgres'
});

async function importProducts() {
  try {
    console.log("Connecting to the new Supabase DB...");
    await client.connect();

    console.log("Reading exported products...");
    const data = fs.readFileSync('products_export.json', 'utf8');
    const products = JSON.parse(data);
    console.log(`Found ${products.length} products to import.`);

    let inserted = 0;
    
    // Process in batches
    const batchSize = 100;
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      
      const values = [];
      const placeholders = [];
      let paramIndex = 1;
      
      for (const p of batch) {
        values.push(
          p.id,
          p.name,
          p.purchase_price,
          p.wholesale_price,
          p.retail_price,
          p.discount_amount,
          p.is_active,
          p.manufacturer,
          p.retail_purchase_price,
          p.barcode,
          p.wholesale_package,
          p.retail_package,
          p.description,
          p.has_wholesale,
          p.created_at,
          p.updated_at,
          p.purchase_price_adjustment,
          p.purchase_price_adjustment_is_percentage
        );
        
        const rowPlaceholders = [];
        for (let j = 0; j < 18; j++) {
          rowPlaceholders.push(`$${paramIndex++}`);
        }
        placeholders.push(`(${rowPlaceholders.join(', ')})`);
      }
      
      const query = `
        INSERT INTO products (
          id, name, purchase_price, wholesale_price, retail_price, discount_amount, is_active,
          manufacturer, retail_purchase_price, barcode, wholesale_package, retail_package,
          description, has_wholesale, created_at, updated_at, purchase_price_adjustment,
          purchase_price_adjustment_is_percentage
        ) VALUES ${placeholders.join(', ')}
        ON CONFLICT (id) DO NOTHING
      `;
      
      await client.query(query, values);
      inserted += batch.length;
      console.log(`Inserted ${inserted} / ${products.length}`);
    }

    // Reset the auto-increment sequence for products ID
    const maxIdRes = await client.query('SELECT MAX(id) FROM products');
    const maxId = maxIdRes.rows[0].max || 0;
    await client.query(`SELECT setval('products_id_seq', ${maxId})`);
    console.log(`Reset sequence to ${maxId}`);

    console.log("Import completed successfully!");
  } catch (err) {
    console.error("Import failed:", err);
  } finally {
    await client.end();
  }
}

importProducts();
