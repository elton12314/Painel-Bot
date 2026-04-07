# Discord Bot

This worker links Discord users to panel accounts and lets them generate whitelist keys from Discord.

## Required environment variables

- `DISCORD_BOT_TOKEN`
- `DISCORD_BOT_CLIENT_ID`
- `DISCORD_BOT_GUILD_ID` (optional, recommended for faster command updates while testing)
- `PANEL_API_BASE_URL`
- `DISCORD_BOT_SHARED_SECRET`

## Commands

- `/link <code>`: links the Discord user to the panel account that generated the code
- `/scripts`: lists the linked account scripts and opens key generation buttons

## Start

```bash
npm install
npm start
```
