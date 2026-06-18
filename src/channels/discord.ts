import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// Limits for inbound Discord image attachments (downloaded host-side).
const MAX_IMAGES_PER_MSG = 5; // Discord allows up to 10 — only take the first few
const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MB per image
const MAX_RETAINED_ATTACHMENTS = 30; // newest N kept per group workspace

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent.
      // Image attachments are also collected for download into the group workspace.
      const imageAttachments: { url: string; name: string; size: number }[] =
        [];
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              imageAttachments.push({
                url: att.url,
                name: att.name || 'image',
                size: att.size,
              });
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Download image attachments into the group workspace so the agent can
      // view them with its Read tool (/workspace/group is mounted read-write).
      if (imageAttachments.length > 0) {
        const hint = await this.saveImageAttachments(
          group.folder,
          msgId,
          imageAttachments,
        );
        if (hint) {
          content = content ? `${content}\n${hint}` : hint;
        }
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  /**
   * Download Discord image attachments into <group>/attachments/ so the agent
   * can view them with its Read tool. Returns a hint string listing the
   * container-visible paths, or '' if nothing was saved (downloads are
   * best-effort — a failure degrades to the text placeholder, never throws).
   */
  private async saveImageAttachments(
    folder: string,
    msgId: string,
    images: { url: string; name: string; size: number }[],
  ): Promise<string> {
    let attDir: string;
    try {
      attDir = path.join(resolveGroupFolderPath(folder), 'attachments');
      fs.mkdirSync(attDir, { recursive: true });
    } catch (err) {
      logger.warn({ folder, err }, 'Could not prepare attachments dir');
      return '';
    }

    // Cap how many images we download per message (Discord allows up to 10).
    const capped = images.slice(0, MAX_IMAGES_PER_MSG);
    if (images.length > capped.length) {
      logger.warn(
        { folder, total: images.length, kept: capped.length },
        'Too many image attachments — downloading only the first few',
      );
    }

    const savedPaths: string[] = [];
    for (let i = 0; i < capped.length; i++) {
      const img = capped[i];
      // Skip oversized images using Discord's reported size — before any download.
      if (img.size && img.size > MAX_IMAGE_BYTES) {
        logger.warn(
          { name: img.name, size: img.size },
          'Skipping oversized Discord image',
        );
        continue;
      }
      try {
        const res = await fetch(img.url);
        if (!res.ok) {
          logger.warn(
            { name: img.name, status: res.status },
            'Discord image download failed',
          );
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        // Sanitize the filename (msgId is a numeric snowflake) — no traversal.
        const safeName = (img.name || 'image')
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .slice(-64);
        const fileName = `${msgId}-${i}-${safeName}`;
        fs.writeFileSync(path.join(attDir, fileName), buf);
        savedPaths.push(`/workspace/group/attachments/${fileName}`);
        logger.info(
          { folder, fileName, bytes: buf.length },
          'Saved Discord image attachment',
        );
      } catch (err) {
        logger.warn({ name: img.name, err }, 'Discord image download error');
      }
    }

    // Keep the attachments dir bounded — retain only the newest files.
    this.pruneAttachments(attDir, MAX_RETAINED_ATTACHMENTS);

    if (savedPaths.length === 0) return '';
    const list = savedPaths.map((p) => `- ${p}`).join('\n');
    return (
      `The user attached ${savedPaths.length} image(s). ` +
      `Use the Read tool on each path below to view the image contents:\n${list}`
    );
  }

  /** Delete all but the newest `keep` files in an attachments dir (best-effort). */
  private pruneAttachments(attDir: string, keep: number): void {
    try {
      const entries = fs
        .readdirSync(attDir)
        .map((f) => {
          const p = path.join(attDir, f);
          return { p, mtime: fs.statSync(p).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const stale of entries.slice(keep)) {
        try {
          fs.unlinkSync(stale.p);
        } catch {
          /* ignore individual unlink failures */
        }
      }
    } catch {
      /* ignore — pruning is best-effort */
    }
  }

  async sendMessage(jid: string, text: string): Promise<boolean> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return false;
    }
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found');
        return false;
      }
      const textChannel = channel as TextChannel;
      const lines = text.split('\n');
      const textLines: string[] = [];
      const fileAttachments: AttachmentBuilder[] = [];
      const projectRoot = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '..',
        '..',
      );
      const groupsDir = path.join(projectRoot, 'groups');
      let groupFolder = '';
      try {
        const groups = this.opts.registeredGroups();
        const g = groups[jid];
        if (g) groupFolder = g.folder;
      } catch {}
      for (const line of lines) {
        const m = line.match(/^MEDIA:(.+)$/);
        if (m) {
          let fp = m[1].trim();
          if (fp.startsWith('/workspace/group/') && groupFolder) {
            fp = fp.replace(
              '/workspace/group/',
              groupsDir + '/' + groupFolder + '/',
            );
          }
          if (fs.existsSync(fp)) {
            fileAttachments.push(
              new AttachmentBuilder(fp, { name: path.basename(fp) }),
            );
            logger.info({ fp }, 'Discord attachment queued');
          } else {
            textLines.push('[File not found: ' + fp + ']');
          }
        } else {
          textLines.push(line);
        }
      }
      const cleanText = textLines.join('\n').trim();
      const MAX_LENGTH = 2000;
      if (fileAttachments.length > 0) {
        const msgContent =
          cleanText.length > 0 ? cleanText.slice(0, MAX_LENGTH) : undefined;
        await textChannel.send({
          content: msgContent,
          files: fileAttachments.slice(0, 10),
        });
        for (let i = 10; i < fileAttachments.length; i += 10) {
          await textChannel.send({ files: fileAttachments.slice(i, i + 10) });
        }
      } else if (cleanText.length > 0) {
        if (cleanText.length <= MAX_LENGTH) {
          await textChannel.send(cleanText);
        } else {
          for (let i = 0; i < cleanText.length; i += MAX_LENGTH) {
            await textChannel.send(cleanText.slice(i, i + MAX_LENGTH));
          }
        }
      }
      logger.info(
        { jid, length: text.length, attachments: fileAttachments.length },
        'Discord message sent',
      );
      return true;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
      return false;
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
