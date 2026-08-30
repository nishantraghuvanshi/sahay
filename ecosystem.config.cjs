// PM2 supervision for the three long-lived local processes.
// They previously ran as background jobs owned by a Claude session, so anything
// that ended the session took api.voxikin.com and voice.voxikin.com down with it —
// and the deployed app proxies every screen through api., so it went blank too.
//
//   pm2 start ecosystem.config.cjs && pm2 save
//   pm2 status | pm2 logs | pm2 restart all
//
// Secrets are NOT here: each process reads its own .env (agent/.env, ./.env).
module.exports = {
  apps: [
    {
      name: 'voxikin-agent',            // Node voice agent -> voice.voxikin.com
      cwd: '/Users/anmolsen/Developer/sahay/agent',
      script: 'src/server.js',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
    },
    {
      name: 'voxikin-care-api',         // Python FastAPI -> api.voxikin.com
      cwd: '/Users/anmolsen/Developer/sahay',
      script: '.venv/bin/uvicorn',
      args: 'api.main:app --host 127.0.0.1 --port 8000',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
    },
    {
      name: 'voxikin-tunnel',           // Cloudflare tunnel for both hostnames
      cwd: '/Users/anmolsen/Developer/sahay',
      script: '/opt/homebrew/bin/cloudflared',
      args: 'tunnel run sahay',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
    },
  ],
}
