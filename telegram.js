// telegram.js - Pump.fun Bot con SCALPING COMMANDS

import TelegramBot from 'node-telegram-bot-api';
import IORedis from 'ioredis';
import { getPriceService } from './priceService.js';
import { 
  getScalpingStats, 
  addTokenToWatchlist, 
  removeTokenFromWatchlist 
} from './scalpingEngine.js';

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

    console.log('✅ Telegram bot initialized');

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
          : '📝 PAPER';

      const scalpingEnabled = 
        (process.env.ENABLE_SCALPING || '').trim().toLowerCase() === 'true';

      await safeSend(
        chatId,
        `💼 Pump.fun Bot with SCALPING\n\n` +
          `Mode: ${mode}\n` +
          `Scalping: ${scalpingEnabled ? '✅ Enabled' : '❌ Disabled'}\n\n` +
          `📊 General:\n` +
          `/status       - Bot status + P&L\n` +
          `/positions    - Posiciones abiertas (todas)\n` +
          `/stats        - Stats del día (Sniper)\n\n` +
          `⚡ Scalping:\n` +
          `/scalp_stats  - Stats de scalping\n` +
          `/scalp_pos    - Posiciones de scalping activas\n` +
          `/watch MINT   - Agregar token a watchlist\n` +
          `/unwatch MINT - Quitar token de watchlist\n\n` +
          `💰 Trading:\n` +
          `/sell MINT    - Cerrar posición específica\n` +
          `/sell_all     - Cerrar todas las posiciones\n\n` +
          `ℹ️ El bot combina 2 estrategias:\n` +
          `   🎯 Sniper: Mints nuevos (Flintr)\n` +
          `   ⚡ Scalping: Momentum (pumps)`
      );
    });

    // ═════════════════════════════════════════════════════
    // /status - Estado general
    // ═════════════════════════════════════════════════════
    bot.onText(/\/status/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no disponible');
      }

      try {
        const mode =
          (process.env.DRY_RUN || '').trim().toLowerCase() === 'false'
            ? '💰 LIVE'
            : '📝 PAPER';

        const scalpingEnabled = 
          (process.env.ENABLE_SCALPING || '').trim().toLowerCase() === 'true';

        const openMints = await redis.scard('open_positions');
        const scalpMints = await redis.scard('scalp:active_positions');
        const sniperMints = openMints - scalpMints;

        let message = `📊 Bot Status\n\n`;
        message += `Mode: ${mode}\n\n`;
        message += `🎯 Sniper Positions: ${sniperMints}\n`;
        
        if (scalpingEnabled) {
          message += `⚡ Scalping Positions: ${scalpMints}\n`;
        }
        
        message += `📦 Total Open: ${openMints}\n\n`;

        // Stats del día
        const { RiskManager } = await import('./riskManager.js');
        const riskManager = new RiskManager({}, redis);
        const stats = await riskManager.getDailyStats();

        if (stats && stats.totalTrades > 0) {
          message += `💰 Today (Sniper Realized):\n`;
          message += `Trades: ${stats.totalTrades}\n`;
          message += `Win Rate: ${stats.winRate}\n`;
          message += `P&L: ${stats.totalPnL} SOL\n`;
        } else {
          message += `💰 No trades yet today\n`;
        }

        await safeSend(chatId, message);
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /scalp_stats - Stats de scalping
    // ═════════════════════════════════════════════════════
    bot.onText(/\/scalp_stats/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;

      const scalpingEnabled = 
        (process.env.ENABLE_SCALPING || '').trim().toLowerCase() === 'true';

      if (!scalpingEnabled) {
        return safeSend(
          chatId,
          '⚠️ Scalping está deshabilitado.\nSet ENABLE_SCALPING=true para habilitar.'
        );
      }

      try {
        const stats = getScalpingStats();

        const winRate = stats.wins + stats.losses > 0
          ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(2)
          : '0.00';

        let message = `⚡ SCALPING STATS\n\n`;
        message += `📊 Activity:\n`;
        message += `Scans: ${stats.scansPerformed}\n`;
        message += `Pumps Detected: ${stats.pumpsDetected}\n`;
        message += `Entries: ${stats.entriesExecuted}\n`;
        message += `Exits: ${stats.exitsExecuted}\n\n`;
        
        message += `💰 Performance:\n`;
        message += `Win Rate: ${winRate}%\n`;
        message += `Wins: ${stats.wins} | Losses: ${stats.losses}\n`;
        message += `Total P&L: ${stats.totalPnL.toFixed(6)} SOL\n\n`;
        
        message += `📦 Positions:\n`;
        message += `Active: ${stats.activePositions}/${stats.maxPositions}\n`;

        await safeSend(chatId, message);
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /scalp_pos - Posiciones de scalping activas
    // ═════════════════════════════════════════════════════
    bot.onText(/\/scalp_pos/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no disponible');
      }

      try {
        const stats = getScalpingStats();

        if (stats.activePositions === 0) {
          return safeSend(
            chatId,
            '⚡ No hay posiciones de scalping activas.\n\n' +
            'El motor busca tokens con momentum (pumps rápidos).'
          );
        }

        let message = `⚡ SCALPING POSITIONS\n\n`;

        for (let i = 0; i < stats.positions.length; i++) {
          const pos = stats.positions[i];
          
          message += `${i + 1}. ${pos.mint}\n`;
          message += `   Entry: ${pos.entryPrice.toFixed(10)}\n`;
          message += `   Pump: ${pos.pumpPercent.toFixed(2)}%\n`;
          message += `   Hold: ${pos.holdTimeSec}s\n`;
          message += `   /sell ${pos.mint.split('...')[0]}\n\n`;
        }

        await safeSend(chatId, message);
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /watch - Agregar a watchlist
    // ═════════════════════════════════════════════════════
    bot.onText(/\/watch(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;

      const mintArg = match?.[1]?.trim();

      if (!mintArg) {
        return safeSend(
          chatId,
          `⚡ Watchlist de Scalping\n\n` +
          `Agrega tokens para que el motor de scalping los monitoree.\n\n` +
          `Uso: /watch MINT\n` +
          `Ejemplo: /watch 7xKXtGH4Ab...`
        );
      }

      try {
        const success = await addTokenToWatchlist(mintArg);
        
        if (success) {
          await safeSend(
            chatId,
            `✅ Token agregado a watchlist de scalping\n\n` +
            `Mint: ${mintArg.slice(0, 20)}...\n\n` +
            `El motor escaneará este token en busca de pumps.`
          );
        } else {
          await safeSend(chatId, `❌ Error agregando token a watchlist`);
        }
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /unwatch - Quitar de watchlist
    // ═════════════════════════════════════════════════════
    bot.onText(/\/unwatch(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;

      const mintArg = match?.[1]?.trim();

      if (!mintArg) {
        return safeSend(
          chatId,
          `Uso: /unwatch MINT\n` +
          `Ejemplo: /unwatch 7xKXtGH4Ab...`
        );
      }

      try {
        const success = await removeTokenFromWatchlist(mintArg);
        
        if (success) {
          await safeSend(
            chatId,
            `✅ Token removido de watchlist\n\n` +
            `Mint: ${mintArg.slice(0, 20)}...`
          );
        } else {
          await safeSend(chatId, `❌ Error removiendo token`);
        }
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /positions - Todas las posiciones
    // ═════════════════════════════════════════════════════
    bot.onText(/\/positions/, async (msg) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no disponible');
      }

      try {
        const { PositionManager } = await import('./riskManager.js');
        const positionManager = new PositionManager(redis);
        const positions = await positionManager.getOpenPositions();

        if (positions.length === 0) {
          return safeSend(
            chatId,
            '🔭 No hay posiciones abiertas'
          );
        }

        let message = `📈 POSICIONES ABIERTAS (${positions.length})\n\n`;

        for (let i = 0; i < positions.length; i++) {
          const pos = positions[i];
          const strategy = pos.entry_strategy || pos.strategy || 'unknown';
          const emoji = strategy === 'scalping' ? '⚡' : '🎯';
          
          const entryPrice = parseFloat(pos.entryPrice || '0');
          const solAmount = parseFloat(pos.solAmount || '0');

          message += `${emoji} ${i + 1}. ${strategy.toUpperCase()}\n`;
          message += `Mint: ${pos.mint.slice(0, 12)}...\n`;
          message += `Entry: ${entryPrice.toFixed(10)}\n`;
          message += `Size: ${solAmount.toFixed(4)} SOL\n`;
          message += `/sell ${pos.mint.slice(0, 8)}\n\n`;
        }

        await safeSend(chatId, message);
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // /sell - Cerrar posición
    // ═════════════════════════════════════════════════════
    bot.onText(/\/sell(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!isOwner(chatId)) return;
      if (!redis) {
        return safeSend(chatId, '❌ Redis no disponible');
      }

      const mintArg = match?.[1]?.trim();

      if (!mintArg) {
        return safeSend(
          chatId,
          `💰 Manual Sell\n\n` +
            `Uso: /sell MINT\n` +
            `Ejemplo: /sell 7xKXtGH4\n\n` +
            `Usa /positions para ver posiciones.`
        );
      }

      try {
        await safeSend(chatId, '⏳ Procesando venta...');

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
            `❌ No se encontró posición para: ${mintArg}`
          );
        }

        const position = await redis.hgetall(`position:${targetMint}`);
        if (!position || position.status !== 'open') {
          return safeSend(chatId, `❌ Posición inválida o ya cerrada`);
        }

        const entryPrice = parseFloat(position.entryPrice || '0');
        const solAmount = parseFloat(position.solAmount || '0');
        const tokensAmount = parseInt(position.tokensAmount || '0', 10);

        const valueData = await priceService.calculateCurrentValue(
          targetMint,
          tokensAmount
        );

        let exitPrice = entryPrice;
        let solReceived = solAmount;

        if (valueData && valueData.solValue && valueData.marketPrice) {
          exitPrice = valueData.marketPrice;
          solReceived = valueData.solValue;
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
          'TELEGRAM'
        );

        const dryRun =
          (process.env.DRY_RUN || '').trim().toLowerCase() !== 'false';
        const mode = dryRun ? '📝 PAPER' : '💰 LIVE';

        await safeSend(
          chatId,
          `✅ ${mode} MANUAL SELL\n\n` +
            `Mint: ${targetMint.slice(0, 12)}...\n` +
            `Entry: ${entryPrice.toFixed(10)}\n` +
            `Exit: ${exitPrice.toFixed(10)}\n\n` +
            `💰 PnL: ${pnlPercent.toFixed(2)}%\n` +
            `Amount: ${pnlSOL.toFixed(4)} SOL`
        );
      } catch (error) {
        await safeSend(
          chatId,
          `❌ Error: ${error?.message || String(error)}`
        );
      }
    });

    // ═════════════════════════════════════════════════════
    // Polling error handler
    // ═════════════════════════════════════════════════════
    bot.on('polling_error', (error) => {
      console.log(
        'Telegram polling error:',
        error?.message || String(error)
      );
    });

    console.log('✅ Telegram commands registered (with SCALPING)\n');
  } catch (error) {
    console.error(
      '❌ Failed to initialize Telegram bot:',
      error?.message || String(error)
    );
  }
}

export async function sendTelegramAlert(chatId, message, silent = false) {
  await safeSend(chatId, message, silent);
}
