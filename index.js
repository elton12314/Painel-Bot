const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require("discord.js");

const token = process.env.DISCORD_BOT_TOKEN || "";
const clientId = process.env.DISCORD_BOT_CLIENT_ID || "";
const guildId = process.env.DISCORD_BOT_GUILD_ID || "";
const panelApiBaseUrl = (process.env.PANEL_API_BASE_URL || "").replace(/\/+$/, "");
const sharedSecret = process.env.DISCORD_BOT_SHARED_SECRET || "";

if (!token || !clientId || !panelApiBaseUrl || !sharedSecret) {
  throw new Error(
    "Missing DISCORD_BOT_TOKEN, DISCORD_BOT_CLIENT_ID, PANEL_API_BASE_URL or DISCORD_BOT_SHARED_SECRET",
  );
}

const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Discord account to the panel")
    .addStringOption((option) =>
      option
        .setName("code")
        .setDescription("The link code generated from the panel")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("scripts")
    .setDescription("Open your script panel in Discord"),
].map((command) => command.toJSON());

function getHeaders() {
  return {
    Authorization: `Bearer ${sharedSecret}`,
    "Content-Type": "application/json",
  };
}

async function apiRequest(path, init = {}) {
  const res = await fetch(`${panelApiBaseUrl}${path}`, {
    ...init,
    headers: {
      ...getHeaders(),
      ...(init.headers || {}),
    },
  });

  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function linkAccount(discordId, code) {
  return apiRequest("/api/bot/link", {
    method: "POST",
    body: JSON.stringify({ discordId, code }),
  });
}

async function listScripts(discordId) {
  return apiRequest(`/api/bot/scripts?discordId=${encodeURIComponent(discordId)}`);
}

async function createKey(discordId, scriptId, expiresInMs) {
  return apiRequest(`/api/bot/scripts/${encodeURIComponent(scriptId)}/keys`, {
    method: "POST",
    body: JSON.stringify({ discordId, expiresInMs }),
  });
}

function buildScriptsMenu(scripts) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("scripts:select")
      .setPlaceholder("Choose a script")
      .addOptions(
        scripts.slice(0, 25).map((script) => ({
          label: script.name.slice(0, 100),
          value: script.id,
          description: script.scriptId.slice(0, 100),
        })),
      ),
  );
}

function buildKeyButtons(scriptId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`keygen:${scriptId}:never`)
      .setLabel("No Expiry")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`keygen:${scriptId}:7d`)
      .setLabel("7 Days")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`keygen:${scriptId}:30d`)
      .setLabel("30 Days")
      .setStyle(ButtonStyle.Secondary),
  );
}

function expiryFromPreset(preset) {
  if (preset === "7d") return 7 * 24 * 60 * 60 * 1000;
  if (preset === "30d") return 30 * 24 * 60 * 60 * 1000;
  return null;
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Discord bot ready as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "link") {
      const code = interaction.options.getString("code", true);
      const result = await linkAccount(interaction.user.id, code);
      if (!result.ok) {
        await interaction.reply({
          content: result.data?.error || "Failed to link account.",
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: `Linked successfully as \`${result.data.username}\`.`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "scripts") {
      const result = await listScripts(interaction.user.id);
      if (!result.ok) {
        await interaction.reply({
          content:
            result.data?.error ||
            "Could not load your scripts. Make sure your Discord is linked.",
          ephemeral: true,
        });
        return;
      }

      const scripts = Array.isArray(result.data?.scripts) ? result.data.scripts : [];
      if (scripts.length === 0) {
        await interaction.reply({
          content: "No scripts found in your account.",
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: "Choose a script to generate a key:",
        components: [buildScriptsMenu(scripts)],
        ephemeral: true,
      });
      return;
    }
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "scripts:select") {
    const scriptId = interaction.values[0];
    await interaction.update({
      content: "Choose the key duration:",
      components: [buildKeyButtons(scriptId)],
    });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("keygen:")) {
    const [, scriptId, preset] = interaction.customId.split(":");
    const result = await createKey(interaction.user.id, scriptId, expiryFromPreset(preset));

    if (!result.ok) {
      await interaction.reply({
        content: result.data?.error || "Failed to generate key.",
        ephemeral: true,
      });
      return;
    }

    const key = result.data?.key;
    const script = result.data?.script;
    const expiresAt = key?.expiresAt
      ? new Date(key.expiresAt).toLocaleString("en-US")
      : "Never";

    await interaction.reply({
      content:
        `Script: \`${script?.name || "Unknown"}\`\n` +
        `Key: \`${key?.key || "Unknown"}\`\n` +
        `Expires: \`${expiresAt}\``,
      ephemeral: true,
    });
  }
});

registerCommands()
  .then(() => client.login(token))
  .catch((error) => {
    console.error("Failed to start Discord bot:", error);
    process.exit(1);
  });

