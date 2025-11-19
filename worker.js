// worker.js - Pump.fun Sniper Worker (Flintr + RiskManager + DRY_RUN)

import 'dotenv/config';
import { cleanAndValidateEnv } from './envCleaner.js';
import IORedis from 'ioredis';

// 🧹 LIMPIAR ENV PRIMERO
console.log('🚀 Starting Pump.fun Sniper Worker...\n');
cleanAndValidateEnv();

let redis = null;

async function startWorker() {
  // 1) Verificar Redis
  if (!process.env.REDIS_URL) {
    console.log('❌ REDIS_URL not set - worker cannot start');
    return;
  }

  try {
    redis = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      retryDelayOnFailover: 100,
    });

    await redis.ping();
    console.log('✅ Redis connected for worker\n');
  } catch (error) {
    console.log('❌ Redis connection failed:', error?.message ?? String(error));
    return;
  }

  try {
    // 2) Verificar variables mínimas para sniper
    const requiredVars = ['RPC_URL', 'PUMP_PROGRAM_ID', 'PRIVATE_KEY', 'FLINTR_API_KEY'];
    const missingVars = requiredVars.filter((v) => !process.env[v]);

    if (missingVars.length > 0) {
      console.log(`❌ Missing required env vars: ${missingVars.join(', ')}`);
      console.log('   Set them in Railway before starting the worker.\n');
      return;
    }

    // 3) Modo de operación
    const rawDryRun = (process.env.DRY_RUN || '').trim().toLowerCase();
    const dryRun =
      !rawDryRun || rawDryRun === '1' || rawDryRun === 'true' || rawDryRun === 'yes' || rawDryRun === 'paper';

    const autoTrading = (process.env.ENABLE_AUTO_TRADING || 'true').trim().toLowerCase() === 'true';

    const maxPositions = parseInt(process.env.MAX_POSITIONS || '2', 10);
    const positionSizeSol = parseFloat(process.env.POSITION_SIZE_SOL || '0.025');
    const priorityFee = process.env.PRIORITY_FEE || process.env.PRIORITY_FEE_MICROLAMPORTS || '300000';

    // NUEVOS NOMBRES PARA RIESGO / SALIDAS (modo sniper)
    const tpPercent = process.env.TAKE_PROFIT_PERCENT || process.env.COPY_PROFIT_TARGET || '200';
    const tsPercent = process.env.TRAILING_STOP_PERCENT || process.env.TRAILING_STOP || '15';
    const slPercent = process.env.STOP_LOSS_PERCENT || process.env.COPY_STOP_LOSS || '15';

    const riskTickIntervalMs = parseInt(process.env.RISK_TICK_INTERVAL || '5000', 10);

    console.log('📋 Configuration:');
    console.log(`   Mode: ${dryRun ? '📄 DRY RUN (Paper Trading)' : '💰 LIVE TRADING'}`);
    console.log(`   Auto Trading: ${autoTrading ? 'Enabled' : 'Disabled'}`);
    console.log(`   Max Positions: ${maxPositions}`);
    console.log(`   Position Size: ${positionSizeSol} SOL`);
    console.log(`   Priority Fee: ${priorityFee} (microlamports / SOL equiv)`);
    console.log(`   Take Profit: +${tpPercent}%`);
    console.log(`   Trailing Stop: -${tsPercent}%`);
    console.log(`   Stop Loss: -${slPercent}%`);
    console.log(`   Risk Tick Interval: ${riskTickIntervalMs} ms`);
    console.log(`   FLINTR_API_KEY: ${process.env.FLINTR_API_KEY ? '✅ Set' : '❌ Missing'}`);
    console.log('');

    if (!autoTrading) {
      console.log('⚠️ Auto trading is DISABLED');
      console.log('   Set ENABLE_AUTO_TRADING=true to enable automatic entries/exits\n');
    }

    if (dryRun) {
      console.log('📄 PAPER TRADING MODE - No real trades will be executed');
      console.log('   Set DRY_RUN=false for live trading\n');
    } else if (autoTrading) {
      console.log('⚠️ LIVE TRADING MODE - Real SOL will be used!');
      console.log('   Make sure your wallet has enough balance\n');
    }

    // 4) Iniciar motor SNIPER (Flintr + PriceService + RiskManager)
    console.log('🎯 Starting Flintr Pump.fun Sniper engine...');
    const { startSniperEngine } = await import('./sniperEngine.js');

    // El sniper engine recibirá redis y leerá TODAS las demás envs desde process.env
    // - Se encargará de:
    //   * Conectarse al WebSocket de Flintr
    //   * Aplicar filtros de liquidez/volumen
    //   * Consultar precio usando PriceService
    //   * Llamar a TradeExecutor en modo DRY_RUN o LIVE
    //   * Registrar posiciones y trades en Redis (open_positions, trades:YYYY-MM-DD, etc.)
    await startSniperEngine({ redis, dryRun, autoTrading });

    console.log('✅ Flintr Sniper engine started\n');

    // 5) Stats periódicos: posiciones abiertas + P&L diario (RiskManager)
    setInterval(async () => {
      try {
        const openPositions = await redis.scard('open_positions');
        const activeScalps = await redis.scard('active_scalps'); // usado por analytics/diagnostic
        const analyzedMints = await redis.scard('analyzed_mints'); // si lo usamos en sniperEngine

        console.log('\n📊 Worker Status:');
        console.log(`   Open Positions: ${openPositions}`);
        if (activeScalps !== null) {
          console.log(`   Active Scalp Mints: ${activeScalps}`);
        }
        if (analyzedMints !== null) {
          console.log(`   Analyzed Mints (today): ${analyzedMints}`);
        }

        // Obtener stats de hoy desde RiskManager (P&L REAL en SOL)
        try {
          const { RiskManager } = await import('./riskManager.js');
          const riskManager = new RiskManager({}, redis);
          const stats = await riskManager.getDailyStats();

          if (stats && stats.totalTrades > 0) {
            console.log(`\n💰 Today's Performance:`);
            console.log(`   Total Trades: ${stats.totalTrades}`);
            console.log(`   Win Rate: ${stats.winRate}`);
            console.log(`   Total P&L: ${stats.totalPnL} SOL`);
            if (stats.flintr) {
              console.log(
                `   Flintr: ${stats.flintr.trades} trades | Win Rate: ${stats.flintr.winRate} | P&L: ${stats.flintr.totalPnL} SOL`,
              );
            }
          }
        } catch (e) {
          // Stats no disponibles aún o RiskManager no inicializado correctamente
        }

        console.log('');
      } catch (error) {
        // Evitar que un error en stats tumbe el worker
      }
    }, 120000); // Cada 2 min

    console.log('✅ Pump.fun Sniper Worker is running');
    console.log('   Waiting for Flintr token mints...\n');
  } catch (error) {
    console.log('❌ Worker setup failed:', error?.message ?? String(error));
    process.exit(1);
  }
}

// Manejo de errores global
process.on('unhandledRejection', (err) => {
  console.log('Unhandled rejection:', err?.message ?? String(err));
});

process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down sniper worker...');

  try {
    if (redis) {
      await redis.quit();
    }
  } catch (e) {
    // ignore
  }

  console.log('✅ Worker stopped gracefully\n');
  process.exit(0);
});

// Iniciar el worker
startWorker();
