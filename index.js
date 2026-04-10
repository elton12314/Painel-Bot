const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} = require("discord.js");

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed.replace(/^\/+/, "")}`;
}

const token = process.env.DISCORD_BOT_TOKEN || "";
const clientId = process.env.DISCORD_BOT_CLIENT_ID || "";
const guildId = process.env.DISCORD_BOT_GUILD_ID || "";
const panelApiBaseUrl = normalizeBaseUrl(process.env.PANEL_API_BASE_URL || "");
const sharedSecret = process.env.DISCORD_BOT_SHARED_SECRET || "";
const allowedRoleIds = String(process.env.DISCORD_ALLOWED_ROLE_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!token || !clientId || !panelApiBaseUrl || !sharedSecret) {
  throw new Error(
    "Missing DISCORD_BOT_TOKEN, DISCORD_BOT_CLIENT_ID, PANEL_API_BASE_URL or DISCORD_BOT_SHARED_SECRET",
  );
}

const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link this server to the panel")
    .addStringOption((option) =>
      option
        .setName("code")
        .setDescription("The link code generated from the panel")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("scripts")
    .setDescription("Open this server script panel in Discord"),
  new SlashCommandBuilder()
    .setName("logout")
    .setDescription("Unlink this server from the panel"),
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

async function linkAccount(guildId, code) {
  return apiRequest("/api/bot/link", {
    method: "POST",
    body: JSON.stringify({ guildId, code }),
  });
}

async function listScripts(guildId) {
  return apiRequest(`/api/bot/scripts?guildId=${encodeURIComponent(guildId)}`);
}

async function unlinkAccount(guildId) {
  return apiRequest("/api/bot/unlink", {
    method: "POST",
    body: JSON.stringify({ guildId }),
  });
}

async function createKey(guildId, scriptId, expiresInMs) {
  return apiRequest(`/api/bot/scripts/${encodeURIComponent(scriptId)}/keys`, {
    method: "POST",
    body: JSON.stringify({ guildId, expiresInMs }),
  });
}

const accessCache = new Map();

async function getGuildAccess(guildId) {
  const now = Date.now();
  const cached = accessCache.get(guildId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const result = await apiRequest(
    `/api/bot/access?guildId=${encodeURIComponent(guildId)}`,
  );
  const value = result.ok
    ? {
        linked: Boolean(result.data?.linked),
        allowedRoleIds: Array.isArray(result.data?.allowedRoleIds)
          ? result.data.allowedRoleIds
              .map((roleId) => String(roleId).trim())
              .filter(Boolean)
          : [],
      }
    : { linked: false, allowedRoleIds: [] };

  accessCache.set(guildId, {
    value,
    expiresAt: now + 30_000,
  });

  return value;
}

async function getAccessError(interaction) {
  if (!interaction.inGuild() || !interaction.guildId) {
    return "This bot can only be used inside a server.";
  }

  const guildAccess = await getGuildAccess(interaction.guildId);
  const requiredRoleIds =
    guildAccess.allowedRoleIds.length > 0
      ? guildAccess.allowedRoleIds
      : allowedRoleIds;

  if (requiredRoleIds.length > 0) {
    const memberRoles = interaction.member?.roles;

    if (Array.isArray(memberRoles)) {
      const hasAllowedRole = requiredRoleIds.some((roleId) =>
        memberRoles.includes(roleId),
      );
      if (!hasAllowedRole) {
        return "Only members with an allowed high role can use this bot.";
      }
      return null;
    }

    const roleCache = memberRoles?.cache;
    if (roleCache && typeof roleCache.has === "function") {
      const hasAllowedRole = requiredRoleIds.some((roleId) =>
        roleCache.has(roleId),
      );
      if (!hasAllowedRole) {
        return "Only members with an allowed high role can use this bot.";
      }
      return null;
    }

    return "Could not verify your roles right now.";
  }

  const memberPermissions =
    interaction.memberPermissions ||
    interaction.member?.permissions;

  if (
    !memberPermissions ||
    (!memberPermissions.has(PermissionFlagsBits.ManageGuild) &&
      !memberPermissions.has(PermissionFlagsBits.Administrator))
  ) {
    return "Only members with a high role can use this bot.";
  }

  return null;
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
  try {
    if (interaction.isChatInputCommand()) {
      const accessError = await getAccessError(interaction);
      if (accessError) {
        await interaction.reply({
          content: accessError,
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "link") {
        const code = interaction.options.getString("code", true);
        const result = await linkAccount(interaction.guildId, code);
        if (!result.ok) {
          await interaction.reply({
            content: result.data?.error || "Failed to link account.",
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          content:
            `Linked this server successfully as \`${result.data.username}\`.\n` +
            "High-role members in this server can now use the bot.",
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "scripts") {
        const result = await listScripts(interaction.guildId);
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

      if (interaction.commandName === "logout") {
        const result = await unlinkAccount(interaction.guildId);
        if (!result.ok) {
          await interaction.reply({
            content: result.data?.error || "Failed to unlink account.",
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          content: `Unlinked this server from \`${result.data.username}\`.`,
          ephemeral: true,
        });
        return;
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "scripts:select") {
      const accessError = await getAccessError(interaction);
      if (accessError) {
        await interaction.reply({
          content: accessError,
          ephemeral: true,
        });
        return;
      }

      const scriptId = interaction.values[0];
      await interaction.update({
        content: "Choose the key duration:",
        components: [buildKeyButtons(scriptId)],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("keygen:")) {
      const accessError = await getAccessError(interaction);
      if (accessError) {
        await interaction.reply({
          content: accessError,
          ephemeral: true,
        });
        return;
      }

      const [, scriptId, preset] = interaction.customId.split(":");
      const result = await createKey(interaction.guildId, scriptId, expiryFromPreset(preset));

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
  } catch (error) {
    console.error("Discord interaction error:", error);

    if (interaction.isRepliable()) {
      const response = {
        content: "Something went wrong while talking to the panel API.",
        ephemeral: true,
      };

      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(response).catch(() => {});
      } else {
        await interaction.reply(response).catch(() => {});
      }
    }
  }
});

registerCommands()
  .then(() => client.login(token))
  .catch((error) => {
    console.error("Failed to start Discord bot:", error);
    process.exit(1);
  });
