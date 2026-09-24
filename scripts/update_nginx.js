const { Client } = require('ssh2');

const nginxConf = `server {
    listen 80 default_server;
    listen [::]:80 default_server;

    server_name api.hg-alshour.online _;

    client_max_body_size 50M;
    server_tokens off;

    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;
        proxy_connect_timeout 60s;
    }
}
`;

const conn = new Client();
conn.on('ready', () => {
  conn.sftp((err, sftp) => {
    if (err) throw err;
    const stream = sftp.createWriteStream('/etc/nginx/sites-available/glass-backend');
    stream.write(nginxConf);
    stream.end();
    stream.on('close', () => {
      conn.exec('nginx -t && systemctl reload nginx', (err, proc) => {
        let out = '';
        proc.on('data', d => out += d);
        proc.stderr.on('data', d => out += d);
        proc.on('close', () => {
          console.log('Nginx updated:', out);
          conn.end();
        });
      });
    });
  });
}).connect({
  host: process.env.VPS_SSH_HOST || '34.45.246.123',
  port: Number(process.env.VPS_SSH_PORT || 22),
  username: process.env.VPS_SSH_USER || 'root',
  password: process.env.VPS_SSH_PASSWORD,
});
