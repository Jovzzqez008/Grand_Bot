// sniperEngine.js - Pump.fun Sniper MEJORADO
// ✅ Sistema de scoring inteligente
// ✅ Filtros anti-rug avanzados
// ✅ Position sizing dinámico
// ✅ Múltiples estrategias de salida
// ✅ Rate limiting y circuit breaker

import WebSocket from 'ws';
import { getPriceService } from './priceService.js';
import { RiskManager, PositionManager } from './riskManager.js';
import { TradeExecutor } from './tradeExecutor.js';
import { sendTelegramAlert } from './telegram.js';

// ═══════════════════════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════════════════════
const FLINTR_API_KEY = process.env.FLINTR_API_KEY;
const DRY_RUN = (process.env.DRY_RUN || '').trim().toLowerCase() !== 'false';
const AUTO_TRADING = (process.env.ENABLE_AUTO_TRADING || '').trim().toLowerCase() === 'true';

// Tamaños y límites
const POSITION_SIZE_SOL = parseFloat(process.env.POSITION_SIZE_SOL || '0.05');
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '2', 10);
const MIN_LIQUIDITY_SOL = parseFloat(process.env.MIN_LIQUIDITY_SOL || '2');
const MIN_INITIAL_VOLUME_SOL = parseFloat(process.env.MIN_INITIAL_VOLUME_SOL || '0');
const MIN_TIME_BETWEEN_SAME_TOKEN = parseInt(process.env.MIN_TIME_BETWEEN_SAME_TOKEN || '900', 10);
const RESERVED_FLINTR_POSITIONS = parseInt(process.env.RESERVED_FLINTR_POSITIONS || '0', 10);
const ONLY_KING_OF_HILL = (process.env.ONLY_KING_OF_HILL || '').trim().toLowerCase() === 'true';

// Telegram
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_ALERT_ON_ENTRY = (process.env.TELEGRAM_ALERT_ON_ENTRY || '').trim().toLowerCase() === 'true';
const VERBOSE_LOGGING = (process.env.VERBOSE_LOGGING || '').trim().toLowerCase() === 'true';

// Intervalos
const RISK_TICK_INTERVAL = parseInt(process.env.RISK_TICK_INTERVAL || '5000', 10);
const STAGNATION_TIME_SEC = parseInt(process.env.STAGNATION_TIME_SEC || '300', 10);
const STAGNATION_PNL_THRESHOLD = parseFloat(process.env.STAGNATION_PNL_THRESHOLD || '5');

// ═══════════════════════════════════════════════════════
// NUEVAS CONFIGURACIONES - MEJORAS
// ═══════════════════════════════════════════════════════

// Sistema de scoring
const SCORING_CONFIG = {
  minScore: parseFloat(process.env.MIN_ENTRY_SCORE || '65'), // Mínimo 65/100 para entrar
  weights: {
    liquidity: 0.25,
    volume: 0.20,
    bundleSize: 0.15,
    holderConcentration: 0.15,
    priceStability: 0.15,
    momentum: 0.10
  }
};

// ═══════════════════════════════════════════════════════
// RISK LOOP MEJORADO
// ═══════════════════════════════════════════════════════
function startRiskLoop() {
  if (!RISK_TICK_INTERVAL || RISK_TICK_INTERVAL <= 0) return;

  console.log(`🛡️ Monitor de Riesgo iniciado (${RISK_TICK_INTERVAL}ms)`);
  console.log(`   Stop Loss: -${process.env.STOP_LOSS_PERCENT || '13'}%`);
  console.log(`   Take Profit: +${process.env.TAKE_PROFIT_PERCENT || '30'}%`);
  console.log(`   Trailing Stop: -${process.env.TRAILING_STOP_PERCENT || '15'}%`);
  console.log(`   Stagnation: ${STAGNATION_TIME_SEC}s @ <${STAGNATION_PNL_THRESHOLD}%`);
  console.log('');

  setInterval(async () => {
    try {
      if (!positionManager) return;

      // Check circuit breaker
      const cbStatus = await checkCircuitBreaker();
      if (cbStatus.active && VERBOSE_LOGGING) {
        console.log(`🚨 Circuit Breaker activo - Skip risk check`);
      }

      const positions = await positionManager.getOpenPositions();
      
      if (positions.length === 0) {
        await redis.set('sniper:last_risk_tick', Date.now().toString());
        return;
      }

      const stopLossPct = parseFloat(process.env.STOP_LOSS_PERCENT || '13');
      const takeProfitPct = parseFloat(process.env.TAKE_PROFIT_PERCENT || '30');
      const trailingStopPct = parseFloat(process.env.TRAILING_STOP_PERCENT || '15');

      // Flags para controlar salidas
      const stopLossEnabled = (process.env.STOP_LOSS_ENABLED || 'true').trim().toLowerCase() === 'true';
      const takeProfitEnabled = (process.env.TAKE_PROFIT_ENABLED || 'true').trim().toLowerCase() === 'true';
      const trailingStopEnabled = (process.env.TRAILING_STOP_ENABLED || 'true').trim().toLowerCase() === 'true';
      const stagnationEnabled = (process.env.STAGNATION_EXIT_ENABLED || 'true').trim().toLowerCase() === 'true';

      if (VERBOSE_LOGGING) {
        console.log(`🔍 Risk Monitor: ${positions.length} posiciones`);
      }

      for (const pos of positions) {
        if (!pos.mint || !pos.entryPrice || !pos.tokensAmount) continue;

        // Obtener precio actual con rate limiting
        const priceData = await rateLimitedRpcCall(() => 
          priceService.getPriceWithFallback(pos.mint)
        );
        
        if (!priceData || !priceData.price) continue;

        const currentPrice = priceData.price;
        const entryPrice = parseFloat(pos.entryPrice);
        const maxPrice = parseFloat(pos.maxPrice || entryPrice);
        const tokensAmount = parseFloat(pos.tokensAmount);
        const entryTime = parseInt(pos.entryTime || Date.now());
        const solAmount = parseFloat(pos.solAmount || 0);

        // Cálculos
        const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
        const drawdownFromPeak = ((currentPrice - maxPrice) / maxPrice) * 100;
        const holdTimeSec = (Date.now() - entryTime) / 1000;
        const currentValue = tokensAmount * currentPrice;

        // Actualizar max price
        if (currentPrice > maxPrice) {
          await positionManager.updateMaxPrice(pos.mint, currentPrice);
        }

        let triggerSell = false;
        let sellReason = '';

        // ═══════════════════════════════════════════════════════
        // ESTRATEGIAS DE SALIDA
        // ═══════════════════════════════════════════════════════

        // 1. STOP LOSS
        if (stopLossEnabled && pnlPercent <= -stopLossPct) {
          triggerSell = true;
          sellReason = `🛑 STOP LOSS (${pnlPercent.toFixed(2)}%)`;
        }
        
        // 2. TAKE PROFIT
        else if (takeProfitEnabled && pnlPercent >= takeProfitPct) {
          triggerSell = true;
          sellReason = `✅ TAKE PROFIT (${pnlPercent.toFixed(2)}%)`;
        }
        
        // 3. TRAILING STOP
        else if (trailingStopEnabled && drawdownFromPeak <= -trailingStopPct) {
          triggerSell = true;
          sellReason = `📉 TRAILING STOP (Peak: ${maxPrice.toFixed(9)} → ${currentPrice.toFixed(9)} | ${drawdownFromPeak.toFixed(2)}%)`;
        }
        
        // 4. STAGNATION EXIT
        else if (stagnationEnabled && holdTimeSec > STAGNATION_TIME_SEC && pnlPercent < STAGNATION_PNL_THRESHOLD) {
          triggerSell = true;
          sellReason = `💀 STAGNATION (${Math.floor(holdTimeSec)}s @ ${pnlPercent.toFixed(2)}%)`;
        }

        // 5. GRADUACIÓN AUTOMÁTICA (vender si migra a Raydium)
        else if (priceData.graduated) {
          const graduationSellEnabled = (process.env.AUTO_SELL_ON_GRADUATION || 'false').trim().toLowerCase() === 'true';
          if (graduationSellEnabled) {
            triggerSell = true;
            sellReason = `🎓 GRADUATION (migró a Raydium)`;
          }
        }

        // ═══════════════════════════════════════════════════════
        // EJECUTAR VENTA
        // ═══════════════════════════════════════════════════════
        if (triggerSell && tradeExecutor && !cbStatus.active) {
          console.log(`⚡ AUTO-SELL: ${sellReason} para ${pos.symbol} (${pos.mint.slice(0, 8)})`);
          
          const sellResult = await tradeExecutor.sellToken(pos.mint, tokensAmount);

          if (sellResult && sellResult.success) {
            const solReceived = parseFloat(sellResult.solReceived || '0');
            const pnlSOL = solReceived - solAmount;
            
            // Cerrar posición
            await positionManager.closePosition(
              pos.mint,
              currentPrice,
              tokensAmount,
              solReceived,
              sellReason,
              sellResult.signature || 'AUTO_SELL'
            );

            // Registrar resultado para circuit breaker
            recordTradeOutcome(pnlSOL);

            // Alerta Telegram
            if (TELEGRAM_CHAT_ID) {
              const emoji = pnlSOL > 0 ? '🤑' : '🔻';
              const mode = DRY_RUN ? '[PAPER]' : '[LIVE]';
              
              await sendTelegramAlert(
                TELEGRAM_CHAT_ID,
                `${emoji} **AUTO SELL ${mode}**\n\n` +
                `Token: ${pos.symbol}\n` +
                `Reason: ${sellReason}\n\n` +
                `📊 Performance:\n` +
                `PnL: ${pnlPercent.toFixed(2)}%\n` +
                `Profit: ${pnlSOL.toFixed(4)} SOL\n` +
                `Entry: ${entryPrice.toFixed(10)}\n` +
                `Exit: ${currentPrice.toFixed(10)}\n` +
                `Hold: ${Math.floor(holdTimeSec)}s`
              );
            }

            console.log(`   ✅ Posición cerrada: PnL ${pnlSOL.toFixed(4)} SOL (${pnlPercent.toFixed(2)}%)`);
          } else {
            console.error(`   ❌ Error en auto-sell: ${sellResult?.error}`);
          }
        }
      }

      await redis.set('sniper:last_risk_tick', Date.now().toString());

    } catch (error) {
      console.error('⚠️ Error en risk loop:', error?.message || String(error));
    }
  }, RISK_TICK_INTERVAL);
}

// ═══════════════════════════════════════════════════════
// WEBSOCKET FLINTR
// ═══════════════════════════════════════════════════════
function startFlintrWebSocket() {
  if (!FLINTR_API_KEY) {
    console.log('❌ FLINTR_API_KEY no configurada');
    return;
  }

  let ws = null;
  let reconnectDelay = 5000;
  let pingTimeout = null;

  const resetPingTimeout = () => {
    if (pingTimeout) clearTimeout(pingTimeout);
    
    // Si no recibimos ping en 90s, reconectar
    pingTimeout = setTimeout(() => {
      console.log('⚠️ No ping de Flintr en 90s - Reconectando...');
      if (ws) ws.close();
    }, 90000);
  };

  const connect = () => {
    const url = `wss://api-v1.flintr.io/sub?token=${FLINTR_API_KEY}`;
    console.log(`\n🌐 Conectando a Flintr WebSocket...`);

    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log('✅ Flintr WebSocket conectado');
      reconnectDelay = 5000;
      resetPingTimeout();
    });

    ws.on('message', (raw) => {
      resetPingTimeout(); // Reset en cada mensaje

      (async () => {
        let signal;
        try {
          signal = JSON.parse(raw.toString());
        } catch {
          return;
        }

        const eventClass = signal?.event?.class;

        if (eventClass === 'ping') {
          if (VERBOSE_LOGGING) {
            console.log('📡 Flintr ping');
          }
          await redis.set('flintr:last_ping', Date.now().toString());
          return;
        }

        if (eventClass !== 'token') return;

        const eventType = signal?.event?.type;

        if (eventType === 'graduation') {
          await handleGraduationEvent(signal);
          return;
        }

        if (eventType === 'mint') {
          await handleMintEvent(signal);
          return;
        }
      })().catch((err) => {
        console.error('⚠️ Error procesando mensaje:', err?.message);
      });
    });

    ws.on('error', (err) => {
      console.error('⚠️ WebSocket error:', err?.message || String(err));
    });

    ws.on('close', (code, reason) => {
      if (pingTimeout) clearTimeout(pingTimeout);
      
      console.log(`⚠️ WebSocket cerrado (code=${code})`);
      console.log(`   Reconectando en ${reconnectDelay / 1000}s...`);
      
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    });
  };

  connect();
}

// ═══════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════
export async function startSniperEngine(redisInstance) {
  initCore(redisInstance);

  console.log('\n🎯 Pump.fun Sniper Engine MEJORADO');
  console.log('═══════════════════════════════════════════════');
  console.log(`   Modo: ${DRY_RUN ? '📄 PAPER' : '💰 LIVE'}`);
  console.log(`   Auto Trading: ${AUTO_TRADING ? 'ON' : 'OFF'}`);
  console.log('');
  console.log('📊 Configuración Base:');
  console.log(`   Posición base: ${POSITION_SIZE_SOL} SOL`);
  console.log(`   Max posiciones: ${MAX_POSITIONS}`);
  console.log(`   Slots Flintr: ${RESERVED_FLINTR_POSITIONS}`);
  console.log(`   Min liquidez: ${MIN_LIQUIDITY_SOL} SOL`);
  console.log(`   Min bundle: ${MIN_INITIAL_VOLUME_SOL} SOL`);
  console.log('');
  console.log('🧠 Sistema de Scoring:');
  console.log(`   Score mínimo: ${SCORING_CONFIG.minScore}/100`);
  console.log(`   Pesos: Liq ${(SCORING_CONFIG.weights.liquidity*100).toFixed(0)}% | Vol ${(SCORING_CONFIG.weights.volume*100).toFixed(0)}% | Bundle ${(SCORING_CONFIG.weights.bundleSize*100).toFixed(0)}%`);
  console.log('');
  console.log('🛡️ Filtros Anti-Rug:');
  console.log(`   Max creator tokens: ${ANTI_RUG_CONFIG.maxCreatorTokensPercent}%`);
  console.log(`   Min holders: ${ANTI_RUG_CONFIG.minHolders}`);
  console.log(`   Max top holder: ${ANTI_RUG_CONFIG.maxTopHolderPercent}%`);
  console.log('');
  console.log('💰 Position Sizing Dinámico:');
  console.log(`   Enabled: ${DYNAMIC_SIZING.enabled ? 'YES' : 'NO'}`);
  if (DYNAMIC_SIZING.enabled) {
    console.log(`   Range: ${DYNAMIC_SIZING.minMultiplier}x - ${DYNAMIC_SIZING.maxMultiplier}x`);
  }
  console.log('');
  console.log('🚨 Circuit Breaker:');
  console.log(`   Enabled: ${CIRCUIT_BREAKER.enabled ? 'YES' : 'NO'}`);
  if (CIRCUIT_BREAKER.enabled) {
    console.log(`   Max pérdidas seguidas: ${CIRCUIT_BREAKER.maxLossesInRow}`);
    console.log(`   Max pérdida diaria: ${CIRCUIT_BREAKER.maxDailyLossSol} SOL`);
    console.log(`   Pausa: ${Math.ceil(CIRCUIT_BREAKER.pauseDurationSec/60)} min`);
  }
  console.log('');
  console.log('⚡ Rate Limiting:');
  console.log(`   Max RPC/seg: ${RATE_LIMIT.maxRequestsPerSecond}`);
  console.log(`   Burst: ${RATE_LIMIT.burstSize}`);
  console.log('═══════════════════════════════════════════════\n');

  startFlintrWebSocket();
  startRiskLoop();
}

// Filtros anti-rug
const ANTI_RUG_CONFIG = {
  maxCreatorTokensPercent: parseFloat(process.env.MAX_CREATOR_TOKENS_PERCENT || '10'), // Max 10% para creator
  minHolders: parseInt(process.env.MIN_HOLDERS || '5'), // Mínimo 5 holders
  maxTopHolderPercent: parseFloat(process.env.MAX_TOP_HOLDER_PERCENT || '30'), // Max 30% un holder
  minLiquidityLockTime: parseInt(process.env.MIN_LIQUIDITY_LOCK_TIME || '0'), // Segundos
  requireVerifiedContract: (process.env.REQUIRE_VERIFIED_CONTRACT || '').trim().toLowerCase() === 'true'
};

// Position sizing dinámico
const DYNAMIC_SIZING = {
  enabled: (process.env.DYNAMIC_SIZING_ENABLED || '').trim().toLowerCase() === 'true',
  baseSize: POSITION_SIZE_SOL,
  maxMultiplier: parseFloat(process.env.SIZING_MAX_MULTIPLIER || '2.0'), // Max 2x del base
  minMultiplier: parseFloat(process.env.SIZING_MIN_MULTIPLIER || '0.5'), // Min 0.5x del base
};

// Circuit breaker
const CIRCUIT_BREAKER = {
  enabled: (process.env.CIRCUIT_BREAKER_ENABLED || 'true').trim().toLowerCase() === 'true',
  maxLossesInRow: parseInt(process.env.MAX_LOSSES_IN_ROW || '3'),
  pauseDurationSec: parseInt(process.env.CIRCUIT_BREAKER_PAUSE_SEC || '600'), // 10 min
  maxDailyLossSol: parseFloat(process.env.MAX_DAILY_LOSS_SOL || '2')
};

// Rate limiting para RPC
const RATE_LIMIT = {
  maxRequestsPerSecond: parseInt(process.env.MAX_RPC_REQUESTS_PER_SEC || '10'),
  burstSize: parseInt(process.env.RPC_BURST_SIZE || '20')
};

// ═══════════════════════════════════════════════════════
// ESTADO GLOBAL
// ═══════════════════════════════════════════════════════
const lastEntryByMint = new Map();
const priceService = getPriceService();
let tradeExecutor = null;
let riskManager = null;
let positionManager = null;
let redis = null;

// Circuit breaker state
let circuitBreakerActive = false;
let circuitBreakerUntil = 0;
let consecutiveLosses = 0;

// Rate limiter state
const rpcRequestQueue = [];
let rpcRequestsInLastSecond = 0;
let lastRpcReset = Date.now();

// ═══════════════════════════════════════════════════════
// INICIALIZACIÓN
// ═══════════════════════════════════════════════════════
function initCore(redisInstance) {
  redis = redisInstance;

  if (!tradeExecutor) {
    tradeExecutor = new TradeExecutor(
      process.env.PRIVATE_KEY,
      process.env.RPC_URL,
      DRY_RUN
    );
  }

  if (!riskManager) {
    const riskConfig = {
      maxPositionSize: POSITION_SIZE_SOL,
      maxActivePositions: MAX_POSITIONS,
      reservedFlintrPositions: RESERVED_FLINTR_POSITIONS,
      stopLoss: process.env.STOP_LOSS_PERCENT || '13',
      takeProfit: process.env.TAKE_PROFIT_PERCENT || '30',
      minLiquidity: MIN_LIQUIDITY_SOL,
      minInitialVolume: MIN_INITIAL_VOLUME_SOL,
      maxDailyLoss: CIRCUIT_BREAKER.maxDailyLossSol,
      enableRiskManagerLogs: VERBOSE_LOGGING,
    };
    riskManager = new RiskManager(riskConfig, redis);
  }

    if (!positionManager) {
      positionManager = new PositionManager(redis);
    }
  }

// ═══════════════════════════════════════════════════════
// RATE LIMITER
// ═══════════════════════════════════════════════════════
async function rateLimitedRpcCall(fn) {
  const now = Date.now();
  
  // Reset counter cada segundo
  if (now - lastRpcReset >= 1000) {
    rpcRequestsInLastSecond = 0;
    lastRpcReset = now;
  }

  // Si excedemos límite, esperar
  if (rpcRequestsInLastSecond >= RATE_LIMIT.maxRequestsPerSecond) {
    const waitTime = 1000 - (now - lastRpcReset);
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    rpcRequestsInLastSecond = 0;
    lastRpcReset = Date.now();
  }

  rpcRequestsInLastSecond++;
  return await fn();
}

// ═══════════════════════════════════════════════════════
// CIRCUIT BREAKER
// ═══════════════════════════════════════════════════════
async function checkCircuitBreaker() {
  if (!CIRCUIT_BREAKER.enabled) return { active: false };

  const now = Date.now();

  // Si está activo, verificar si ya pasó el tiempo
  if (circuitBreakerActive && now < circuitBreakerUntil) {
    const remainingSec = Math.ceil((circuitBreakerUntil - now) / 1000);
    return {
      active: true,
      reason: 'circuit_breaker_cooldown',
      remainingSec
    };
  } else if (circuitBreakerActive && now >= circuitBreakerUntil) {
    // Reset
    circuitBreakerActive = false;
    consecutiveLosses = 0;
    console.log('🔓 Circuit Breaker RESET - Trading habilitado nuevamente');
    
    if (TELEGRAM_CHAT_ID) {
      await sendTelegramAlert(
        TELEGRAM_CHAT_ID,
        '🔓 **CIRCUIT BREAKER RESET**\n\nEl bot ha reanudado operaciones.'
      );
    }
  }

  // Verificar pérdidas diarias
  try {
    const dailyPnL = await riskManager.getDailyPnL();
    if (dailyPnL < -CIRCUIT_BREAKER.maxDailyLossSol) {
      activateCircuitBreaker('max_daily_loss', dailyPnL);
      return {
        active: true,
        reason: 'max_daily_loss',
        dailyPnL
      };
    }
  } catch (e) {
    console.error('⚠️ Error checking daily PnL:', e?.message);
  }

  return { active: false };
}

function activateCircuitBreaker(reason, details = null) {
  circuitBreakerActive = true;
  circuitBreakerUntil = Date.now() + (CIRCUIT_BREAKER.pauseDurationSec * 1000);
  
  const pauseMinutes = Math.ceil(CIRCUIT_BREAKER.pauseDurationSec / 60);
  
  console.log(`\n🚨 CIRCUIT BREAKER ACTIVADO - Razón: ${reason}`);
  console.log(`   Trading pausado por ${pauseMinutes} minutos`);
  if (details !== null) {
    console.log(`   Detalles: ${JSON.stringify(details)}`);
  }

  if (TELEGRAM_CHAT_ID) {
    sendTelegramAlert(
      TELEGRAM_CHAT_ID,
      `🚨 **CIRCUIT BREAKER ACTIVADO**\n\n` +
      `Razón: ${reason}\n` +
      `Pausa: ${pauseMinutes} minutos\n` +
      (details !== null ? `\nDetalles: ${JSON.stringify(details)}` : '')
    );
  }
}

function recordTradeOutcome(pnlSOL) {
  if (!CIRCUIT_BREAKER.enabled) return;

  if (pnlSOL < 0) {
    consecutiveLosses++;
    if (consecutiveLosses >= CIRCUIT_BREAKER.maxLossesInRow) {
      activateCircuitBreaker('consecutive_losses', { count: consecutiveLosses });
    }
  } else {
    consecutiveLosses = 0; // Reset en ganancia
  }
}

// ═══════════════════════════════════════════════════════
// SISTEMA DE SCORING
// ═══════════════════════════════════════════════════════
function calculateTokenScore(tokenData, priceData) {
  const scores = {};
  let totalScore = 0;

  // 1. LIQUIDEZ (0-100)
  const liquidity = priceData.virtualSolReserves || 0;
  if (liquidity >= 10) scores.liquidity = 100;
  else if (liquidity >= 5) scores.liquidity = 80;
  else if (liquidity >= 2) scores.liquidity = 60;
  else if (liquidity >= 1) scores.liquidity = 40;
  else scores.liquidity = 20;

  // 2. VOLUMEN INICIAL (0-100)
  const volume = tokenData.bundleAmount || 0;
  if (volume >= 1.0) scores.volume = 100;
  else if (volume >= 0.5) scores.volume = 80;
  else if (volume >= 0.2) scores.volume = 60;
  else if (volume >= 0.05) scores.volume = 40;
  else scores.volume = 20;

  // 3. BUNDLE SIZE RATIO (0-100)
  // Bundle grande vs liquidez = más confianza
  const bundleRatio = volume / (liquidity || 1);
  if (bundleRatio >= 0.3) scores.bundleSize = 100;
  else if (bundleRatio >= 0.15) scores.bundleSize = 75;
  else if (bundleRatio >= 0.05) scores.bundleSize = 50;
  else scores.bundleSize = 25;

  // 4. HOLDER CONCENTRATION - placeholder (necesita datos adicionales)
  // Por ahora asumimos neutral
  scores.holderConcentration = 50;

  // 5. PRICE STABILITY - placeholder
  // Se podría implementar mirando precio vs virtual reserves
  scores.priceStability = 50;

  // 6. MOMENTUM - placeholder
  // Se podría implementar con datos históricos
  scores.momentum = 50;

  // Calcular score ponderado
  for (const [key, score] of Object.entries(scores)) {
    const weight = SCORING_CONFIG.weights[key] || 0;
    totalScore += score * weight;
  }

  return {
    totalScore: Math.round(totalScore),
    breakdown: scores,
    verdict: totalScore >= SCORING_CONFIG.minScore ? 'PASS' : 'FAIL'
  };
}

// ═══════════════════════════════════════════════════════
// FILTROS ANTI-RUG
// ═══════════════════════════════════════════════════════
async function checkAntiRugFilters(mint, tokenData, priceData) {
  const warnings = [];
  const failures = [];

  // 1. Verificar concentración de tokens del creador
  // (Requeriría datos adicionales de holders - placeholder)
  
  // 2. Liquidez mínima
  const liquidity = priceData.virtualSolReserves || 0;
  if (liquidity < MIN_LIQUIDITY_SOL) {
    failures.push(`Liquidez muy baja: ${liquidity.toFixed(2)} SOL`);
  }

  // 3. Volumen inicial mínimo
  const volume = tokenData.bundleAmount || 0;
  if (volume < MIN_INITIAL_VOLUME_SOL && MIN_INITIAL_VOLUME_SOL > 0) {
    failures.push(`Volumen inicial bajo: ${volume.toFixed(4)} SOL`);
  }

  // 4. Verificar si ya está graduado (potencial rug si ya migró)
  if (priceData.graduated) {
    warnings.push('Token ya graduado a Raydium');
  }

  // 5. Precio sospechosamente bajo
  if (priceData.price && priceData.price < 0.000000001) {
    warnings.push(`Precio extremadamente bajo: ${priceData.price}`);
  }

  // 6. Ratio liquidez/supply sospechoso
  const liquidityRatio = liquidity / (priceData.tokenTotalSupply || 1);
  if (liquidityRatio < 0.00001) {
    warnings.push('Ratio liquidez/supply muy bajo');
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
    safetyScore: Math.max(0, 100 - (failures.length * 25) - (warnings.length * 10))
  };
}

// ═══════════════════════════════════════════════════════
// POSITION SIZING DINÁMICO
// ═══════════════════════════════════════════════════════
function calculateDynamicSize(tokenScore, safetyScore, baseSize = POSITION_SIZE_SOL) {
  if (!DYNAMIC_SIZING.enabled) {
    return baseSize;
  }

  // Combinar scores: 70% token quality, 30% safety
  const combinedScore = (tokenScore * 0.7) + (safetyScore * 0.3);
  
  // Mapear score a multiplier (50-100 → 0.5x-2.0x)
  let multiplier = 1.0;
  
  if (combinedScore >= 90) multiplier = DYNAMIC_SIZING.maxMultiplier; // 2.0x
  else if (combinedScore >= 80) multiplier = 1.5;
  else if (combinedScore >= 70) multiplier = 1.2;
  else if (combinedScore >= 60) multiplier = 1.0;
  else multiplier = DYNAMIC_SIZING.minMultiplier; // 0.5x

  const finalSize = baseSize * multiplier;
  
  return Math.max(
    baseSize * DYNAMIC_SIZING.minMultiplier,
    Math.min(finalSize, baseSize * DYNAMIC_SIZING.maxMultiplier)
  );
}

// ═══════════════════════════════════════════════════════
// HANDLE GRADUATION
// ═══════════════════════════════════════════════════════
async function handleGraduationEvent(signal) {
  try {
    const mint = signal?.data?.mint;
    if (!mint) return;

    await redis.set(`graduated:${mint}`, 'true', 'EX', 3 * 24 * 60 * 60);
    
    // Verificar si tenemos posición abierta
    const position = await redis.hgetall(`position:${mint}`);
    if (position && position.status === 'open') {
      console.log(`🎓 Token ${mint.slice(0, 8)} graduado - Considerar venta`);
      
      if (TELEGRAM_CHAT_ID) {
        await sendTelegramAlert(
          TELEGRAM_CHAT_ID,
          `🎓 **TOKEN GRADUADO**\n\n` +
          `Mint: ${mint}\n` +
          `Symbol: ${position.symbol || 'UNKNOWN'}\n\n` +
          `El token migró a Raydium. Considera vender.`
        );
      }
    }

    if (VERBOSE_LOGGING) {
      console.log(`🎓 Flintr: token graduated ${mint.slice(0, 8)}`);
    }
  } catch (error) {
    console.error('⚠️ Error handling graduation:', error?.message);
  }
}

// ═══════════════════════════════════════════════════════
// HANDLE MINT EVENT - MEJORADO
// ═══════════════════════════════════════════════════════
async function handleMintEvent(signal) {
  try {
    const event = signal?.event || {};
    const data = signal?.data || {};

    if (event.platform !== 'pump.fun') return;

    const mint = data.mint;
    const metaData = data.metaData || {};
    const tokenData = data.tokenData || {};
    const ammData = data.ammData || {};

    if (!mint || !mint.endsWith('pump')) {
      if (VERBOSE_LOGGING) {
        console.log('⚠️ Mint inválido:', mint);
      }
      return;
    }

    const symbol = metaData.symbol || 'UNKNOWN';
    const name = metaData.name || symbol;
    const creator = tokenData.creator || 'N/A';
    const isBundled = !!tokenData.isBundled;
    const bundleAmount = Number(tokenData.bundleAmount || 0);

    const now = Date.now();

    // ══════════════════════════════════════════════════
    // 1. COOLDOWN POR MINT
    // ══════════════════════════════════════════════════
    const lastEntry = lastEntryByMint.get(mint);
    if (lastEntry && now - lastEntry < MIN_TIME_BETWEEN_SAME_TOKEN * 1000) {
      if (VERBOSE_LOGGING) {
        console.log(`⏳ Cooldown activo para ${symbol} (${mint.slice(0, 8)})`);
      }
      return;
    }

    // ══════════════════════════════════════════════════
    // 2. CIRCUIT BREAKER
    // ══════════════════════════════════════════════════
    const cbStatus = await checkCircuitBreaker();
    if (cbStatus.active) {
      if (VERBOSE_LOGGING) {
        console.log(`🚨 Circuit Breaker activo - Ignorando señal ${symbol}`);
      }
      return;
    }

    console.log(`\n🚀 [FLINTR] Nuevo token: ${name} (${symbol})`);
    console.log(`   Mint: ${mint}`);
    console.log(`   Creator: ${creator}`);
    console.log(`   Bundle: ${bundleAmount.toFixed(4)} SOL | Bundled: ${isBundled ? '✅' : '❌'}`);

    // ══════════════════════════════════════════════════
    // 3. OBTENER PRECIO ON-CHAIN
    // ══════════════════════════════════════════════════
    const pumpPrice = await rateLimitedRpcCall(() => priceService.getPrice(mint, true));
    
    if (!pumpPrice || !pumpPrice.price || pumpPrice.graduated) {
      console.log('   ⚠️ Precio inválido o token ya graduado');
      return;
    }

    const entryPrice = pumpPrice.price;
    const virtualSolReserves = pumpPrice.virtualSolReserves || 0;

    console.log(`   💰 Precio: ${entryPrice.toFixed(12)} SOL/token`);
    console.log(`   💧 Liquidez: ${virtualSolReserves.toFixed(3)} SOL`);

    // ══════════════════════════════════════════════════
    // 4. SISTEMA DE SCORING
    // ══════════════════════════════════════════════════
    const scoreResult = calculateTokenScore(
      { ...tokenData, bundleAmount },
      pumpPrice
    );

    console.log(`   📊 Score: ${scoreResult.totalScore}/100 (${scoreResult.verdict})`);
    console.log(`      - Liquidez: ${scoreResult.breakdown.liquidity}`);
    console.log(`      - Volumen: ${scoreResult.breakdown.volume}`);
    console.log(`      - Bundle: ${scoreResult.breakdown.bundleSize}`);

    if (scoreResult.verdict === 'FAIL') {
      console.log(`   🚫 Score insuficiente (mín: ${SCORING_CONFIG.minScore})`);
      return;
    }

    // ══════════════════════════════════════════════════
    // 5. FILTROS ANTI-RUG
    // ══════════════════════════════════════════════════
    const rugCheck = await checkAntiRugFilters(mint, tokenData, pumpPrice);

    if (!rugCheck.passed) {
      console.log(`   🚫 Falló filtros anti-rug:`);
      rugCheck.failures.forEach(f => console.log(`      - ${f}`));
      return;
    }

    if (rugCheck.warnings.length > 0) {
      console.log(`   ⚠️ Advertencias:`);
      rugCheck.warnings.forEach(w => console.log(`      - ${w}`));
    }

    console.log(`   🛡️ Safety Score: ${rugCheck.safetyScore}/100`);

    // ══════════════════════════════════════════════════
    // 6. RISK MANAGER CHECK
    // ══════════════════════════════════════════════════
    const signals = {
      source: 'flintr',
      bundleAmount,
      virtualSolReserves,
      isBundled,
      creator,
      tokenScore: scoreResult.totalScore,
      safetyScore: rugCheck.safetyScore,
      bondingCurve: ammData.bondingCurve,
      onlyKingOfHill: ONLY_KING_OF_HILL,
    };

    const riskDecision = await riskManager.shouldEnterTrade(mint, entryPrice, signals);

    if (!riskDecision.allowed) {
      console.log(`   🛑 Bloqueado por RiskManager: ${riskDecision.reason}`);
      return;
    }

    // ══════════════════════════════════════════════════
    // 7. CALCULAR TAMAÑO DINÁMICO
    // ══════════════════════════════════════════════════
    const dynamicSize = calculateDynamicSize(
      scoreResult.totalScore,
      rugCheck.safetyScore,
      riskDecision.size || POSITION_SIZE_SOL
    );

    console.log(`   💰 Tamaño posición: ${dynamicSize.toFixed(4)} SOL (base: ${POSITION_SIZE_SOL})`);
    console.log(`   ✅ Entrada permitida (slot: ${riskDecision.slotType || 'generic'})`);

    // ══════════════════════════════════════════════════
    // 8. AUTO TRADING CHECK
    // ══════════════════════════════════════════════════
    if (!AUTO_TRADING) {
      console.log('   ⚠️ AUTO_TRADING=false → Solo señal');

      if (TELEGRAM_ALERT_ON_ENTRY && TELEGRAM_CHAT_ID) {
        await sendTelegramAlert(
          TELEGRAM_CHAT_ID,
          `📡 [SIGNAL] ${name} (${symbol})\n\n` +
          `Score: ${scoreResult.totalScore}/100\n` +
          `Safety: ${rugCheck.safetyScore}/100\n` +
          `Precio: ${entryPrice.toFixed(12)} SOL\n` +
          `Bundle: ${bundleAmount.toFixed(4)} SOL\n` +
          `Tamaño sugerido: ${dynamicSize.toFixed(4)} SOL\n\n` +
          `Auto trading: OFF`
        );
      }

      lastEntryByMint.set(mint, now);
      return;
    }

    // ══════════════════════════════════════════════════
    // 9. EJECUTAR COMPRA
    // ══════════════════════════════════════════════════
    console.log(`   🛒 Ejecutando BUY ${DRY_RUN ? '[PAPER]' : '[LIVE]'}: ${dynamicSize.toFixed(4)} SOL`);

    const buyResult = await tradeExecutor.buyToken(mint, dynamicSize);

    if (!buyResult || !buyResult.success) {
      console.log(`   ❌ BUY fallido: ${buyResult?.error || 'unknown'}`);
      return;
    }

    const tokensReceived = Number(buyResult.tokensReceived || 0);
    const solSpent = Number(buyResult.solSpent || dynamicSize);

    if (!tokensReceived || tokensReceived <= 0) {
      console.log(`   ⚠️ BUY sin tokens válidos`);
      return;
    }

    const storedEntryPrice = buyResult.entryPrice || entryPrice || solSpent / tokensReceived || 0;

    // ══════════════════════════════════════════════════
    // 10. GUARDAR POSICIÓN
    // ══════════════════════════════════════════════════
    const position = await positionManager.openPosition(
      mint,
      symbol,
      storedEntryPrice,
      solSpent,
      tokensReceived,
      buyResult.signature || 'unknown'
    );

    // Guardar metadata adicional
    try {
      await redis.hmset(`position:${mint}`, {
        entry_strategy: 'flintr',
        token_score: scoreResult.totalScore,
        safety_score: rugCheck.safetyScore,
        dynamic_size_multiplier: (dynamicSize / POSITION_SIZE_SOL).toFixed(2)
      });
    } catch (e) {
      console.error('⚠️ Error guardando metadata:', e?.message);
    }

    lastEntryByMint.set(mint, now);

    console.log(`   ✅ Posición abierta: ${symbol} - ${solSpent.toFixed(4)} SOL → ${tokensReceived.toLocaleString()} tokens`);

    // ══════════════════════════════════════════════════
    // 11. ALERTA TELEGRAM
    // ══════════════════════════════════════════════════
    if (TELEGRAM_ALERT_ON_ENTRY && TELEGRAM_CHAT_ID) {
      const emoji = DRY_RUN ? '📝' : '💰';
      await sendTelegramAlert(
        TELEGRAM_CHAT_ID,
        `${emoji} [ENTRY ${DRY_RUN ? 'PAPER' : 'LIVE'}]\n\n` +
        `Token: ${name} (${symbol})\n` +
        `Mint: \`${mint}\`\n\n` +
        `📊 Análisis:\n` +
        `Score: ${scoreResult.totalScore}/100\n` +
        `Safety: ${rugCheck.safetyScore}/100\n\n` +
        `💰 Operación:\n` +
        `Spent: ${solSpent.toFixed(4)} SOL\n` +
        `Received: ${tokensReceived.toLocaleString()} tokens\n` +
        `Entry: ${storedEntryPrice.toFixed(12)} SOL\n` +
        `Bundle: ${bundleAmount.toFixed(4)} SOL\n` +
        `Liquidez: ${virtualSolReserves.toFixed(3)} SOL`
      );
    }

  } catch (error) {
    console.error('❌ Error en handleMintEvent:', error?.message || String(error));
  }
}
