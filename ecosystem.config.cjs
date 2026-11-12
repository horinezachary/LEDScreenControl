// pm2 settings for running the server without the Mac app (scripts/deploy.sh headless).
module.exports = {
  apps: [
    {
      name: 'led-monitor',
      script: 'packages/server/dist/cli.cjs',
      args: '--data ./data',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
    },
  ],
};
