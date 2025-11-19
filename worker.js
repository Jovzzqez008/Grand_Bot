// worker.js - Pump.fun Sniper Worker with ENV CLEANER

import 'dotenv/config';
import { cleanAndValidateEnv } from './envCleaner.js';
import IORedis from 'ioredis';
import { RiskManager } from './riskManager.js';
import { startSniperEngine } from './sniperEngine.js';

// 🧹 Limpiar/normalizar env primero
console.log('🚀 Starting Pump.fun Sniper Worker...\n');
const envCleaner = cleanAndValidateEnv();

async function startWorker() {
  // Verificar Redis
  if (!process.env.REDIS_URL) {
    console.log('❌ REDIS_URL not set - worker cannot start');
    return;
  }

  let redis;
  try {
    redis = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      retryDelayOnFailover: 100,
    });

    await redis.ping();
    console.log('✅ Redis connected for worker\n');
  } catch (error) {
    console.log('❌ Redis connection failed:', error.message);
    return;
  }

  try {
    // Variables mínimas para operar sniper
    const requiredVars = ['PRIVATE_KEY'];
    const missingVars = requiredVars.filter((v) => !process.env[v]);

    if (missingVars.length > 0) {
      console.log(`❌ Missing required env vars: ${missingVars.join(', ')}`);
      return;
    }

    const dryRun = process.env.DRY_RUN !== 'false';
    const autoTrading = process.env.ENABLE_AUTO_TRADING === 'true';

    const positionSizeSol = parseFloat(process.env.POSITION_SIZE_SOL || '0.05');
    const maxPositions = parseInt(process.env.MAX_POSITIONS || '3');
    const minLiquiditySol = parseFloat(process.env.MIN_LIQUIDITY_SOL || '3');
    const minInitialVolumeSol = parseFloat(process.env.MIN_INITIAL_VOLUME_SOL || '0');
    const onlyKingOfHill = process.env.ONLY_KING_OF_HILL === 'true';

    console.log('📋 Sniper Configuration:');
    console.log(`   Mode: ${dryRun ? '📄 DRY RUN (Paper Trading)' : '💰 LIVE TRADING'}`);
    console.log(`   Auto Trading: ${autoTrading ? 'Enabled' : 'Disabled'}`);
    console.log(`   Position Size: ${positionSizeSol} SOL`);
    console.log(`   Max Positions: ${maxPositions}`);
    console.log(`   Min Liquidity: ${minLiquiditySol} SOL`);
    console.log(`   Min Initial Volume: ${minInitialVolumeSol} SOL`);
    console.log(`   Only King Of Hill: ${onlyKingOfHill ? 'Yes' : 'No'}`);
    console.log(`   Priority Fee: ${process.env.PRIORITY_FEE || process.env.PRIORITY_FEE_MICROLAMPORTS || 'default'}`);
    console.log('');

    if (!autoTrading) {
      console.log('⚠️ Auto trading is DISABLED');
      console.log('   Set ENABLE_AUTO_TRADING=true to enable\n');
    }

    if (dryRun) {
      console.log('📄 PAPER TRADING MODE - No real trades will be executed');
      console.log('   Set DRY_RUN=false for live trading\n');
    } else if (autoTrading) {
      console.log('⚠️ LIVE TRADING MODE - Real SOL will be used!');
      console.log('   Make sure your wallet has enough balance\n');
    }

    // === Iniciar motor SNIPER (Flintr + Pump.fun) ===
    console.log('🎯 Starting Pump.fun Sniper Engine...');
    await startSniperEngine(redis);
    console.log('✅ Sniper Engine started\n');

    // Stats periódicos (usa RiskManager + Redis, igual que antes)
    const statsIntervalMs = parseInt(process.env.RISK_TICK_INTERVAL || '120000');

    setInterval(async () => {
      try {
        const openPositions = await redis.scard('open_positions');
        const pendingSignals = await redis.llen('sniper_signals');

        console.log('\n📊 Worker Status:');
        console.log(`   Open Positions: ${openPositions}`);
        console.log(`   Pending Sniper Signals: ${pendingSignals}`);

        try {
          const riskManager = new RiskManager({}, redis);
          const stats = await riskManager.getDailyStats();

          if (stats && stats.totalTrades > 0) {
            console.log(`\n💰 Today's Performance:`);
            console.log(`   Total Trades: ${stats.totalTrades}`);
            console.log(`   Wins: ${stats.wins} | Losses: ${stats.losses}`);
            console.log(`   Win Rate: ${stats.winRate}`);
            console.log(`   Total P&L: ${stats.totalPnL} SOL`);
            console.log(`   Biggest Win: ${stats.biggestWin} SOL`);
            console.log(`   Biggest Loss: ${stats.biggestLoss} SOL`);
          }
        } catch (e) {
          // Stats no disponibles aún
        }

        console.log('');
      } catch (error) {
        // silencioso para no spamear
      }
    }, statsIntervalMs);

    console.log('✅ Pump.fun Sniper Worker is running');
    console.log('   Waiting for Flintr signals to snipe Pump.fun tokens...\n');
  } catch (error) {
    console.log('❌ Worker setup failed:', error.message);
    process.exit(1);
  }
}

// Manejo de errores global
process.on('unhandledRejection', (err) => {
  console.log('Unhandled rejection:', err.message);
});

process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down worker...');
  try {
    // Aquí en el futuro podemos cerrar WebSocket de Flintr
  } catch (e) {}
  console.log('✅ Worker stopped gracefully\n');
  process.exit(0);
});

// Iniciar el worker
startWorker();
