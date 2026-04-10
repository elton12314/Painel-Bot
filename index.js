const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
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

async function linkAccount(currentGuildId, code) {
  return apiRequest("/api/bot/link", {
    method: "POST",
    body: JSON.stringify({ guildId: currentGuildId, code }),
  });
}

async function listScripts(currentGuildId) {
  return apiRequest(
    `/api/bot/scripts?guildId=${encodeURIComponent(currentGuildId)}`,
  );
}

async function unlinkAccount(currentGuildId) {
  return apiRequest("/api/bot/unlink", {
    method: "POST",
    body: JSON.stringify({ guildId: currentGuildId }),
  });
}

async function createKey(currentGuildId, scriptId, expiresInMs) {
  return apiRequest(`/api/bot/scripts/${encodeURIComponent(scriptId)}/keys`, {
    method: "POST",
    body: JSON.stringify({ guildId: currentGuildId, expiresInMs }),
  });
}

async function listKeys(currentGuildId, scriptId) {
  return apiRequest(
    `/api/bot/scripts/${encodeURIComponent(scriptId)}/keys?guildId=${encodeURIComponent(currentGuildId)}`,
  );
}

async function updateKeyExpiry(currentGuildId, scriptId, keyId, expiresInMs) {
  return apiRequest(
    `/api/bot/scripts/${encodeURIComponent(scriptId)}/keys/${encodeURIComponent(keyId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ guildId: currentGuildId, expiresInMs }),
    },
  );
}

async function deleteKey(currentGuildId, scriptId, keyId) {
  return apiRequest(
    `/api/bot/scripts/${encodeURIComponent(scriptId)}/keys/${encodeURIComponent(keyId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ guildId: currentGuildId }),
    },
  );
}

async function resetKeyHwid(currentGuildId, scriptId, keyId) {
  return apiRequest(
    `/api/bot/scripts/${encodeURIComponent(scriptId)}/keys/${encodeURIComponent(keyId)}/reset`,
    {
      method: "POST",
      body: JSON.stringify({ guildId: currentGuildId }),
    },
  );
}

function resolveInteractionGuildId(interaction) {
  return interaction.guildId || interaction.guild?.id || guildId || "";
}

const accessCache = new Map();

async function getGuildAccess(currentGuildId) {
  const now = Date.now();
  const cached = accessCache.get(currentGuildId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const result = await apiRequest(
    `/api/bot/access?guildId=${encodeURIComponent(currentGuildId)}`,
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

  accessCache.set(currentGuildId, {
    value,
    expiresAt: now + 30_000,
  });

  return value;
}

async function getAccessError(interaction) {
  const currentGuildId = resolveInteractionGuildId(interaction);
  if (!interaction.inGuild() || !currentGuildId) {
    return "This bot can only be used inside a server.";
  }

  const guildAccess = await getGuildAccess(currentGuildId);
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
    interaction.memberPermissions || interaction.member?.permissions;

  if (
    !memberPermissions ||
    (!memberPermissions.has(PermissionFlagsBits.ManageGuild) &&
      !memberPermissions.has(PermissionFlagsBits.Administrator))
  ) {
    return "Only members with a high role can use this bot.";
  }

  return null;
}

function formatRelativeExpiry(expiresAt) {
  if (!expiresAt) return "Never";

  const diff = Number(expiresAt) - Date.now();
  if (diff <= 0) return "Expired";

  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.max(1, totalSeconds)}s`;
}

function shortenKey(key) {
  const value = String(key || "");
  if (value.length <= 20) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function keyDescription(key) {
  const status = key.hwid ? "HWID set" : "No HWID";
  return `${status} • ${formatRelativeExpiry(key.expiresAt)}`.slice(0, 100);
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

function buildCreateButtons(scriptId) {
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
    new ButtonBuilder()
      .setCustomId(`keycustom:create:${scriptId}`)
      .setLabel("Custom Time")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`keys:list:${scriptId}`)
      .setLabel("Manage Keys")
      .setStyle(ButtonStyle.Success),
  );
}

function buildKeysMenu(scriptId, keys, selectedKeyId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`keys:select:${scriptId}`)
      .setPlaceholder("Choose a key")
      .addOptions(
        keys.slice(0, 25).map((key) => ({
          label: shortenKey(key.key).slice(0, 100),
          value: key.id,
          description: keyDescription(key),
          default: key.id === selectedKeyId,
        })),
      ),
  );
}

function buildKeyActions(scriptId, keyId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`keyact:reset:${scriptId}:${keyId}`)
      .setLabel("Reset HWID")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`keycustom:edit:${scriptId}:${keyId}`)
      .setLabel("Edit Time")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`keyact:delete:${scriptId}:${keyId}`)
      .setLabel("Delete Key")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`keys:back:${scriptId}`)
      .setLabel("Back")
      .setStyle(ButtonStyle.Primary),
  );
}

function expiryFromPreset(preset) {
  if (preset === "7d") return 7 * 24 * 60 * 60 * 1000;
  if (preset === "30d") return 30 * 24 * 60 * 60 * 1000;
  return null;
}

function unitToMs(unit) {
  if (unit === "seconds") return 1000;
  if (unit === "minutes") return 60 * 1000;
  if (unit === "hours") return 60 * 60 * 1000;
  if (unit === "days") return 24 * 60 * 60 * 1000;
  if (unit === "months") return 30 * 24 * 60 * 60 * 1000;
  return null;
}

function parseCustomExpiryInput(durationRaw, unitRaw, allowNever = false) {
  const durationText = String(durationRaw || "").trim().toLowerCase();
  const unitText = String(unitRaw || "").trim().toLowerCase();

  if (allowNever && (durationText === "never" || unitText === "never")) {
    return { ok: true, expiresInMs: null };
  }

  const duration = Number(durationText);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, error: "Duration must be a number greater than 0." };
  }

  const unitMs = unitToMs(unitText);
  if (!unitMs) {
    return {
      ok: false,
      error: "Unit must be seconds, minutes, hours, days, or months.",
    };
  }

  return { ok: true, expiresInMs: Math.floor(duration * unitMs) };
}

function buildCustomTimeModal(customId, title, allowNever = false) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("duration")
          .setLabel(allowNever ? "Duration or 'never'" : "Duration")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder(allowNever ? "e.g. 7 or never" : "e.g. 7"),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("unit")
          .setLabel(allowNever ? "Unit or 'never'" : "Unit")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder(allowNever ? "days / hours / never" : "seconds / minutes / hours / days / months"),
      ),
    );
}

function buildKeyDetailsMessage(script, key) {
  return (
    `Script: \`${script?.name || "Unknown"}\`\n` +
    `Key: \`${key?.key || "Unknown"}\`\n` +
    `Expires: \`${key?.expiresAt ? new Date(key.expiresAt).toLocaleString("en-US") : "Never"}\`\n` +
    `HWID: \`${key?.hwid || "Not set"}\`\n` +
    `Uses: \`${key?.useCount || 0}\``
  );
}

async function showKeysManager(interaction, currentGuildId, scriptId, selectedKeyId) {
  const result = await listKeys(currentGuildId, scriptId);
  if (!result.ok) {
    const message = {
      content: result.data?.error || "Failed to load keys.",
      components: [buildCreateButtons(scriptId)],
      ephemeral: true,
    };

    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(message).catch(() => {});
      } else {
        await interaction.reply(message).catch(() => {});
      }
    }
    return;
  }

  const keys = Array.isArray(result.data?.keys) ? result.data.keys : [];
  const script = result.data?.script || null;
  const selectedKey =
    keys.find((key) => key.id === selectedKeyId) || keys[0] || null;

  const components = [];
  if (keys.length > 0) {
    components.push(buildKeysMenu(scriptId, keys, selectedKey?.id));
    components.push(buildKeyActions(scriptId, selectedKey.id));
  } else {
    components.push(buildCreateButtons(scriptId));
  }

  const content = selectedKey
    ? buildKeyDetailsMessage(script, selectedKey)
    : "No keys found for this script yet.";

  if (typeof interaction.update === "function" && interaction.isMessageComponent()) {
    await interaction.update({ content, components });
    return;
  }

  await interaction.reply({
    content,
    components,
    ephemeral: true,
  });
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
        await interaction.reply({ content: accessError, ephemeral: true });
        return;
      }

      if (interaction.commandName === "link") {
        const code = interaction.options.getString("code", true);
        const currentGuildId = resolveInteractionGuildId(interaction);
        const result = await linkAccount(currentGuildId, code);
        if (!result.ok) {
          await interaction.reply({
            content: result.data?.error || "Failed to link account.",
            ephemeral: true,
          });
          return;
        }

        accessCache.delete(currentGuildId);
        await interaction.reply({
          content:
            `Linked this server successfully as \`${result.data.username}\`.\n` +
            "High-role members in this server can now use the bot.",
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "scripts") {
        const currentGuildId = resolveInteractionGuildId(interaction);
        const result = await listScripts(currentGuildId);
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
          content: "Choose a script:",
          components: [buildScriptsMenu(scripts)],
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "logout") {
        const currentGuildId = resolveInteractionGuildId(interaction);
        const result = await unlinkAccount(currentGuildId);
        if (!result.ok) {
          await interaction.reply({
            content: result.data?.error || "Failed to unlink account.",
            ephemeral: true,
          });
          return;
        }

        accessCache.delete(currentGuildId);
        await interaction.reply({
          content: `Unlinked this server from \`${result.data.username}\`.`,
          ephemeral: true,
        });
      }
    }

    if (interaction.isStringSelectMenu()) {
      const accessError = await getAccessError(interaction);
      if (accessError) {
        await interaction.reply({ content: accessError, ephemeral: true });
        return;
      }

      if (interaction.customId === "scripts:select") {
        const scriptId = interaction.values[0];
        await interaction.update({
          content: "Choose a key action:",
          components: [buildCreateButtons(scriptId)],
        });
        return;
      }

      if (interaction.customId.startsWith("keys:select:")) {
        const scriptId = interaction.customId.split(":")[2];
        const currentGuildId = resolveInteractionGuildId(interaction);
        await showKeysManager(interaction, currentGuildId, scriptId, interaction.values[0]);
        return;
      }
    }

    if (interaction.isButton()) {
      const accessError = await getAccessError(interaction);
      if (accessError) {
        await interaction.reply({ content: accessError, ephemeral: true });
        return;
      }

      if (interaction.customId.startsWith("keygen:")) {
        const [, scriptId, preset] = interaction.customId.split(":");
        const currentGuildId = resolveInteractionGuildId(interaction);
        const result = await createKey(
          currentGuildId,
          scriptId,
          expiryFromPreset(preset),
        );

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
        return;
      }

      if (interaction.customId.startsWith("keycustom:create:")) {
        const scriptId = interaction.customId.split(":")[2];
        await interaction.showModal(
          buildCustomTimeModal(
            `modal:create:${scriptId}`,
            "Create Key With Custom Time",
          ),
        );
        return;
      }

      if (interaction.customId.startsWith("keys:list:")) {
        const scriptId = interaction.customId.split(":")[2];
        const currentGuildId = resolveInteractionGuildId(interaction);
        await showKeysManager(interaction, currentGuildId, scriptId, null);
        return;
      }

      if (interaction.customId.startsWith("keys:back:")) {
        const scriptId = interaction.customId.split(":")[2];
        await interaction.update({
          content: "Choose a key action:",
          components: [buildCreateButtons(scriptId)],
        });
        return;
      }

      if (interaction.customId.startsWith("keycustom:edit:")) {
        const [, , scriptId, keyId] = interaction.customId.split(":");
        await interaction.showModal(
          buildCustomTimeModal(
            `modal:edit:${scriptId}:${keyId}`,
            "Edit Key Time",
            true,
          ),
        );
        return;
      }

      if (interaction.customId.startsWith("keyact:reset:")) {
        const [, , scriptId, keyId] = interaction.customId.split(":");
        const currentGuildId = resolveInteractionGuildId(interaction);
        const result = await resetKeyHwid(currentGuildId, scriptId, keyId);
        if (!result.ok) {
          await interaction.reply({
            content: result.data?.error || "Failed to reset HWID.",
            ephemeral: true,
          });
          return;
        }

        await showKeysManager(interaction, currentGuildId, scriptId, keyId);
        return;
      }

      if (interaction.customId.startsWith("keyact:delete:")) {
        const [, , scriptId, keyId] = interaction.customId.split(":");
        const currentGuildId = resolveInteractionGuildId(interaction);
        const result = await deleteKey(currentGuildId, scriptId, keyId);
        if (!result.ok) {
          await interaction.reply({
            content: result.data?.error || "Failed to delete key.",
            ephemeral: true,
          });
          return;
        }

        await showKeysManager(interaction, currentGuildId, scriptId, null);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const accessError = await getAccessError(interaction);
      if (accessError) {
        await interaction.reply({ content: accessError, ephemeral: true });
        return;
      }

      if (interaction.customId.startsWith("modal:create:")) {
        const scriptId = interaction.customId.split(":")[2];
        const parsed = parseCustomExpiryInput(
          interaction.fields.getTextInputValue("duration"),
          interaction.fields.getTextInputValue("unit"),
        );

        if (!parsed.ok) {
          await interaction.reply({ content: parsed.error, ephemeral: true });
          return;
        }

        const currentGuildId = resolveInteractionGuildId(interaction);
        const result = await createKey(currentGuildId, scriptId, parsed.expiresInMs);
        if (!result.ok) {
          await interaction.reply({
            content: result.data?.error || "Failed to generate key.",
            ephemeral: true,
          });
          return;
        }

        const key = result.data?.key;
        const script = result.data?.script;
        await interaction.reply({
          content:
            `Script: \`${script?.name || "Unknown"}\`\n` +
            `Key: \`${key?.key || "Unknown"}\`\n` +
            `Expires: \`${key?.expiresAt ? new Date(key.expiresAt).toLocaleString("en-US") : "Never"}\``,
          ephemeral: true,
        });
        return;
      }

      if (interaction.customId.startsWith("modal:edit:")) {
        const [, , scriptId, keyId] = interaction.customId.split(":");
        const parsed = parseCustomExpiryInput(
          interaction.fields.getTextInputValue("duration"),
          interaction.fields.getTextInputValue("unit"),
          true,
        );

        if (!parsed.ok) {
          await interaction.reply({ content: parsed.error, ephemeral: true });
          return;
        }

        const currentGuildId = resolveInteractionGuildId(interaction);
        const result = await updateKeyExpiry(
          currentGuildId,
          scriptId,
          keyId,
          parsed.expiresInMs,
        );

        if (!result.ok) {
          await interaction.reply({
            content: result.data?.error || "Failed to update key time.",
            ephemeral: true,
          });
          return;
        }

        const listResult = await listKeys(currentGuildId, scriptId);
        if (!listResult.ok) {
          await interaction.reply({
            content: "Key time updated, but I could not reload the key list.",
            ephemeral: true,
          });
          return;
        }

        const keys = Array.isArray(listResult.data?.keys) ? listResult.data.keys : [];
        const script = listResult.data?.script || null;
        const key = keys.find((item) => item.id === keyId) || null;

        if (!key) {
          await interaction.reply({
            content: "Key time updated.",
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          content: `${buildKeyDetailsMessage(script, key)}\nUpdated successfully.`,
          ephemeral: true,
        });
      }
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
