// scalpingEngine.js - Motor de Scalping para Pump.fun
// ✅ Detección de momentum en tokens en ascenso
// ✅ Entrada rápida en tokens con impulso alcista
// ✅ Salidas automáticas con take-profit pequeños
// ✅ Monitoreo de cambios de precio en tiempo real

import IORedis from 'ioredis';
import { getPriceService } from './priceService.js';
import { TradeExecutor } from './tradeExecutor.js';
import { sendTelegramAlert } from './telegram.js';

// ═══════════════════════════════════════════════════════
// CONFIGURACIÓN SCALPING
// ═══════════════════════════════════════════════════════

// Umbrales de entrada
const PUMP_THRESHOLD_PERCENT = parseFloat(process.env.PUMP_THRESHOLD_PERCENT || '5'); // 5% subida rápida
const MIN_PUMP_TIME_WINDOW_SEC = parseInt(process.env.MIN_PUMP_TIME_WINDOW_SEC || '10', 10); // Ventana 10s
const MAX_PUMP_TIME_WINDOW_SEC = parseInt(process.env.MAX_PUMP_TIME_WINDOW_SEC || '60', 10); // Max 60s

// Límites de riesgo
const SCALP_POSITION_SIZE_SOL = parseFloat(process.env.SCALP_POSITION_SIZE_SOL || '0.02');
const SCALP_STOP_LOSS_PERCENT = parseFloat(process.env.SCALP_STOP_LOSS_PERCENT || '3');
const SCALP_TAKE_PROFIT_PERCENT = parseFloat(process.env.SCALP_TAKE_PROFIT_PERCENT || '6');
const SCALP_MAX_HOLD_TIME_SEC = parseInt(process.env.SCALP_MAX_HOLD_TIME_SEC || '300', 10); // 5 min max

// Control de operaciones
const SCALP_MAX_POSITIONS = parseInt(process.env.SCALP_MAX_POSITIONS || '3', 10);
const SCALP_COOLDOWN_SEC = parseInt(process.env.SCALP_COOLDOWN_PER_TOKEN_SEC || '600', 10);
const PRICE_SCAN_INTERVAL_MS = parseInt(process.env.PRICE_SCAN_INTERVAL_MS || '3000', 10);

// Feature flags
const ENABLE_SCALPING = (process.env.ENABLE_SCALPING || '').trim().toLowerCase() === 'true';
const DRY_RUN = (process.env.DRY_RUN || '').trim().toLowerCase() !== 'false';

// Telegram
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

// ═══════════════════════════════════════════════════════
// ESTADO GLOBAL
// ═══════════════════════════════════════════════════════

let redis = null;
let priceService = null;
let tradeExecutor = null;

// Tracking de precios históricos (en memoria)
const priceHistory = new Map(); // mint -> [{price, timestamp}]
const scalpPositions = new Map(); // mint -> {entryPrice, entryTime, ...}
const lastScalpEntry = new Map(); // mint -> timestamp (cooldown)

// Stats
let scalpStats = {
  scansPerformed: 0,
  pumpsDetected: 0,
  entriesExecuted: 0,
  exitsExecuted: 0,
  wins: 0,
  losses: 0,
  totalPnL: 0
};

// ═══════════════════════════════════════════════════════
// INICIALIZACIÓN
// ═══════════════════════════════════════════════════════

export function initScalpingEngine(redisInstance, priceServiceInstance, tradeExecutorInstance) {
  redis = redisInstance;
  priceService = priceServiceInstance;
  tradeExecutor = tradeExecutorInstance;

  if (!ENABLE_SCALPING) {
    console.log('📊 Scalping Engine: DISABLED (set ENABLE_SCALPING=true)');
    return;
  }

  console.log('\n🎯 Scalping Engine INICIALIZADO');
  console.log('═══════════════════════════════════════════════');
  console.log(`   Estado: ${ENABLE_SCALPING ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`   Modo: ${DRY_RUN ? '📝 PAPER' : '💰 LIVE'}`);
  console.log('');
  console.log('📈 Estrategia:');
  console.log(`   Pump Threshold: ≥${PUMP_THRESHOLD_PERCENT}% en ${MIN_PUMP_TIME_WINDOW_SEC}-${MAX_PUMP_TIME_WINDOW_SEC}s`);
  console.log(`   Position Size: ${SCALP_POSITION_SIZE_SOL} SOL`);
  console.log(`   Stop Loss: -${SCALP_STOP_LOSS_PERCENT}%`);
  console.log(`   Take Profit: +${SCALP_TAKE_PROFIT_PERCENT}%`);
  console.log(`   Max Hold: ${SCALP_MAX_HOLD_TIME_SEC}s`);
  console.log(`   Max Positions: ${SCALP_MAX_POSITIONS}`);
  console.log(`   Cooldown: ${SCALP_COOLDOWN_SEC}s por token`);
  console.log(`   Scan Interval: ${PRICE_SCAN_INTERVAL_MS}ms`);
  console.log('═══════════════════════════════════════════════\n');

  startPriceScanner();
  startScalpRiskMonitor();
  startStatsLogger();
}

// ═══════════════════════════════════════════════════════
// SCANNER DE PRECIOS - Detecta tokens con momentum
// ═══════════════════════════════════════════════════════

function startPriceScanner() {
  console.log('🔍 Price Scanner iniciado...\n');

  setInterval(async () => {
    try {
      scalpStats.scansPerformed++;

      // Obtener tokens activos para escanear
      const tokensToScan = await getActiveTokensToScan();

      if (tokensToScan.length === 0) return;

      // Escanear cada token
      for (const mint of tokensToScan) {
        await scanTokenForPump(mint);
      }

      // Limpiar historial viejo
      cleanOldPriceHistory();

    } catch (error) {
      console.error('⚠️ Error en price scanner:', error?.message);
    }
  }, PRICE_SCAN_INTERVAL_MS);
}

/**
 * Obtiene lista de tokens activos para escanear
 * Prioriza: tokens de Flintr recientes + posiciones abiertas de otras estrategias
 */
async function getActiveTokensToScan() {
  const tokens = new Set();

  try {
    // 1. Tokens recientes de Flintr (últimos 30 min)
    const flintrTokens = await redis.zrangebyscore(
      'flintr:recent_tokens',
      Date.now() - (30 * 60 * 1000),
      Date.now()
    );
    flintrTokens.forEach(mint => tokens.add(mint));

    // 2. Posiciones abiertas (otras estrategias) que podríamos escalpear
    const openMints = await redis.smembers('open_positions');
    for (const mint of openMints) {
      const pos = await redis.hgetall(`position:${mint}`);
      
      // Solo tokens que NO sean graduados y NO sean de scalping ya
      if (pos && pos.status === 'open' && !pos.graduated && pos.entry_strategy !== 'scalping') {
        tokens.add(mint);
      }
    }

    // 3. Tokens del "watchlist" si existe
    const watchlist = await redis.smembers('scalp:watchlist');
    watchlist.forEach(mint => tokens.add(mint));

  } catch (error) {
    console.error('⚠️ Error getting tokens to scan:', error?.message);
  }

  return Array.from(tokens).slice(0, 50); // Limitar a 50 tokens por scan
}

/**
 * Escanea un token buscando pump (subida rápida de precio)
 */
async function scanTokenForPump(mint) {
  try {
    // Obtener precio actual
    const priceData = await priceService.getPrice(mint);
    
    if (!priceData || !priceData.price || priceData.price <= 0) {
      return;
    }

    const currentPrice = priceData.price;
    const now = Date.now();

    // Guardar en historial
    if (!priceHistory.has(mint)) {
      priceHistory.set(mint, []);
    }

    const history = priceHistory.get(mint);
    history.push({ price: currentPrice, timestamp: now });

    // Mantener solo últimos 60 segundos
    while (history.length > 0 && now - history[0].timestamp > MAX_PUMP_TIME_WINDOW_SEC * 1000) {
      history.shift();
    }

    // Necesitamos al menos 2 puntos para comparar
    if (history.length < 2) return;

    // Calcular cambio porcentual en ventana de tiempo
    const oldestPoint = history[0];
    const timeWindowSec = (now - oldestPoint.timestamp) / 1000;

    // Solo evaluar si la ventana está en el rango correcto
    if (timeWindowSec < MIN_PUMP_TIME_WINDOW_SEC || timeWindowSec > MAX_PUMP_TIME_WINDOW_SEC) {
      return;
    }

    const priceChange = ((currentPrice - oldestPoint.price) / oldestPoint.price) * 100;

    // 🚀 PUMP DETECTADO!
    if (priceChange >= PUMP_THRESHOLD_PERCENT) {
      scalpStats.pumpsDetected++;
      
      console.log(`\n🚀 PUMP DETECTED!`);
      console.log(`   Mint: ${mint.slice(0, 12)}...`);
      console.log(`   Change: ${priceChange.toFixed(2)}% en ${timeWindowSec.toFixed(1)}s`);
      console.log(`   Price: ${oldestPoint.price.toFixed(10)} → ${currentPrice.toFixed(10)}`);

      await handlePumpSignal(mint, currentPrice, priceChange, priceData);
    }

  } catch (error) {
    // Silent para no spamear
  }
}

/**
 * Maneja señal de pump - decide si entrar o no
 */
async function handlePumpSignal(mint, currentPrice, pumpPercent, priceData) {
  try {
    // ══════════════════════════════════════════════════════
    // FILTROS DE ENTRADA
    // ══════════════════════════════════════════════════════

    // 1. Verificar que no estemos ya en esta posición
    if (scalpPositions.has(mint)) {
      console.log(`   ⏭️  Ya tenemos posición de scalp en este token`);
      return;
    }

    // 2. Cooldown por token
    const lastEntry = lastScalpEntry.get(mint);
    if (lastEntry && Date.now() - lastEntry < SCALP_COOLDOWN_SEC * 1000) {
      const remainingSec = Math.ceil((SCALP_COOLDOWN_SEC * 1000 - (Date.now() - lastEntry)) / 1000);
      console.log(`   ⏳ Cooldown activo (${remainingSec}s restantes)`);
      return;
    }

    // 3. Límite de posiciones simultáneas
    if (scalpPositions.size >= SCALP_MAX_POSITIONS) {
      console.log(`   🚫 Max posiciones de scalping alcanzadas (${SCALP_MAX_POSITIONS})`);
      return;
    }

    // 4. Token graduado? Skip
    if (priceData.graduated) {
      console.log(`   🎓 Token graduado - Skip scalping`);
      return;
    }

    // 5. Liquidez mínima
    const minLiquidity = parseFloat(process.env.SCALP_MIN_LIQUIDITY_SOL || '1');
    if (priceData.virtualSolReserves < minLiquidity) {
      console.log(`   💧 Liquidez baja: ${priceData.virtualSolReserves.toFixed(2)} SOL (min: ${minLiquidity})`);
      return;
    }

    // ══════════════════════════════════════════════════════
    // EJECUTAR ENTRADA
    // ══════════════════════════════════════════════════════

    console.log(`   ✅ Condiciones cumplidas - ENTRANDO`);

    const buyResult = await tradeExecutor.buyToken(mint, SCALP_POSITION_SIZE_SOL);

    if (!buyResult || !buyResult.success) {
      console.log(`   ❌ Compra fallida: ${buyResult?.error}`);
      return;
    }

    const tokensReceived = parseFloat(buyResult.tokensReceived || '0');
    const solSpent = parseFloat(buyResult.solSpent || SCALP_POSITION_SIZE_SOL);
    const entryPrice = buyResult.entryPrice || currentPrice;

    // Guardar posición de scalping
    const position = {
      mint,
      entryPrice,
      entryTime: Date.now(),
      solSpent,
      tokensAmount: tokensReceived,
      stopLoss: entryPrice * (1 - SCALP_STOP_LOSS_PERCENT / 100),
      takeProfit: entryPrice * (1 + SCALP_TAKE_PROFIT_PERCENT / 100),
      maxPrice: entryPrice,
      pumpPercent,
      strategy: 'scalping',
      signature: buyResult.signature
    };

    scalpPositions.set(mint, position);
    lastScalpEntry.set(mint, Date.now());
    scalpStats.entriesExecuted++;

    // Guardar en Redis también para tracking
    await redis.hmset(`scalp:position:${mint}`, {
      ...position,
      tokensAmount: position.tokensAmount.toString(),
      entryTime: position.entryTime.toString()
    });
    await redis.sadd('scalp:active_positions', mint);

    console.log(`   💰 Posición de scalping abierta:`);
    console.log(`      Entry: ${entryPrice.toFixed(10)}`);
    console.log(`      Stop Loss: ${position.stopLoss.toFixed(10)} (-${SCALP_STOP_LOSS_PERCENT}%)`);
    console.log(`      Take Profit: ${position.takeProfit.toFixed(10)} (+${SCALP_TAKE_PROFIT_PERCENT}%)`);
    console.log(`      Size: ${solSpent.toFixed(4)} SOL`);

    // Alerta Telegram
    if (TELEGRAM_CHAT_ID) {
      await sendTelegramAlert(
        TELEGRAM_CHAT_ID,
        `🎯 [SCALP ENTRY ${DRY_RUN ? 'PAPER' : 'LIVE'}]\n\n` +
        `Mint: ${mint.slice(0, 12)}...\n` +
        `Pump: ${pumpPercent.toFixed(2)}%\n` +
        `Entry: ${entryPrice.toFixed(10)}\n` +
        `Size: ${solSpent.toFixed(4)} SOL\n` +
        `SL: -${SCALP_STOP_LOSS_PERCENT}% | TP: +${SCALP_TAKE_PROFIT_PERCENT}%`
      );
    }

  } catch (error) {
    console.error('❌ Error en handlePumpSignal:', error?.message);
  }
}

// ═══════════════════════════════════════════════════════
// MONITOR DE RIESGO - Salidas automáticas
// ═══════════════════════════════════════════════════════

function startScalpRiskMonitor() {
  console.log('🛡️ Scalp Risk Monitor iniciado...\n');

  setInterval(async () => {
    try {
      if (scalpPositions.size === 0) return;

      for (const [mint, position] of scalpPositions.entries()) {
        await checkScalpExitConditions(mint, position);
      }

    } catch (error) {
      console.error('⚠️ Error en scalp risk monitor:', error?.message);
    }
  }, 2000); // Check cada 2s (más frecuente que el scanner)
}

/**
 * Verifica condiciones de salida para posición de scalping
 */
async function checkScalpExitConditions(mint, position) {
  try {
    // Obtener precio actual
    const priceData = await priceService.getPriceWithFallback(mint);
    
    if (!priceData || !priceData.price) return;

    const currentPrice = priceData.price;
    const entryPrice = position.entryPrice;
    const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    const holdTimeSec = (Date.now() - position.entryTime) / 1000;

    // Actualizar max price
    if (currentPrice > position.maxPrice) {
      position.maxPrice = currentPrice;
      await redis.hset(`scalp:position:${mint}`, 'maxPrice', currentPrice.toString());
    }

    let shouldExit = false;
    let exitReason = '';

    // ══════════════════════════════════════════════════════
    // CONDICIONES DE SALIDA
    // ══════════════════════════════════════════════════════

    // 1. STOP LOSS
    if (currentPrice <= position.stopLoss) {
      shouldExit = true;
      exitReason = `STOP LOSS (${pnlPercent.toFixed(2)}%)`;
    }
    
    // 2. TAKE PROFIT
    else if (currentPrice >= position.takeProfit) {
      shouldExit = true;
      exitReason = `TAKE PROFIT (${pnlPercent.toFixed(2)}%)`;
    }
    
    // 3. MAX HOLD TIME
    else if (holdTimeSec >= SCALP_MAX_HOLD_TIME_SEC) {
      shouldExit = true;
      exitReason = `MAX HOLD TIME (${Math.floor(holdTimeSec)}s @ ${pnlPercent.toFixed(2)}%)`;
    }

    // 4. GRADUACIÓN
    else if (priceData.graduated) {
      shouldExit = true;
      exitReason = `GRADUATION (${pnlPercent.toFixed(2)}%)`;
    }

    // ══════════════════════════════════════════════════════
    // EJECUTAR SALIDA
    // ══════════════════════════════════════════════════════

    if (shouldExit) {
      await executeScalpExit(mint, position, currentPrice, exitReason, pnlPercent);
    }

  } catch (error) {
    console.error(`⚠️ Error checking exit for ${mint.slice(0, 8)}:`, error?.message);
  }
}

/**
 * Ejecuta salida de posición de scalping
 */
async function executeScalpExit(mint, position, exitPrice, reason, pnlPercent) {
  try {
    console.log(`\n⚡ SCALP EXIT: ${reason}`);
    console.log(`   Mint: ${mint.slice(0, 12)}...`);
    console.log(`   Entry: ${position.entryPrice.toFixed(10)}`);
    console.log(`   Exit: ${exitPrice.toFixed(10)}`);
    console.log(`   PnL: ${pnlPercent.toFixed(2)}%`);

    // Ejecutar venta
    const sellResult = await tradeExecutor.sellToken(mint, position.tokensAmount);

    if (!sellResult || !sellResult.success) {
      console.log(`   ❌ Venta fallida: ${sellResult?.error}`);
      return;
    }

    const solReceived = parseFloat(sellResult.solReceived || '0');
    const pnlSOL = solReceived - position.solSpent;

    // Stats
    scalpStats.exitsExecuted++;
    scalpStats.totalPnL += pnlSOL;
    
    if (pnlSOL > 0) {
      scalpStats.wins++;
    } else if (pnlSOL < 0) {
      scalpStats.losses++;
    }

    // Remover posición
    scalpPositions.delete(mint);
    await redis.del(`scalp:position:${mint}`);
    await redis.srem('scalp:active_positions', mint);

    // Guardar en historial
    await redis.rpush('scalp:history', JSON.stringify({
      mint,
      entryPrice: position.entryPrice,
      exitPrice,
      pnlSOL,
      pnlPercent,
      reason,
      holdTimeSec: (Date.now() - position.entryTime) / 1000,
      timestamp: Date.now()
    }));

    const emoji = pnlSOL > 0 ? '💰' : '📉';
    console.log(`   ${emoji} PnL: ${pnlSOL.toFixed(6)} SOL`);

    // Alerta Telegram
    if (TELEGRAM_CHAT_ID) {
      await sendTelegramAlert(
        TELEGRAM_CHAT_ID,
        `${emoji} [SCALP EXIT ${DRY_RUN ? 'PAPER' : 'LIVE'}]\n\n` +
        `Reason: ${reason}\n` +
        `Mint: ${mint.slice(0, 12)}...\n\n` +
        `Entry: ${position.entryPrice.toFixed(10)}\n` +
        `Exit: ${exitPrice.toFixed(10)}\n` +
        `PnL: ${pnlPercent.toFixed(2)}% | ${pnlSOL.toFixed(6)} SOL\n` +
        `Hold: ${Math.floor((Date.now() - position.entryTime) / 1000)}s`
      );
    }

  } catch (error) {
    console.error('❌ Error en executeScalpExit:', error?.message);
  }
}

// ═══════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════

function cleanOldPriceHistory() {
  const now = Date.now();
  const maxAge = MAX_PUMP_TIME_WINDOW_SEC * 1000;

  for (const [mint, history] of priceHistory.entries()) {
    // Eliminar puntos viejos
    while (history.length > 0 && now - history[0].timestamp > maxAge) {
      history.shift();
    }

    // Si no quedan puntos, eliminar entrada
    if (history.length === 0) {
      priceHistory.delete(mint);
    }
  }
}

function startStatsLogger() {
  setInterval(() => {
    if (scalpStats.scansPerformed === 0) return;

    const winRate = scalpStats.wins + scalpStats.losses > 0
      ? ((scalpStats.wins / (scalpStats.wins + scalpStats.losses)) * 100).toFixed(2)
      : '0.00';

    console.log(`\n📊 Scalping Stats:`);
    console.log(`   Scans: ${scalpStats.scansPerformed}`);
    console.log(`   Pumps Detected: ${scalpStats.pumpsDetected}`);
    console.log(`   Entries: ${scalpStats.entriesExecuted}`);
    console.log(`   Exits: ${scalpStats.exitsExecuted}`);
    console.log(`   Active Positions: ${scalpPositions.size}/${SCALP_MAX_POSITIONS}`);
    console.log(`   Win Rate: ${winRate}% (${scalpStats.wins}W / ${scalpStats.losses}L)`);
    console.log(`   Total PnL: ${scalpStats.totalPnL.toFixed(6)} SOL\n`);
  }, 60000); // Cada minuto
}

// ═══════════════════════════════════════════════════════
// API PÚBLICA
// ═══════════════════════════════════════════════════════

export function getScalpingStats() {
  return {
    ...scalpStats,
    activePositions: scalpPositions.size,
    maxPositions: SCALP_MAX_POSITIONS,
    positions: Array.from(scalpPositions.entries()).map(([mint, pos]) => ({
      mint: mint.slice(0, 12) + '...',
      entryPrice: pos.entryPrice,
      holdTimeSec: Math.floor((Date.now() - pos.entryTime) / 1000),
      pumpPercent: pos.pumpPercent
    }))
  };
}

export async function addTokenToWatchlist(mint) {
  if (!redis) return false;
  
  try {
    await redis.sadd('scalp:watchlist', mint);
    console.log(`✅ Token ${mint.slice(0, 8)} agregado a watchlist de scalping`);
    return true;
  } catch (error) {
    return false;
  }
}

export async function removeTokenFromWatchlist(mint) {
  if (!redis) return false;
  
  try {
    await redis.srem('scalp:watchlist', mint);
    console.log(`✅ Token ${mint.slice(0, 8)} removido de watchlist`);
    return true;
  } catch (error) {
    return false;
  }
}

console.log('🎯 Scalping Engine module loaded');
