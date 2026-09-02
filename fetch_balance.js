const http = require("http");
http.get("http://localhost:5000/api/reports/customer-balances", res => {
  let data = "";
  res.on("data", chunk => data += chunk);
  res.on("end", () => {
    const json = JSON.parse(data);
    const arr = json.data || json;
    if (Array.isArray(arr)) {
      const sherif = arr.find(c => c.customer_name && c.customer_name.includes("شريف عارف"));
      console.log("Sherif Aref Balance Data:", sherif);
    } else {
      console.log("JSON response:", json);
    }
  });
});
