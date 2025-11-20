// telegram.js - Pump.fun Sniper Bot (Flintr + PnL + DRY_RUN)

import TelegramBot from 'node-telegram-bot-api';
import IORedis from 'ioredis';
import { getPriceService } from './priceService.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID =
  process.env.TELEGRAM_OWNER_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

let bot;
let redis;
const priceService = getPriceService();

function isOwner(chatId) {
  if (!OWNER_CHAT_ID) return true;
  return chatId.toString() === OWNER_CHAT_ID.toString();
}

async function safeSend(chatId, text, silent = false) {
  if (!bot || !chatId) return false;

  try {
    const cleanText = text
      .replace(/\*/g, '')
      .replace(/`/g, '')
      .replace(/_/g, '')
      .replace(/\[/g, '')
      .replace(/\]/g, '');

    await bot.sendMessage(chatId, cleanText, {
      disable_notification: silent,
    });
    return true;
  } catch (error) {
    console.log('⚠️ Telegram send failed:', error?.message || String(error));
    return false;
  }
}

export async function initTelegram() {
  if (!BOT_TOKEN) {
    console.log('⚠️ TELEGRAM_BOT_TOKEN not set, skipping Telegram bot');
    return;
  }

  try {
    bot = new TelegramBot(BOT_TOKEN, {
      polling: true,
      request: {
        agentOptions: {
          keepAlive: true,
          family: 4,
        },
      },
    });

    if (!process.env.REDIS_URL) {
      console.log('⚠️ REDIS_URL not set, Telegram will not have state access');
    } else {
      redis = new IORedis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        retryDelayOnFailover: 100,
      });

      redis.on('error', (err) => {
        console.log(
          '⚠️ Telegram Redis error:',
          err?.message || String(err),
        );
      });
    }

    console.log('✅ Telegram bot initialized (Pump.fun Sniper Mode)');

    // ═════════════════════════════════════════════════════
    // /start - Help
    // ═════════════════════════════════════════════════════
    bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) {
        return bot.sendMessage(chatId, '⛔ Unauthorized');
      }

      const mode =
        (process.env.DRY_RUN || '').trim().toLowerCase() === 'false'
          ? '💰 LIVE'
          : '📝 PAPER (DRY_RUN)';

      await safeSend(
        chatId,
        `💼 Pump.fun Sniper Bot\n\n` +
          `Mode: ${mode}\n\n` +
          `📊 General:\n` +
          `/status    - Estado del bot + P&L abierto\n` +
          `/positions - Posiciones abiertas (Flintr)\n` +
          `/stats     - Rendimiento de hoy (realizado)\n\n` +
          `💰 Trading (Sniper / Flintr):\n` +
          `/sell MINT  - Cerrar UNA posición (simulado si DRY_RUN)\n` +
          `/sell_all   - Cerrar TODAS las posiciones (simulado si DRY_RUN)\n\n` +
          `ℹ️ Copy trading está DESACTIVADO. Solo se usan señales de Flintr y el motor sniper.`,
      );
    });

    // ═════════════════════════════════════════════════════
    // /status - Estado general + PnL abierto
    // ═════════════════════════════════════════════════════
    bot.onText(/\/status/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no está configurado para Telegram.');
      }

      try {
        const mode =
          (process.env.DRY_RUN || '').trim().toLowerCase() === 'false'
            ? '💰 LIVE'
            : '📝 PAPER';
        const maxPositions = parseInt(process.env.MAX_POSITIONS || '2', 10);

        const openMints = await redis.smembers('open_positions');
        const openPositions = [];
        for (const mint of openMints) {
          const pos = await redis.hgetall(`position:${mint}`);
          if (pos && pos.status === 'open') {
            openPositions.push({ mint, ...pos });
          }
        }

        const sniperPositions = openPositions.filter(
          (p) => p.entry_strategy === 'flintr' || p.strategy === 'flintr',
        );

        let totalSolSpent = 0;
        let totalSolNow = 0;

        for (const pos of sniperPositions) {
          const tokensAmount = parseInt(pos.tokensAmount || '0', 10);
          const solAmount = parseFloat(pos.solAmount || '0');
          if (!tokensAmount || !solAmount) continue;

          const valueData = await priceService.calculateCurrentValue(
            pos.mint,
            tokensAmount,
          );
          if (!valueData || !valueData.solValue) continue;

          totalSolSpent += solAmount;
          totalSolNow += valueData.solValue;
        }

        const unrealizedPnL = totalSolNow - totalSolSpent;

        const { RiskManager } = await import('./riskManager.js');
        const riskManager = new RiskManager({}, redis);
        const stats = await riskManager.getDailyStats();

        let statsText = 'No trades yet today';
        if (stats && stats.totalTrades > 0) {
          statsText =
            `Trades: ${stats.totalTrades} (Wins: ${stats.wins}, Losses: ${stats.losses})\n` +
            `Win Rate: ${stats.winRate}\n` +
            `Realized P&L: ${stats.totalPnL} SOL`;
        }

        await safeSend(
          chatId,
          `📊 Status (Pump.fun Sniper)\n\n` +
            `Mode: ${mode}\n` +
            `Open Sniper Positions (Flintr): ${sniperPositions.length}/${maxPositions}\n` +
            `Total Open Positions (cualquier estrategia): ${openPositions.length}\n\n` +
            `💰 Unrealized P&L (solo Flintr): ${unrealizedPnL.toFixed(4)} SOL\n\n` +
            `📈 Today's Performance (realizado):\n` +
            `${statsText}`,
        );
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`,
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /positions - Posiciones abiertas (solo sniper / Flintr)
    // ═════════════════════════════════════════════════════
    bot.onText(/\/positions/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no está configurado para Telegram.');
      }

      try {
        const { PositionManager } = await import('./riskManager.js');
        const positionManager = new PositionManager(redis);
        const positions = await positionManager.getOpenPositions();

        const sniperPositions = positions.filter(
          (p) => p.entry_strategy === 'flintr' || p.strategy === 'flintr',
        );

        if (sniperPositions.length === 0) {
          return safeSend(
            chatId,
            '🔭 No hay posiciones abiertas del sniper (Flintr).\n\n' +
              'Espera a que lleguen nuevas señales y el bot abra entradas.',
          );
        }

        let message = '📈 Open Sniper Positions (Flintr):\n\n';

        for (let i = 0; i < sniperPositions.length; i++) {
          const pos = sniperPositions[i];
          const entryPrice = parseFloat(pos.entryPrice || '0');
          const solAmount = parseFloat(pos.solAmount || '0');
          const tokensAmount = parseInt(pos.tokensAmount || '0', 10);
          const entryTime = parseInt(pos.entryTime || '0', 10);

          if (!entryPrice || !solAmount || !tokensAmount || !entryTime) {
            continue;
          }

          const priceData = await priceService.getPriceWithFallback(pos.mint);
          let currentPrice = entryPrice;
          let isGraduated = false;

          if (priceData && priceData.price && !isNaN(priceData.price)) {
            currentPrice = priceData.price;
            isGraduated = !!priceData.graduated;
          }

          const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
          const pnlSOL = (pnlPercent / 100) * solAmount;
          const emoji = pnlPercent >= 0 ? '🟢' : '🔴';
          const holdTimeSec = ((Date.now() - entryTime) / 1000).toFixed(0);

          const posNum = i + 1;
          const gradTag = isGraduated ? ' 🎓' : '';

          message += `${emoji} Position ${posNum}${gradTag}\n`;
          message += `Mint: ${pos.mint.slice(0, 12)}...\n`;
          message += `Size: ${solAmount.toFixed(4)} SOL\n`;
          message += `Entry: ${entryPrice.toFixed(10)}\n`;
          message += `Current: ${currentPrice.toFixed(10)}\n`;
          message += `PnL: ${pnlPercent.toFixed(2)}% | ${pnlSOL.toFixed(
            4,
          )} SOL\n`;
          message += `Hold: ${holdTimeSec}s\n`;
          message += `/sell ${pos.mint.slice(0, 8)}\n\n`;
        }

        await safeSend(chatId, message);
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`,
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /sell - Cerrar UNA posición (simulación si DRY_RUN)
    // ═════════════════════════════════════════════════════
    bot.onText(/\/sell(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no está configurado para Telegram.');
      }

      const mintArg = match?.[1]?.trim();

      if (!mintArg) {
        return safeSend(
          chatId,
          `💰 Manual Sell (Sniper)\n\n` +
            `Uso: /sell MINT\n` +
            `Ejemplo: /sell 7xKXtGH4\n\n` +
            `Usa /positions para ver las posiciones abiertas.`,
        );
      }

      try {
        await safeSend(
          chatId,
          '⏳ Procesando venta manual (simulada si DRY_RUN)...',
        );

        const openMints = await redis.smembers('open_positions');
        let targetMint = null;

        for (const mint of openMints) {
          if (mint.startsWith(mintArg) || mint.includes(mintArg)) {
            targetMint = mint;
            break;
          }
        }

        if (!targetMint) {
          return safeSend(
            chatId,
            `❌ No se encontró posición para: ${mintArg}`,
          );
        }

        const position = await redis.hgetall(`position:${targetMint}`);
        if (!position || position.status !== 'open') {
          return safeSend(chatId, `❌ Posición inválida o ya cerrada`);
        }

        if (
          position.entry_strategy !== 'flintr' &&
          position.strategy !== 'flintr' &&
          position.strategy !== 'sniper'
        ) {
          return safeSend(
            chatId,
            `⚠️ Esta posición no es del sniper (Flintr).\n` +
              `Por seguridad, solo se permite /sell en posiciones del sniper.`,
          );
        }

        const entryPrice = parseFloat(position.entryPrice || '0');
        const solAmount = parseFloat(position.solAmount || '0');
        const tokensAmount = parseInt(position.tokensAmount || '0', 10);

        if (!entryPrice || !solAmount || !tokensAmount) {
          return safeSend(
            chatId,
            `❌ Datos incompletos de la posición, no se puede cerrar.`,
          );
        }

        const valueData = await priceService.calculateCurrentValue(
          targetMint,
          tokensAmount,
        );

        let exitPrice = entryPrice;
        let solReceived = solAmount;
        let source = 'entry_price_fallback';

        if (valueData && valueData.solValue && valueData.marketPrice) {
          exitPrice = valueData.marketPrice;
          solReceived = valueData.solValue;
          source = valueData.source || 'market';
        }

        const pnlSOL = solReceived - solAmount;
        const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;

        const { PositionManager } = await import('./riskManager.js');
        const positionManager = new PositionManager(redis);

        await positionManager.closePosition(
          targetMint,
          exitPrice,
          tokensAmount,
          solReceived,
          'telegram_manual_sell',
          'TELEGRAM_SIMULATED',
        );

        const dryRun =
          (process.env.DRY_RUN || '').trim().toLowerCase() !== 'false';
        const mode = dryRun ? '📝 PAPER (SIMULATED)' : '💰 LIVE (NO TX)';
        const gradTag = valueData?.graduated ? ' 🎓' : '';

        await safeSend(
          chatId,
          `✅ ${mode} MANUAL SELL${gradTag}\n\n` +
            `Mint: ${targetMint.slice(0, 12)}...\n` +
            `Source: ${source}\n` +
            `Entry: ${entryPrice.toFixed(10)}\n` +
            `Exit: ${exitPrice.toFixed(10)}\n\n` +
            `💰 PnL: ${pnlPercent.toFixed(2)}%\n` +
            `Amount: ${pnlSOL.toFixed(4)} SOL\n`,
        );
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`,
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /sell_all - Cerrar TODAS las posiciones sniper (simulación)
    // ═════════════════════════════════════════════════════
    bot.onText(/\/sell_all/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no está configurado para Telegram.');
      }

      try {
        await safeSend(
          chatId,
          '⏳ Cerrando TODAS las posiciones del sniper (simulado si DRY_RUN)...',
        );

        const { PositionManager } = await import('./riskManager.js');
        const positionManager = new PositionManager(redis);
        const positions = await positionManager.getOpenPositions();

        const sniperPositions = positions.filter(
          (p) =>
            p.entry_strategy === 'flintr' ||
            p.strategy === 'flintr' ||
            p.strategy === 'sniper',
        );

        if (sniperPositions.length === 0) {
          return safeSend(
            chatId,
            '🔭 No hay posiciones del sniper para cerrar.',
          );
        }

        let closed = 0;
        let failed = 0;

        for (const pos of sniperPositions) {
          try {
            const entryPrice = parseFloat(pos.entryPrice || '0');
            const solAmount = parseFloat(pos.solAmount || '0');
            const tokensAmount = parseInt(pos.tokensAmount || '0', 10);

            if (!entryPrice || !solAmount || !tokensAmount) {
              failed++;
              continue;
            }

            const valueData = await priceService.calculateCurrentValue(
              pos.mint,
              tokensAmount,
            );

            let exitPrice = entryPrice;
            let solReceived = solAmount;

            if (valueData && valueData.solValue && valueData.marketPrice) {
              exitPrice = valueData.marketPrice;
              solReceived = valueData.solValue;
            }

            await positionManager.closePosition(
              pos.mint,
              exitPrice,
              tokensAmount,
              solReceived,
              'telegram_manual_sell_all',
              'TELEGRAM_SIMULATED',
            );
            closed++;
          } catch (e) {
            failed++;
          }
        }

        await safeSend(
          chatId,
          `✅ SELL ALL (Sniper / Flintr)\n\n` +
            `Closed: ${closed}\n` +
            `Failed: ${failed}\n\n` +
            `ℹ️ En DRY_RUN esto es solo actualización de P&L, no se envían transacciones.`,
        );
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`,
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /stats - Rendimiento del día (realizado)
    // ═════════════════════════════════════════════════════
    bot.onText(/\/stats/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no está configurado para Telegram.');
      }

      try {
        const { RiskManager } = await import('./riskManager.js');
        const riskManager = new RiskManager({}, redis);
        const stats = await riskManager.getDailyStats();

        if (!stats || stats.totalTrades === 0) {
          return safeSend(chatId, '🔭 No trades today yet');
        }

        await safeSend(
          chatId,
          `📊 Pump.fun Sniper - Today's Performance\n\n` +
            `Total Trades: ${stats.totalTrades}\n` +
            `Wins: ${stats.wins} | Losses: ${stats.losses}\n` +
            `Win Rate: ${stats.winRate}\n\n` +
            `Realized P&L: ${stats.totalPnL} SOL\n` +
            `Avg P&L: ${stats.avgPnL} SOL\n` +
            `Best: ${stats.biggestWin} SOL\n` +
            `Worst: ${stats.biggestLoss} SOL\n`,
        );
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`,
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // Errores de polling
    // ═════════════════════════════════════════════════════
    bot.on('polling_error', (error) => {
      console.log(
        'Telegram polling error:',
        error?.message || String(error),
      );
    });

    console.log('✅ Telegram sniper commands registered');
  } catch (error) {
    console.error(
      '❌ Failed to initialize Telegram bot:',
      error?.message || String(error),
    );
  }
}

export async function sendTelegramAlert(chatId, message, silent = false) {
  await safeSend(chatId, message, silent);
}
