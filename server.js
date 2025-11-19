// server.js - Pump.fun Sniper Bot API with ENV CLEANER

import 'dotenv/config';
import { cleanAndValidateEnv } from './envCleaner.js';

// 🧹 CRITICAL: Clean environment variables FIRST
console.log('🚀 Starting Pump.fun Sniper Bot Server...\n');
const envCleaner = cleanAndValidateEnv();

import express from 'express';
import IORedis from 'ioredis';

const app = express();
app.use(express.json());

let redis;
try {
  redis = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    retryDelayOnFailover: 100
  });
  console.log('✅ Redis connected for server\n');
} catch (error) {
  console.log('⚠️ Redis not available for server');
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Root: basic info
app.get('/', (req, res) => {
  res.json({
    message: '🎯 Pump.fun Sniper Bot API',
    mode: process.env.DRY_RUN !== 'false' ? 'PAPER' : 'LIVE'
  });
});

// 📊 Status endpoint (SNIPER-FOCUSED)
app.get('/status', async (req, res) => {
  try {
    if (!redis) {
      return res.json({ error: 'Redis not available' });
    }

    const dryRun = process.env.DRY_RUN !== 'false';
    const openPositionMints = await redis.smembers('open_positions');
    const openPositionsCount = openPositionMints.length;
    const maxPositions = process.env.MAX_POSITIONS || '2';

    // Leer detalles básicos de posiciones
    const positions = [];
    for (const mint of openPositionMints) {
      const position = await redis.hgetall(`position:${mint}`);
      if (position && Object.keys(position).length > 0) {
        const entryPrice = position.entryPrice ? parseFloat(position.entryPrice) : null;
        const entryTime = position.entryTime ? parseInt(position.entryTime) : null;

        let holdTimeSec = null;
        if (!isNaN(entryTime)) {
          holdTimeSec = Math.floor((Date.now() - entryTime) / 1000);
        }

        positions.push({
          mint: mint,
          symbol: position.symbol || 'UNKNOWN',
          status: position.status || 'open',
          entryPrice,
          holdTimeSeconds: holdTimeSec,
          strategy: position.entry_strategy || position.strategy || 'sniper'
        });
      }
    }

    // PnL diario realizado usando la misma key que RiskManager (trades:YYYY-MM-DD)
    let dailyRealizedPnL = 0;
    let tradesToday = 0;
    try {
      const today = new Date().toISOString().split('T')[0];
      const trades = await redis.lrange(`trades:${today}`, 0, -1);
      tradesToday = trades.length;

      for (const tradeJson of trades) {
        const trade = JSON.parse(tradeJson);
        if (trade.pnlSOL) {
          dailyRealizedPnL += parseFloat(trade.pnlSOL);
        }
      }
    } catch (err) {
      console.log('⚠️ Failed to compute daily PnL in /status:', err.message);
    }

    res.json({
      mode: dryRun ? '📄 PAPER TRADING' : '💰 LIVE TRADING',
      positions: {
        count: openPositionsCount,
        max: maxPositions,
        list: positions
      },
      pnl: {
        dailyRealizedPnL,
        tradesToday
      },
      config: {
        positionSizeSOL: process.env.POSITION_SIZE_SOL || '0.05',
        maxPositions: maxPositions,
        minLiquiditySOL: process.env.MIN_LIQUIDITY_SOL || process.env.MIN_INITIAL_VOLUME_SOL || '0',
        onlyKingOfHill: process.env.ONLY_KING_OF_HILL === 'true',
        stopLossPercent: process.env.STOP_LOSS_ENABLED === 'true'
          ? `-${process.env.STOP_LOSS_PERCENT || '10'}%`
          : 'Disabled',
        takeProfitPercent: process.env.TAKE_PROFIT_ENABLED === 'true'
          ? `+${process.env.TAKE_PROFIT_PERCENT || '30'}%`
          : 'Disabled',
        trailingStopPercent: process.env.TRAILING_STOP_ENABLED === 'true'
          ? `-${process.env.TRAILING_STOP_PERCENT || '15'}%`
          : 'Disabled'
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 📊 Today's stats (reuse RiskManager logic)
app.get('/stats', async (req, res) => {
  try {
    if (!redis) {
      return res.json({ error: 'Redis not available' });
    }

    const { RiskManager } = await import('./riskManager.js');
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

// 🧹 Cleanup endpoint (igual que antes, pero sin copy trading)
app.post('/cleanup', async (req, res) => {
  try {
    if (!redis) {
      return res.json({ error: 'Redis not available' });
    }

    let cleaned = 0;

    // Limpiar open_positions
    const openPositions = await redis.smembers('open_positions');
    for (const mint of openPositions) {
      const position = await redis.hgetall(`position:${mint}`);

      if (!position || Object.keys(position).length === 0 || position.status === 'closed') {
        await redis.srem('open_positions', mint);
        cleaned++;
      }
    }

    res.json({
      success: true,
      cleaned,
      remaining: {
        openPositions: await redis.scard('open_positions')
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔍 Debug env endpoint (only show lengths/validation)
app.get('/debug/env', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }

  res.json({
    privateKeyLength: process.env.PRIVATE_KEY?.length || 0,
    privateKeyValid: process.env.PRIVATE_KEY?.length === 88,
    rpcUrlValid: process.env.RPC_URL?.startsWith('https://'),
    redisUrlValid: !!process.env.REDIS_URL,
    pumpProgramId: process.env.PUMP_PROGRAM_ID,
    priorityFee: process.env.PRIORITY_FEE,
    positionSize: process.env.POSITION_SIZE_SOL,
    dryRun: process.env.DRY_RUN,
    autoTrading: process.env.ENABLE_AUTO_TRADING
  });
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`✅ Server running on port ${port}\n`);
  initializeModules();
});

async function initializeModules() {
  try {
    console.log('🔧 Initializing modules...\n');

    // 1. Iniciar Telegram bot (ya sin Wallet Tracker)
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
    console.log(`   Min Liquidity: ${process.env.MIN_LIQUIDITY_SOL || process.env.MIN_INITIAL_VOLUME_SOL || '0'} SOL`);
    console.log(`   Only King of Hill: ${process.env.ONLY_KING_OF_HILL === 'true' ? 'Enabled' : 'Disabled'}`);
    console.log(
      `   Stop Loss: ${
        process.env.STOP_LOSS_ENABLED === 'true'
          ? `Enabled (-${process.env.STOP_LOSS_PERCENT || '10'}%)`
          : 'Disabled'
      }`
    );
    console.log(
      `   Take Profit: ${
        process.env.TAKE_PROFIT_ENABLED === 'true'
          ? `Enabled (+${process.env.TAKE_PROFIT_PERCENT || '30'}%)`
          : 'Disabled'
      }`
    );
    console.log(
      `   Trailing Stop: ${
        process.env.TRAILING_STOP_ENABLED === 'true'
          ? `Enabled (-${process.env.TRAILING_STOP_PERCENT || '15'}%)`
          : 'Disabled'
      }\n`
    );

    const mode = process.env.DRY_RUN !== 'false' ? '📄 PAPER TRADING' : '💰 LIVE TRADING';
    console.log(`🚀 Bot is ready in ${mode} mode\n`);

  } catch (error) {
    console.log('❌ Module initialization failed:', error.message);
  }
}

process.on('unhandledRejection', (err) => {
  console.log('Unhandled rejection:', err.message);
});
