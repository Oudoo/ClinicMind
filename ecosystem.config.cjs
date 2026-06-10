/**
 * PM2 process definitions for Hostinger (no Docker).
 * Usage on the server:  pm2 start ecosystem.config.cjs && pm2 save
 */
module.exports = {
  apps: [
    {
      name: "growengine-web",
      cwd: "./apps/web",
      script: "node_modules/.bin/next",
      args: "start -p 3000",
      instances: 1,
      autorestart: true,
      max_memory_restart: "1G",
      env: { NODE_ENV: "production" },
    },
    {
      name: "growengine-worker",
      cwd: "./apps/worker",
      script: "dist/main.js",
      instances: 1,
      autorestart: true,
      max_memory_restart: "1G",
      env: { NODE_ENV: "production" },
    },
  ],
};
