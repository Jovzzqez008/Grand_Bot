// server.js - Pump.fun Sniper Bot API with ENV CLEANER

import 'dotenv/config';
import { cleanAndValidateEnv } from './envCleaner.js';

// 🧹 Limpiar/validar ENV primero
console.log('🚀 Starting Pump.fun Sniper Bot Server...\n');
const envCleaner = cleanAndValidateEnv();

import express from 'express';
import IORedis from 'ioredis';
import { getPriceService } from './priceService.js';
import { RiskManager } from './riskManager.js';

const app = express();
app.use(express.json());

let redis;
try {
  redis = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    retryDelayOnFailover: 100,
  });

  console.log('✅ Redis connected for server\n');
} catch (error) {
  console.log('⚠️ Redis not available for server:', error?.message ?? String(error));
  redis = null;
}

const priceService = getPriceService();

// 🩺 Health check simple
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    mode: process.env.DRY_RUN !== 'false' ? 'PAPER' : 'LIVE',
    timestamp: new Date().toISOString(),
  });
});

// Raíz: info básica del bot
app.get('/', (req, res) => {
  res.json({
    message: '🎯 Pump.fun Sniper Bot API (Flintr)',
    mode: process.env.DRY_RUN !== 'false' ? '📄 PAPER' : '💰 LIVE',
  });
});

// 📊 Status sniper: posiciones abiertas + PnL no realizado + stats del día
app.get('/status', async (req, res) => {
  try {
    if (!redis) {
      return res.json({ error: 'Redis not available' });
    }

    const dryRun = process.env.DRY_RUN !== 'false';
    const maxPositions = parseInt(process.env.MAX_POSITIONS || '2', 10);

    const openMints = await redis.smembers('open_positions');
    const positions = [];
    let totalSolSpent = 0;
    let totalSolNow = 0;

    for (const mint of openMints) {
      const pos = await redis.hgetall(`position:${mint}`);
      if (!pos || pos.status !== 'open') {
        continue;
      }

      const entryPrice = parseFloat(pos.entryPrice || '0');
      const solAmount = parseFloat(pos.solAmount || '0');
      const tokensAmount = parseInt(pos.tokensAmount || '0', 10);
      const entryTime = parseInt(pos.entryTime || '0', 10);
      const entryStrategy = pos.entry_strategy || pos.strategy || 'unknown';

      if (!entryPrice || !solAmount || !tokensAmount || !entryTime) {
        continue;
      }

      // Solo PnL correcto para las posiciones donde podamos calcular valor
      let currentPrice = entryPrice;
      let solNow = solAmount;
      let pnlSOL = 0;
      let pnlPercent = 0;
      let graduated = false;
      let source = 'entry_price_fallback';

      try {
        const valueData = await priceService.calculateCurrentValue(mint, tokensAmount);
        if (valueData && valueData.solValue && valueData.marketPrice) {
          currentPrice = valueData.marketPrice;
          solNow = valueData.solValue;
          pnlSOL = solNow - solAmount;
          pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
          graduated = !!valueData.graduated;
          source = valueData.source || 'market';
        }
      } catch {
        // si falla, usamos entryPrice y solAmount como fallback
      }

      totalSolSpent += solAmount;
      totalSolNow += solNow;

      const holdTimeSec = Math.floor((Date.now() - entryTime) / 1000);

      positions.push({
        mint,
        symbol: pos.symbol || 'UNKNOWN',
        entryStrategy,
        status: pos.status,
        entryPrice,
        currentPrice,
        solSpent: solAmount,
        solNow,
        pnlSOL,
        pnlPercent,
        graduated,
        priceSource: source,
        holdTimeSeconds: holdTimeSec,
      });
    }

    const unrealizedPnL = totalSolNow - totalSolSpent;

    // Stats diarios realizados (trades cerrados) vía RiskManager
    let dailyStats = null;
    try {
      const riskManager = new RiskManager({}, redis);
      dailyStats = await riskManager.getDailyStats();
    } catch (e) {
      // si falla, lo dejamos en null
    }

    res.json({
      mode: dryRun ? '📄 PAPER TRADING' : '💰 LIVE TRADING',
      positions: {
        count: positions.length,
        max: maxPositions,
        list: positions,
      },
      pnl: {
        unrealizedPnL,
        totalSolSpent,
        totalSolNow,
        dailyStats,
      },
      config: {
        positionSizeSOL: process.env.POSITION_SIZE_SOL || '0.05',
        maxPositions: process.env.MAX_POSITIONS || '2',
        minLiquiditySOL: process.env.MIN_LIQUIDITY_SOL || process.env.MIN_INITIAL_VOLUME_SOL || '0',
        onlyKingOfHill: (process.env.ONLY_KING_OF_HILL || '').trim().toLowerCase() === 'true',
        stopLossPercent:
          (process.env.STOP_LOSS_ENABLED || '').trim().toLowerCase() === 'true'
            ? `-${process.env.STOP_LOSS_PERCENT || '13'}%`
            : 'Disabled',
        takeProfitPercent:
          (process.env.TAKE_PROFIT_ENABLED || '').trim().toLowerCase() === 'true'
            ? `+${process.env.TAKE_PROFIT_PERCENT || '30'}%`
            : 'Disabled',
        trailingStopPercent:
          (process.env.TRAILING_STOP_ENABLED || '').trim().toLowerCase() === 'true'
            ? `-${process.env.TRAILING_STOP_PERCENT || '15'}%`
            : 'Disabled',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 📈 Stats del día (solo PnL REALIZADO)
app.get('/stats', async (req, res) => {
  try {
    if (!redis) {
      return res.json({ error: 'Redis not available' });
    }

    const riskManager = new RiskManager({}, redis);
    const stats = await riskManager.getDailyStats();

    if (!stats) {
      return res.json({ message: 'No trades today yet' });
    }

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🧹 Cleanup simple de posiciones abiertas "rotas"
app.post('/cleanup', async (req, res) => {
  try {
    if (!redis) {
      return res.json({ error: 'Redis not available' });
    }

    const openMints = await redis.smembers('open_positions');
    let cleaned = 0;

    for (const mint of openMints) {
      const pos = await redis.hgetall(`position:${mint}`);
      if (!pos || !pos.status || pos.status !== 'open') {
        await redis.srem('open_positions', mint);
        cleaned++;
      }
    }

    const remaining = await redis.scard('open_positions');

    res.json({
      success: true,
      cleaned,
      remaining,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔍 Debug ENV (solo fuera de producción, no muestra secretos)
app.get('/debug/env', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }

  res.json({
    privateKeyLength: process.env.PRIVATE_KEY?.length || 0,
    privateKeyValid: (process.env.PRIVATE_KEY || '').length === 88,
    rpcUrlValid: !!process.env.RPC_URL && process.env.RPC_URL.startsWith('https://'),
    redisUrlValid: !!process.env.REDIS_URL,
    pumpProgramId: process.env.PUMP_PROGRAM_ID,
    dryRun: process.env.DRY_RUN,
    enableAutoTrading: process.env.ENABLE_AUTO_TRADING,
    flintrApiKeySet: !!process.env.FLINTR_API_KEY,
    positionSizeSOL: process.env.POSITION_SIZE_SOL,
    maxPositions: process.env.MAX_POSITIONS,
  });
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}\n`);
  initializeModules();
});

// Inicializar módulos "externos" (solo Telegram en modo sniper)
async function initializeModules() {
  try {
    // 1) Telegram
    if (process.env.TELEGRAM_BOT_TOKEN) {
      try {
        const { initTelegram } = await import('./telegram.js');
        await initTelegram();
        console.log('✅ Telegram bot started\n');
      } catch (error) {
        console.log('⚠️ Telegram bot failed:', error.message);
      }
    } else {
      console.log('⚠️ TELEGRAM_BOT_TOKEN missing - Telegram skipped\n');
    }

    console.log('🎯 Pump.fun Sniper Configuration:');
    console.log(`   Position Size: ${process.env.POSITION_SIZE_SOL || '0.05'} SOL`);
    console.log(`   Max Positions: ${process.env.MAX_POSITIONS || '2'}`);
    console.log(
      `   Min Liquidity: ${process.env.MIN_LIQUIDITY_SOL || process.env.MIN_INITIAL_VOLUME_SOL || '0'} SOL`,
    );
    console.log(
      `   Only King of Hill: ${
        (process.env.ONLY_KING_OF_HILL || '').trim().toLowerCase() === 'true' ? 'Enabled' : 'Disabled'
      }`,
    );
    console.log(
      `   Stop Loss: ${
        (process.env.STOP_LOSS_ENABLED || '').trim().toLowerCase() === 'true'
          ? `Enabled (-${process.env.STOP_LOSS_PERCENT || '13'}%)`
          : 'Disabled'
      }`,
    );
    console.log(
      `   Take Profit: ${
        (process.env.TAKE_PROFIT_ENABLED || '').trim().toLowerCase() === 'true'
          ? `Enabled (+${process.env.TAKE_PROFIT_PERCENT || '30'}%)`
          : 'Disabled'
      }`,
    );
    console.log(
      `   Trailing Stop: ${
        (process.env.TRAILING_STOP_ENABLED || '').trim().toLowerCase() === 'true'
          ? `Enabled (-${process.env.TRAILING_STOP_PERCENT || '15'}%)`
          : 'Disabled'
      }\n`,
    );

    const mode = process.env.DRY_RUN !== 'false' ? '📄 PAPER TRADING' : '💰 LIVE TRADING';
    console.log(`🚀 Bot is ready in ${mode} mode\n`);
  } catch (error) {
    console.log('❌ Module initialization failed:', error.message);
  }
}

process.on('unhandledRejection', (err) => {
  console.log('Unhandled rejection:', err?.message ?? String(err));
});
