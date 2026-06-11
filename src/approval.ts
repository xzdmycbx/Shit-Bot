import { Context, Markup } from 'telegraf';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, TextChannel, ButtonInteraction, Client, AttachmentBuilder, MessageFlags, ChatInputCommandInteraction, MessageContextMenuCommandInteraction } from 'discord.js';
import { ProcessedTweet, GroupConfig } from './types';
import { getConfig, getEffectiveGroups } from './config';
import { formatTweetHTML, escapeHTML, formatContentForPlatform } from './filters';
import { sendToTelegram } from './bots/telegram';
import { sendToDiscord, recallMessages, recallMessageById } from './bots/discord';
import { markAsSent, cacheImage, getCachedImage, getSentDiscordMessagesByTweetId, getSentTgMessagesByTweetId, deleteSentMessage, deleteSentTgMessage } from './storage';
import { renderTweetImage } from './renderer';

interface PendingApproval {
  id: string;
  groupName: string;
  tweet: ProcessedTweet;
  telegramMessageIds: Map<string, number>;
  discordMessageIds: Map<string, string>;
  createdAt: Date;
  approved: boolean;
  approvedBy?: string;
  sentTo?: string;
  hasImage: boolean;
}

const pendingApprovals = new Map<string, PendingApproval>();
let telegramBotInstance: any = null;
let discordClientInstance: Client | null = null;

async function retryWithDelay<T>(
  fn: () => Promise<T>,
  retries: number = 3,
  delayMs: number = 2000
): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      console.warn(`Retry ${i + 1}/${retries} after error: ${(error as Error).message}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('Max retries reached');
}

function getTelegramAdminName(ctx: Context): string {
  const from = ctx.callbackQuery?.from;
  if (!from) return 'Unknown';
  if (from.first_name && from.last_name) {
    return `${from.first_name} ${from.last_name}`;
  }
  if (from.first_name) {
    return from.first_name;
  }
  if (from.username) {
    return `@${from.username}`;
  }
  return `User ${from.id}`;
}

function getDiscordAdminName(interaction: ButtonInteraction): string {
  const member = interaction.member;
  if (member && 'displayName' in member) {
    return member.displayName;
  }
  return interaction.user.username;
}

export function setTelegramBot(bot: any): void {
  telegramBotInstance = bot;
}

export function setDiscordClient(client: Client): void {
  discordClientInstance = client;
}

function getGroupTargetTags(group: GroupConfig): { tag: string; telegram: boolean }[] {
  const tags: { tag: string; telegram: boolean }[] = [];

  if (group.telegram?.targets) {
    for (const tag of Object.keys(group.telegram.targets)) {
      tags.push({ tag, telegram: true });
    }
  }

  if (group.discord?.r14ChannelId) {
    if (!tags.find(t => t.tag === 'r14')) {
      tags.push({ tag: 'r14', telegram: false });
    }
  }

  return tags;
}

async function dispatchGroupDirect(tweet: ProcessedTweet, group: GroupConfig, imageBuffer: Buffer | null): Promise<void> {
  const config = getConfig();
  const imageBuf = imageBuffer || getCachedImage(tweet.id) || undefined;

  if (group.telegram && config.telegram.enabled) {
    withTimeout(sendToTelegram(tweet, group.telegram.chatId, true, imageBuf).then(Boolean), 20000, `${group.name}/Telegram`);
    for (const [tag, target] of Object.entries(group.telegram.targets || {})) {
      withTimeout(sendToTelegram(tweet, target.chatId, true, imageBuf).then(Boolean), 20000, `${group.name}/Telegram/${tag}`);
    }
  }

  if (group.discord && config.discord.enabled) {
    withTimeout(sendToDiscord(tweet, group.discord.channelId, true, imageBuf).then(Boolean), 20000, `${group.name}/Discord`);
  }
}

export async function sendForApproval(tweet: ProcessedTweet): Promise<boolean> {
  const config = getConfig();
  const groups = getEffectiveGroups();

  const useImage = !!config.xToImageApiUrl;
  let imageBuffer: Buffer | null = null;

  if (useImage) {
    imageBuffer = await renderTweetImage(tweet);
    if (imageBuffer) {
      cacheImage(tweet.id, imageBuffer);
    }
  }

  let anySent = false;

  for (const group of groups) {
    if (group.blockedUsers?.includes(tweet.author)) {
      console.log(`Skipping approval for group ${group.name}: blocked user @${tweet.author}`);
      continue;
    }

    if (group.users && group.users.length > 0 && !group.users.some(u => u.username === tweet.author)) {
      continue;
    }

    const approvalId = `${group.name}:${tweet.id}_${Date.now()}`;
    const telegramMessageIds = new Map<string, number>();
    const discordMessageIds = new Map<string, string>();
    let sentToTelegram = false;
    let sentToDiscord = false;

    if (config.telegram.enabled && group.approval?.telegramAdminChatIds?.length) {
      const tags = getGroupTargetTags(group);
      const buttons: any[][] = [];

      if (tags.length > 0) {
        const row: any[] = [];
        row.push(Markup.button.callback('📢 Post All', `approve_${approvalId}`));
        for (const t of tags) {
          const label = t.tag === 'r14' ? '🔞 Post R14' : `📢 Post ${t.tag.toUpperCase()}`;
          row.push(Markup.button.callback(label, `post_${t.tag}_${approvalId}`));
        }
        row.push(Markup.button.callback('❌ Reject', `reject_${approvalId}`));
        buttons.push(row);
      } else {
        buttons.push([
          Markup.button.callback('📢 Post', `approve_${approvalId}`),
          Markup.button.callback('❌ Reject', `reject_${approvalId}`),
        ]);
      }

      const keyboard = Markup.inlineKeyboard(buttons);

      const hasExplicitGroups = !!(config.groups && config.groups.length > 0);

      const header = hasExplicitGroups
        ? `📮 <b>Pending Approval</b>\n<b>Group:</b> ${escapeHTML(group.name)}\n\n`
        : '📮 <b>Pending Approval</b>\n\n';

      const adminMessage = useImage && imageBuffer
        ? `${header}<b>@${escapeHTML(tweet.author)}</b>\n<a href="${tweet.url}">🔗 View on X</a>\n\n<i>ID: ${approvalId}</i>`
        : `${header}${formatTweetHTML(tweet)}\n\n<i>ID: ${approvalId}</i>`;

      if (telegramBotInstance) {
        for (const adminId of group.approval.telegramAdminChatIds) {
          try {
            if (useImage && imageBuffer) {
              const sentMessage = await retryWithDelay(() =>
                telegramBotInstance.telegram.sendPhoto(
                  adminId,
                  { source: imageBuffer! },
                  {
                    caption: adminMessage.substring(0, 1024),
                    parse_mode: 'HTML',
                    ...keyboard,
                  }
                )
              ) as any;
              telegramMessageIds.set(adminId, sentMessage.message_id);
            } else {
              const sentMessage = await retryWithDelay(() =>
                telegramBotInstance.telegram.sendMessage(
                  adminId,
                  adminMessage,
                  {
                    parse_mode: 'HTML',
                    ...keyboard,
                  }
                )
              ) as any;
              telegramMessageIds.set(adminId, sentMessage.message_id);
            }
            sentToTelegram = true;
          } catch (error) {
            console.error(`Failed to send Telegram approval for group ${group.name} to ${adminId}:`, error);
          }
        }
      }
    }

    if (config.discord.enabled && group.discord && group.approval?.discordAdminChannelId && discordClientInstance) {
      try {
        const channel = await discordClientInstance.channels.fetch(group.approval.discordAdminChannelId);
        if (channel && channel.isTextBased()) {
          const hasExplicitGroups = !!(config.groups && config.groups.length > 0);

          const title = hasExplicitGroups
            ? `📮 Pending Approval — ${escapeHTML(group.name)}`
            : '📮 Pending Approval';

          const embed = new EmbedBuilder()
            .setTitle(title)
            .setAuthor({
              name: `@${tweet.author}`,
              url: `https://x.com/${tweet.author}`,
              iconURL: `https://unavatar.io/twitter/${tweet.author}`,
            })
            .setURL(tweet.url)
            .setTimestamp(tweet.publishedAt)
            .setColor('#FFA500')
            .setFooter({ text: `ID: ${approvalId}` });

          if (useImage && imageBuffer) {
            embed.setDescription(`[🔗 View on X](${tweet.url})`);
          } else {
            embed.setDescription(formatContentForPlatform(tweet.content.substring(0, 2000), 'discord'));
          }

          const tags = getGroupTargetTags(group);
          const rows: ActionRowBuilder<ButtonBuilder>[] = [];

          if (tags.length > 0) {
            const postRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`approve_${approvalId}`)
                .setLabel('📢 Post All')
                .setStyle(ButtonStyle.Success)
            );
            for (const t of tags) {
              const label = t.tag === 'r14' ? '🔞 Post R14' : `📢 Post ${t.tag.toUpperCase()}`;
              postRow.addComponents(
                new ButtonBuilder()
                  .setCustomId(`post_${t.tag}_${approvalId}`)
                  .setLabel(label)
                  .setStyle(ButtonStyle.Primary)
              );
            }
            postRow.addComponents(
              new ButtonBuilder()
                .setCustomId(`reject_${approvalId}`)
                .setLabel('❌ Reject')
                .setStyle(ButtonStyle.Danger)
            );
            rows.push(postRow);
          } else {
            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`approve_${approvalId}`)
                .setLabel('📢 Post')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`reject_${approvalId}`)
                .setLabel('❌ Reject')
                .setStyle(ButtonStyle.Danger)
            ));
          }

          let files: AttachmentBuilder[] | undefined;

          if (useImage && imageBuffer) {
            const attachment = new AttachmentBuilder(imageBuffer, { name: `tweet_${tweet.id}.png` });
            embed.setImage(`attachment://tweet_${tweet.id}.png`);
            files = [attachment];
          }

          const sentMessage = await (channel as TextChannel).send({
            embeds: [embed],
            components: rows,
            files,
          });

          discordMessageIds.set(group.approval.discordAdminChannelId, sentMessage.id);
          sentToDiscord = true;
        }
      } catch (error) {
        console.error(`Failed to send Discord approval for group ${group.name}:`, error);
      }
    }

    if (sentToTelegram || sentToDiscord) {
      anySent = true;

      pendingApprovals.set(approvalId, {
        id: approvalId,
        groupName: group.name,
        tweet,
        telegramMessageIds,
        discordMessageIds,
        createdAt: new Date(),
        approved: false,
        hasImage: useImage && imageBuffer !== null,
      });

      console.log(`Sent tweet ${tweet.id} for approval (group: ${group.name}): ${approvalId}`);
    }

    if (!sentToTelegram && !sentToDiscord) {
      anySent = true;
      console.log(`Group ${group.name} has no approval config, sending directly`);
      await dispatchGroupDirect(tweet, group, imageBuffer);
    }
  }

  if (anySent) {
    markAsSent(tweet.id, tweet.author, tweet.content, tweet.url);
    return true;
  }

  return false;
}

async function notifyOtherAdmins(
  approval: PendingApproval,
  actionBy: string,
  action: 'approved' | 'rejected',
  sentTo?: string
): Promise<void> {
  const statusEmoji = action === 'approved' ? '✅' : '❌';
  const statusText = action === 'approved' ? 'Approved' : 'Rejected';
  const sentToStr = sentTo ? ` → ${sentTo}` : '';
  const cfg = getConfig();
  const hasExplicitGroups = !!(cfg.groups && cfg.groups.length > 0);
  const groupLabel = hasExplicitGroups ? ` (${escapeHTML(approval.groupName)})` : '';

  if (approval.telegramMessageIds.size > 0) {
    const tweet = approval.tweet;
    const notification = [
      `${statusEmoji} <b>Tweet ${statusText}${sentToStr}${groupLabel}</b>`,
      '',
      `<b>@${escapeHTML(tweet.author)}</b> (${escapeHTML(tweet.authorName)})`,
      `<a href="${tweet.url}">🔗 View on X</a>`,
      '',
      `By: ${escapeHTML(actionBy)}`,
      `ID: <code>${approval.id}</code>`,
      `Time: ${approval.createdAt.toLocaleString()}`,
      '',
      `<i>${formatContentForPlatform(tweet.content.substring(0, 100), 'html')}${tweet.content.length > 100 ? '...' : ''}</i>`,
    ].join('\n');

    const showRecallButton = action === 'approved';
    const replyMarkup = showRecallButton
      ? { reply_markup: Markup.inlineKeyboard([
          Markup.button.callback('↩️ 撤回', `recall_${approval.id}`),
        ]).reply_markup }
      : {};

    for (const [adminId, messageId] of approval.telegramMessageIds) {
      try {
        if (approval.hasImage) {
          await telegramBotInstance?.telegram.editMessageCaption(
            adminId,
            messageId,
            undefined,
            notification,
            { parse_mode: 'HTML', ...replyMarkup }
          );
        } else {
          await telegramBotInstance?.telegram.editMessageText(
            adminId,
            messageId,
            undefined,
            notification,
            { parse_mode: 'HTML', ...replyMarkup }
          );
        }
      } catch (error) {
        console.warn(`Failed to notify Telegram admin ${adminId}:`, error);
      }
    }
  }

  if (approval.discordMessageIds.size > 0 && discordClientInstance) {
    const tweet = approval.tweet;
    const embed = new EmbedBuilder()
      .setTitle(`${statusEmoji} Tweet ${statusText}${sentToStr}${groupLabel}`)
      .setAuthor({
        name: `@${tweet.author}`,
        url: `https://x.com/${tweet.author}`,
        iconURL: `https://unavatar.io/twitter/${tweet.author}`,
      })
      .setURL(tweet.url)
      .addFields(
        { name: 'By', value: actionBy, inline: true },
        { name: 'ID', value: `\`${approval.id}\``, inline: true },
        { name: 'Time', value: approval.createdAt.toLocaleString(), inline: true },
      )
      .setColor(action === 'approved' ? '#00FF00' : '#FF0000');

    if (approval.hasImage) {
      embed.setImage(`attachment://tweet_${tweet.id}.png`);
    } else {
      embed.setDescription(
        formatContentForPlatform(tweet.content.substring(0, 100), 'discord') + (tweet.content.length > 100 ? '...' : '')
      );
    }

    const showRecallButton = action === 'approved';
    const components: ActionRowBuilder<ButtonBuilder>[] = showRecallButton
      ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`recall_${approval.id}`)
            .setLabel('↩ 撤回')
            .setStyle(ButtonStyle.Danger)
        )]
      : [];

    for (const [channelId, messageId] of approval.discordMessageIds) {
      try {
        const channel = await discordClientInstance.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
          const message = await (channel as TextChannel).messages.fetch(messageId);
          const existingAttachment = approval.hasImage ? message.attachments.first() : undefined;
          const files = existingAttachment
            ? [{ attachment: existingAttachment.url, name: `tweet_${tweet.id}.png` }]
            : undefined;
          await message.edit({ embeds: [embed], components, files });
        }
      } catch (error) {
        console.warn(`Failed to notify Discord channel ${channelId}:`, error);
      }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<void> {
  return Promise.race([
    promise.then(() => {
      console.log(`Send ${label}: OK`);
    }),
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`Send ${label}: TIMEOUT (${ms}ms)`);
        resolve();
      }, ms);
      timer.unref();
    }),
  ]).catch((err) => {
    console.error(`Send ${label}: ERROR - ${(err as Error).message}`);
  });
}

function dispatchToTargets(pending: PendingApproval, targetTag?: string): void {
  const config = getConfig();
  const groups = getEffectiveGroups();
  const group = groups.find(g => g.name === pending.groupName);
  const imageBuf = getCachedImage(pending.tweet.id) || undefined;

  if (!group) {
    console.error(`Group ${pending.groupName} not found for approval ${pending.id}`);
    return;
  }

  if (targetTag === 'r14' && group.discord?.r14ChannelId) {
    pending.sentTo = 'R14 (Discord)';
    withTimeout(sendToDiscord(pending.tweet, group.discord.r14ChannelId, true, imageBuf).then(Boolean), 20000, `${pending.groupName}/Discord/R14`);
    return;
  }

  if (targetTag && group.telegram?.targets?.[targetTag]) {
    const targetChatId = group.telegram.targets[targetTag].chatId;
    pending.sentTo = `${targetTag.toUpperCase()}`;
    withTimeout(sendToTelegram(pending.tweet, targetChatId, true, imageBuf).then(Boolean), 20000, `${pending.groupName}/Telegram/${targetTag}`);
    return;
  }

  if (targetTag) {
    console.warn(`Unknown target tag: ${targetTag} in group ${pending.groupName}, falling back to all`);
  }

  pending.sentTo = 'All';
  if (group.telegram && config.telegram.enabled) {
    withTimeout(sendToTelegram(pending.tweet, group.telegram.chatId, true, imageBuf).then(Boolean), 20000, `${pending.groupName}/Telegram/main`);
  }

  for (const [tag, target] of Object.entries(group.telegram?.targets || {})) {
    withTimeout(sendToTelegram(pending.tweet, target.chatId, true, imageBuf).then(Boolean), 20000, `${pending.groupName}/Telegram/${tag}`);
  }

  if (group.discord && config.discord.enabled) {
    withTimeout(sendToDiscord(pending.tweet, group.discord.channelId, true, imageBuf).then(Boolean), 20000, `${pending.groupName}/Discord`);
  }
}

export async function handleTelegramApproval(ctx: Context): Promise<void> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery || !('data' in callbackQuery)) return;

  const data = callbackQuery.data;

  const sendMatch = data.match(/^post_(.+?)_(.+)$/);
  const isApprove = data.startsWith('approve_');
  const isReject = data.startsWith('reject_');
  const isSendTag = !!sendMatch;

  if (!isApprove && !isReject && !isSendTag) return;

  let approvalId: string;
  let targetTag: string | undefined;

  if (isSendTag) {
    targetTag = sendMatch![1];
    approvalId = sendMatch![2];
  } else {
    approvalId = data.replace(/^(approve_|reject_)/, '');
  }

  const pending = pendingApprovals.get(approvalId);

  if (!pending) {
    try {
      await ctx.answerCbQuery('Approval not found or expired');
    } catch (e) {
      // ignore
    }
    return;
  }

  if (pending.approved) {
    try {
      await ctx.answerCbQuery('This tweet has already been approved');
    } catch (e) {
      // ignore
    }
    return;
  }

  const config = getConfig();
  const adminName = getTelegramAdminName(ctx);

  if (!isReject) {
    pending.approved = true;
    pending.approvedBy = adminName;

    dispatchToTargets(pending, targetTag);

    await notifyOtherAdmins(pending, adminName, 'approved', pending.sentTo);
    console.log(`Approved by ${adminName} (Telegram) [${pending.groupName}]: ${approvalId}${targetTag ? ` → ${targetTag}` : ''}`);
  } else {
    await notifyOtherAdmins(pending, adminName, 'rejected');
    console.log(`Rejected by ${adminName} (Telegram) [${pending.groupName}]: ${approvalId}`);
    pendingApprovals.delete(approvalId);
  }
}

export async function handleDiscordApproval(interaction: ButtonInteraction): Promise<void> {
  try {
    await handleDiscordApprovalImpl(interaction);
  } catch (err) {
    console.error('Discord approval handler error:', err);
    try {
      if (!interaction.replied) {
        await interaction.reply({ content: 'An error occurred', flags: MessageFlags.Ephemeral });
      }
    } catch {}
  }
}

async function handleDiscordApprovalImpl(interaction: ButtonInteraction): Promise<void> {
  const customId = interaction.customId;

  const sendMatch = customId.match(/^post_(.+?)_(.+)$/);
  const isApprove = customId.startsWith('approve_');
  const isReject = customId.startsWith('reject_');
  const isSendTag = !!sendMatch;

  if (!isApprove && !isReject && !isSendTag) return;

  let approvalId: string;
  let targetTag: string | undefined;

  if (isSendTag) {
    targetTag = sendMatch![1];
    approvalId = sendMatch![2];
  } else {
    approvalId = customId.replace(/^(approve_|reject_)/, '');
  }

  const pending = pendingApprovals.get(approvalId);

  if (!pending) {
    await interaction.reply({ content: 'Approval not found or expired', flags: MessageFlags.Ephemeral });
    return;
  }

  if (pending.approved) {
    await interaction.reply({ content: 'This tweet has already been approved', flags: MessageFlags.Ephemeral });
    return;
  }

  const config = getConfig();
  const group = getEffectiveGroups().find(g => g.name === pending.groupName);

  if (group?.approval?.discordApproveRoleId) {
    const member = interaction.member;
    if (!member || !('roles' in member) || !(member.roles as any).cache?.has(group.approval.discordApproveRoleId)) {
      await interaction.reply({ content: '❌ 你没有审批权限', flags: MessageFlags.Ephemeral });
      return;
    }
  } else if (config.discord.approveRoleId) {
    const member = interaction.member;
    if (!member || !('roles' in member) || !(member.roles as any).cache?.has(config.discord.approveRoleId)) {
      await interaction.reply({ content: '❌ 你没有审批权限', flags: MessageFlags.Ephemeral });
      return;
    }
  }

  const adminName = getDiscordAdminName(interaction);

  await interaction.deferUpdate();

  if (!isReject) {
    pending.approved = true;
    pending.approvedBy = adminName;

    dispatchToTargets(pending, targetTag);

    await notifyOtherAdmins(pending, adminName, 'approved', pending.sentTo);
    console.log(`Approved by ${adminName} (Discord) [${pending.groupName}]: ${approvalId}${targetTag ? ` → ${targetTag}` : ''}`);
  } else {
    await notifyOtherAdmins(pending, adminName, 'rejected');
    console.log(`Rejected by ${adminName} (Discord) [${pending.groupName}]: ${approvalId}`);
    pendingApprovals.delete(approvalId);
  }
}

export function getPendingCount(): number {
  return pendingApprovals.size;
}

function checkRecallPermission(interaction: ButtonInteraction | ChatInputCommandInteraction | MessageContextMenuCommandInteraction): boolean {
  const config = getConfig();
  const member = interaction.member;
  if (!member || !('roles' in member)) return false;

  const approveRoleIds = new Set<string>();
  const groups = getEffectiveGroups();
  for (const g of groups) {
    if (g.approval?.discordApproveRoleId) {
      approveRoleIds.add(g.approval.discordApproveRoleId);
    }
  }
  if (config.discord.approveRoleId) {
    approveRoleIds.add(config.discord.approveRoleId);
  }

  if (approveRoleIds.size === 0) return true;

  const roles = (member as any).roles;
  if (roles.cache) {
    for (const id of approveRoleIds) {
      if (roles.cache.has(id)) return true;
    }
    return false;
  }

  if (Array.isArray(roles)) {
    return roles.some((r: string) => approveRoleIds.has(r));
  }

  return false;
}

export async function handleRecallCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!checkRecallPermission(interaction)) {
      await interaction.reply({ content: '❌ 你没有撤回权限', flags: MessageFlags.Ephemeral });
      return;
    }

    const messageId = interaction.options.get('message_id')?.value as string | undefined;
    const link = interaction.options.get('link')?.value as string | undefined;

    if (messageId) {
      const deleted = await recallMessageById(messageId);
      await interaction.reply({
        content: deleted ? `已撤回消息 ${messageId}` : `未找到消息 ${messageId}，或该消息不是 bot 发送的`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (link) {
      const match = link.match(/discord\.com\/channels\/\d+\/(\d+)\/(\d+)/);
      if (!match) {
        await interaction.reply({ content: '无效的消息链接', flags: MessageFlags.Ephemeral });
        return;
      }
      const linkMsgId = match[2];
      const deleted = await recallMessageById(linkMsgId);
      await interaction.reply({
        content: deleted ? `已撤回消息 ${linkMsgId}` : `未找到消息 ${linkMsgId}，或该消息不是 bot 发送的`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const count = (interaction.options.get('count')?.value as number) || 5;
    const deleted = await recallMessages(interaction.channelId, Math.min(count, 20));
    await interaction.reply({
      content: `已尝试撤回最近 ${count} 条消息，成功撤回 ${deleted} 条`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    console.error('Recall command error:', error);
    try {
      await interaction.reply({ content: '撤回失败: 内部错误', flags: MessageFlags.Ephemeral });
    } catch {}
  }
}

export async function handleRecallMessageContextMenu(interaction: MessageContextMenuCommandInteraction): Promise<void> {
  try {
    if (!checkRecallPermission(interaction)) {
      await interaction.reply({ content: '❌ 你没有撤回权限', flags: MessageFlags.Ephemeral });
      return;
    }

    const target = interaction.targetMessage;
    if (target.author.id !== interaction.client.user.id) {
      await interaction.reply({ content: '该消息不是 bot 发送的，无法撤回', flags: MessageFlags.Ephemeral });
      return;
    }

    await target.delete();
    deleteSentMessage(target.id);
    await interaction.reply({ content: '已撤回该消息', flags: MessageFlags.Ephemeral });
  } catch (error) {
    console.error('Recall context menu error:', error);
    try {
      await interaction.reply({ content: '撤回失败: 内部错误', flags: MessageFlags.Ephemeral });
    } catch {}
  }
}

async function recallDispatchedMessages(approvalId: string): Promise<number> {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return 0;

  const groups = getEffectiveGroups();
  const group = groups.find(g => g.name === pending.groupName);

  const discordChannelIds = new Set<string>();
  const telegramChatIds = new Set<string>();

  if (group) {
    if (group.discord?.channelId) discordChannelIds.add(group.discord.channelId);
    if (group.discord?.r14ChannelId) discordChannelIds.add(group.discord.r14ChannelId);
    if (group.telegram?.chatId) telegramChatIds.add(group.telegram.chatId);
    if (group.telegram?.targets) {
      for (const target of Object.values(group.telegram.targets)) {
        telegramChatIds.add(target.chatId);
      }
    }
  }

  const tweetId = pending.tweet.id;
  let deleted = 0;

  const discordRecords = getSentDiscordMessagesByTweetId(tweetId);
  for (const record of discordRecords) {
    if (!discordChannelIds.has(record.channel_id)) {
      continue;
    }
    try {
      if (discordClientInstance) {
        const channel = await discordClientInstance.channels.fetch(record.channel_id);
        if (channel && channel.isTextBased()) {
          const message = await (channel as TextChannel).messages.fetch(record.message_id);
          await message.delete();
          deleted++;
        }
      }
      deleteSentMessage(record.message_id);
    } catch (error) {
      deleteSentMessage(record.message_id);
    }
  }

  const tgRecords = getSentTgMessagesByTweetId(tweetId);
  if (telegramBotInstance) {
    for (const record of tgRecords) {
      if (!telegramChatIds.has(record.chat_id)) {
        continue;
      }
      try {
        await telegramBotInstance.telegram.deleteMessage(record.chat_id, record.message_id);
        deleted++;
        deleteSentTgMessage(record.message_id, record.chat_id);
      } catch (error) {
        deleteSentTgMessage(record.message_id, record.chat_id);
      }
    }
  }

  pendingApprovals.delete(approvalId);
  return deleted;
}

async function notifyRecallAdmins(approval: PendingApproval, adminName: string, deletedCount: number): Promise<void> {
  const cfg = getConfig();
  const hasExplicitGroups = !!(cfg.groups && cfg.groups.length > 0);
  const groupLabel = hasExplicitGroups ? ` (${escapeHTML(approval.groupName)})` : '';

  if (approval.telegramMessageIds.size > 0 && telegramBotInstance) {
    for (const [adminId, messageId] of approval.telegramMessageIds) {
      try {
        const tweet = approval.tweet;
        let notice: string;
        if (approval.hasImage) {
          notice = [
            `↩️ <b>撤回成功 — 已删除 ${deletedCount} 条消息${groupLabel}</b>`,
            '',
            `<b>@${escapeHTML(tweet.author)}</b> (${escapeHTML(tweet.authorName)})`,
            `<a href="${tweet.url}">🔗 View on X</a>`,
            '',
            `By: ${escapeHTML(adminName)}`,
            `ID: <code>${approval.id}</code>`,
          ].join('\n');

          await telegramBotInstance.telegram.editMessageCaption(
            adminId, messageId, undefined, notice,
            { parse_mode: 'HTML' }
          );
        } else {
          notice = [
            `↩️ <b>撤回成功 — 已删除 ${deletedCount} 条消息${groupLabel}</b>`,
            '',
            `<b>@${escapeHTML(tweet.author)}</b> (${escapeHTML(tweet.authorName)})`,
            `<a href="${tweet.url}">🔗 View on X</a>`,
            '',
            `By: ${escapeHTML(adminName)}`,
            `ID: <code>${approval.id}</code>`,
          ].join('\n');

          await telegramBotInstance.telegram.editMessageText(
            adminId, messageId, undefined, notice,
            { parse_mode: 'HTML' }
          );
        }
      } catch (error) {
        console.warn(`Failed to notify recall to Telegram admin ${adminId}:`, error);
      }
    }
  }

  if (approval.discordMessageIds.size > 0 && discordClientInstance) {
    const tweet = approval.tweet;
    const embed = new EmbedBuilder()
      .setTitle(`↩️ 撤回成功 — 已删除 ${deletedCount} 条消息${groupLabel}`)
      .setAuthor({
        name: `@${tweet.author}`,
        url: `https://x.com/${tweet.author}`,
        iconURL: `https://unavatar.io/twitter/${tweet.author}`,
      })
      .setURL(tweet.url)
      .addFields(
        { name: 'By', value: adminName, inline: true },
        { name: 'ID', value: `\`${approval.id}\``, inline: true },
      )
      .setColor('#FFA500');

    for (const [channelId, messageId] of approval.discordMessageIds) {
      try {
        const channel = await discordClientInstance.channels.fetch(channelId);
        if (channel && channel.isTextBased()) {
          const message = await (channel as TextChannel).messages.fetch(messageId);
          await message.edit({ embeds: [embed], components: [] });
        }
      } catch (error) {
        console.warn(`Failed to notify recall to Discord channel ${channelId}:`, error);
      }
    }
  }
}

export async function handleTelegramRecall(ctx: Context): Promise<void> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery || !('data' in callbackQuery)) return;

  const data = callbackQuery.data;
  if (!data.startsWith('recall_')) return;

  const approvalId = data.replace('recall_', '');
  const pending = pendingApprovals.get(approvalId);

  if (!pending) {
    try { await ctx.answerCbQuery('Approval not found or expired'); } catch (e) {}
    return;
  }

  if (!pending.approved) {
    try { await ctx.answerCbQuery('The tweet has not been approved'); } catch (e) {}
    return;
  }

  const adminName = getTelegramAdminName(ctx);
  try { await ctx.answerCbQuery('Recalling...'); } catch (e) {}

  const deleted = await recallDispatchedMessages(approvalId);
  await notifyRecallAdmins(pending, adminName, deleted);
  console.log(`Recalled by ${adminName} (Telegram) [${pending.groupName}]: ${approvalId} — deleted ${deleted} messages`);
}

export async function handleDiscordRecall(interaction: ButtonInteraction): Promise<void> {
  try {
    const customId = interaction.customId;
    if (!customId.startsWith('recall_')) return;

    const approvalId = customId.replace('recall_', '');
    const pending = pendingApprovals.get(approvalId);

    if (!pending) {
      await interaction.reply({ content: 'Approval not found or expired', flags: MessageFlags.Ephemeral });
      return;
    }

    if (!pending.approved) {
      await interaction.reply({ content: 'The tweet has not been approved', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate();
    const adminName = getDiscordAdminName(interaction);
    const deleted = await recallDispatchedMessages(approvalId);
    await notifyRecallAdmins(pending, adminName, deleted);
    console.log(`Recalled by ${adminName} (Discord) [${pending.groupName}]: ${approvalId} — deleted ${deleted} messages`);
  } catch (error) {
    console.error('Discord recall handler error:', error);
  }
}

export function cleanupExpiredApprovals(maxAgeMinutes: number = 60): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, approval] of pendingApprovals) {
    const age = (now - approval.createdAt.getTime()) / (1000 * 60);
    if (age > maxAgeMinutes) {
      pendingApprovals.delete(id);
      cleaned++;
    }
  }

  return cleaned;
}

export async function sendToAllGroups(tweet: ProcessedTweet): Promise<void> {
  const config = getConfig();
  const groups = getEffectiveGroups();
  const imageBuf = getCachedImage(tweet.id) || undefined;

  for (const group of groups) {
    if (group.blockedUsers?.includes(tweet.author)) {
      console.log(`Skipping group ${group.name}: blocked user @${tweet.author}`);
      continue;
    }

    if (group.users && group.users.length > 0 && !group.users.some(u => u.username === tweet.author)) {
      continue;
    }

    if (group.telegram && config.telegram.enabled) {
      withTimeout(sendToTelegram(tweet, group.telegram.chatId, true, imageBuf).then(Boolean), 20000, `${group.name}/Telegram/main`);
      for (const [tag, target] of Object.entries(group.telegram.targets || {})) {
        withTimeout(sendToTelegram(tweet, target.chatId, true, imageBuf).then(Boolean), 20000, `${group.name}/Telegram/${tag}`);
      }
    }

    if (group.discord && config.discord.enabled) {
      withTimeout(sendToDiscord(tweet, group.discord.channelId, true, imageBuf).then(Boolean), 20000, `${group.name}/Discord`);
    }
  }
}
