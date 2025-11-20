// worker.js - Pump.fun Bot Worker con SCALPING ENGINE

import 'dotenv/config';
import { cleanAndValidateEnv } from './envCleaner.js';
import IORedis from 'ioredis';
import { RiskManager } from './riskManager.js';
import { startSniperEngine } from './sniperEngine.js';
import { initScalpingEngine, getScalpingStats } from './scalpingEngine.js';
import { getPriceService } from './priceService.js';
import { TradeExecutor } from './tradeExecutor.js';

// 🧹 Limpiar/normalizar env primero
console.log('🚀 Starting Pump.fun Bot Worker with SCALPING ENGINE...\n');
const envCleaner = cleanAndValidateEnv();

function parseBoolEnv(value, defaultValue = false) {
  const v = (value || '').trim().toLowerCase();
  if (!v) return defaultValue;
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

async function startWorker() {
  // ═══════════════════════════════════════════════════════
  // 1. REDIS CONNECTION
  // ═══════════════════════════════════════════════════════
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
    console.log('❌ Redis connection failed:', error?.message || String(error));
    return;
  }

  // ═══════════════════════════════════════════════════════
  // 2. CONFIGURACIÓN
  // ═══════════════════════════════════════════════════════
  try {
    const requiredVars = ['PRIVATE_KEY', 'RPC_URL', 'PUMP_PROGRAM_ID'];
    const missingVars = requiredVars.filter((v) => !process.env[v]);

    if (missingVars.length > 0) {
      console.log(`❌ Missing required env vars: ${missingVars.join(', ')}`);
      return;
    }

    const dryRun = (process.env.DRY_RUN || '').trim().toLowerCase() !== 'false';
    const autoTrading = parseBoolEnv(process.env.ENABLE_AUTO_TRADING, false);
    const scalpingEnabled = parseBoolEnv(process.env.ENABLE_SCALPING, false);

    console.log('📋 Bot Configuration:');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`   Mode: ${dryRun ? '📄 DRY RUN (Paper Trading)' : '💰 LIVE TRADING'}`);
    console.log(`   Auto Trading: ${autoTrading ? 'Enabled' : 'Disabled'}`);
    console.log(`   Scalping: ${scalpingEnabled ? '✅ Enabled' : '❌ Disabled'}`);
    console.log('');
    
    // ─────────────────────────────────────────────────────
    // SNIPER CONFIG
    // ─────────────────────────────────────────────────────
    const positionSizeSol = parseFloat(process.env.POSITION_SIZE_SOL || '0.05');
    const maxPositions = parseInt(process.env.MAX_POSITIONS || '2', 10);
    
    console.log('🎯 Sniper (Flintr Mint Detection):');
    console.log(`   Position Size: ${positionSizeSol} SOL`);
    console.log(`   Max Positions: ${maxPositions}`);
    console.log(`   Min Liquidity: ${process.env.MIN_LIQUIDITY_SOL || '2'} SOL`);
    console.log('');

    // ─────────────────────────────────────────────────────
    // SCALPING CONFIG
    // ─────────────────────────────────────────────────────
    if (scalpingEnabled) {
      const scalpSize = parseFloat(process.env.SCALP_POSITION_SIZE_SOL || '0.02');
      const scalpMax = parseInt(process.env.SCALP_MAX_POSITIONS || '3', 10);
      const pumpThreshold = parseFloat(process.env.PUMP_THRESHOLD_PERCENT || '5');
      
      console.log('⚡ Scalping (Momentum Detection):');
      console.log(`   Position Size: ${scalpSize} SOL`);
      console.log(`   Max Positions: ${scalpMax}`);
      console.log(`   Pump Threshold: ${pumpThreshold}%`);
      console.log(`   Take Profit: ${process.env.SCALP_TAKE_PROFIT_PERCENT || '6'}%`);
      console.log(`   Stop Loss: ${process.env.SCALP_STOP_LOSS_PERCENT || '3'}%`);
      console.log(`   Max Hold: ${process.env.SCALP_MAX_HOLD_TIME_SEC || '300'}s`);
      console.log('');
    }

    console.log('═══════════════════════════════════════════════════════\n');

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

    // ═══════════════════════════════════════════════════════
    // 3. INICIALIZAR SERVICIOS
    // ═══════════════════════════════════════════════════════
    
    console.log('🔧 Initializing services...\n');
    
    // Price Service (compartido)
    const priceService = getPriceService();
    
    // Trade Executor (compartido)
    const tradeExecutor = new TradeExecutor(
      process.env.PRIVATE_KEY,
      process.env.RPC_URL,
      dryRun
    );

    // ═══════════════════════════════════════════════════════
    // 4. INICIAR SNIPER ENGINE (Flintr)
    // ═══════════════════════════════════════════════════════
    console.log('🎯 Starting Sniper Engine (Flintr)...');
    await startSniperEngine(redis);
    console.log('✅ Sniper Engine started\n');

    // ═══════════════════════════════════════════════════════
    // 5. INICIAR SCALPING ENGINE (Momentum)
    // ═══════════════════════════════════════════════════════
    if (scalpingEnabled) {
      console.log('⚡ Starting Scalping Engine (Momentum Detection)...');
      initScalpingEngine(redis, priceService, tradeExecutor);
      console.log('✅ Scalping Engine started\n');
    } else {
      console.log('⚠️ Scalping Engine DISABLED (set ENABLE_SCALPING=true to enable)\n');
    }

    // ═══════════════════════════════════════════════════════
    // 6. STATS PERIÓDICOS
    // ═══════════════════════════════════════════════════════
    const statsIntervalMs = parseInt(process.env.RISK_TICK_INTERVAL || '120000', 10);

    setInterval(async () => {
      try {
        console.log('\n📊 ═══════════════════════════════════════════════════════');
        console.log('   WORKER STATUS');
        console.log('   ═══════════════════════════════════════════════════════');
        
        const now = new Date().toLocaleString();
        console.log(`   Time: ${now}\n`);

        // ─────────────────────────────────────────────────────
        // POSICIONES TOTALES
        // ─────────────────────────────────────────────────────
        const openPositions = await redis.scard('open_positions');
        const scalpPositions = await redis.scard('scalp:active_positions');
        
        console.log('   🎯 POSICIONES:');
        console.log(`      Sniper (Flintr): ${openPositions - scalpPositions}`);
        
        if (scalpingEnabled) {
          console.log(`      Scalping: ${scalpPositions}`);
          console.log(`      Total: ${openPositions}`);
        } else {
          console.log(`      Total: ${openPositions}`);
        }
        console.log('');

        // ─────────────────────────────────────────────────────
        // STATS DIARIOS (Sniper)
        // ─────────────────────────────────────────────────────
        try {
          const riskManager = new RiskManager({}, redis);
          const stats = await riskManager.getDailyStats();

          if (stats && stats.totalTrades > 0) {
            console.log(`   💰 SNIPER TODAY (Realized):`);
            console.log(`      Trades: ${stats.totalTrades}`);
            console.log(`      W/L: ${stats.wins}/${stats.losses}`);
            console.log(`      Win Rate: ${stats.winRate}`);
            console.log(`      P&L: ${stats.totalPnL} SOL`);
            console.log(`      Best: ${stats.biggestWin} SOL`);
            console.log(`      Worst: ${stats.biggestLoss} SOL`);
            console.log('');
          }
        } catch {}

        // ─────────────────────────────────────────────────────
        // STATS SCALPING
        // ─────────────────────────────────────────────────────
        if (scalpingEnabled) {
          try {
            const scalpStats = getScalpingStats();
            
            console.log(`   ⚡ SCALPING TODAY:`);
            console.log(`      Scans: ${scalpStats.scansPerformed}`);
            console.log(`      Pumps Detected: ${scalpStats.pumpsDetected}`);
            console.log(`      Entries: ${scalpStats.entriesExecuted}`);
            console.log(`      Exits: ${scalpStats.exitsExecuted}`);
            console.log(`      W/L: ${scalpStats.wins}/${scalpStats.losses}`);
            
            const scalpWinRate = scalpStats.wins + scalpStats.losses > 0
              ? ((scalpStats.wins / (scalpStats.wins + scalpStats.losses)) * 100).toFixed(2)
              : '0.00';
            
            console.log(`      Win Rate: ${scalpWinRate}%`);
            console.log(`      P&L: ${scalpStats.totalPnL.toFixed(6)} SOL`);
            console.log(`      Active: ${scalpStats.activePositions}/${scalpStats.maxPositions}`);
            console.log('');
          } catch {}
        }

        console.log('   ═══════════════════════════════════════════════════════\n');
      } catch (error) {
        // Silent
      }
    }, statsIntervalMs);

    // ═══════════════════════════════════════════════════════
    // 7. READY
    // ═══════════════════════════════════════════════════════
    console.log('✅ Pump.fun Bot Worker is READY');
    console.log('═══════════════════════════════════════════════════════');
    
    if (scalpingEnabled) {
      console.log('🎯 Sniper: Waiting for Flintr mint signals...');
      console.log('⚡ Scalping: Monitoring price momentum...');
    } else {
      console.log('🎯 Sniper: Waiting for Flintr mint signals...');
    }
    
    console.log('═══════════════════════════════════════════════════════\n');

  } catch (error) {
    console.log('❌ Worker setup failed:', error?.message || String(error));
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════
// ERROR HANDLERS
// ═══════════════════════════════════════════════════════

process.on('unhandledRejection', (err) => {
  console.log('Unhandled rejection:', err?.message || String(err));
});

process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down worker...');
  try {
    // Cleanup si es necesario
  } catch {}
  console.log('✅ Worker stopped gracefully\n');
  process.exit(0);
});

// ═══════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════

startWorker();
