// sniperEngine.js - Flintr-based Pump.fun Sniper Core
// ✅ DRY_RUN + PnL correcto + AUTO SELL + STAGNATION EXIT

import WebSocket from 'ws';
import { getPriceService } from './priceService.js';
import { RiskManager, PositionManager } from './riskManager.js';
import { TradeExecutor } from './tradeExecutor.js';
import { sendTelegramAlert } from './telegram.js';

const FLINTR_API_KEY = process.env.FLINTR_API_KEY;

// DRY_RUN: por defecto PAPER salvo que pongas DRY_RUN="false"
const DRY_RUN = (process.env.DRY_RUN || '').trim().toLowerCase() !== 'false';

// Trading automático
const AUTO_TRADING =
  (process.env.ENABLE_AUTO_TRADING || '').trim().toLowerCase() === 'true';

// Tamaños / slots
const POSITION_SIZE_SOL = parseFloat(process.env.POSITION_SIZE_SOL || '0.05');
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '2', 10);

// Liquidez mínima sobre bonding curve (virtualSolReserves)
const MIN_LIQUIDITY_SOL = parseFloat(process.env.MIN_LIQUIDITY_SOL || '2');

// Volumen inicial mínimo (bundleAmount de Flintr) en SOL
const MIN_INITIAL_VOLUME_SOL = parseFloat(
  process.env.MIN_INITIAL_VOLUME_SOL || '0',
);

// Tiempo mínimo entre reentradas al mismo token (segundos)
const MIN_TIME_BETWEEN_SAME_TOKEN = parseInt(
  process.env.MIN_TIME_BETWEEN_SAME_TOKEN || '900', // 15 min
  10,
);

// Slots reservados para Flintr dentro de MAX_POSITIONS
const RESERVED_FLINTR_POSITIONS = parseInt(
  process.env.RESERVED_FLINTR_POSITIONS || '0',
  10,
);

// Solo tokens que lleguen a King of the Hill (para futuro)
const ONLY_KING_OF_HILL =
  (process.env.ONLY_KING_OF_HILL || '').trim().toLowerCase() === 'true';

// Telegram
const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_OWNER_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_ALERT_ON_ENTRY =
  (process.env.TELEGRAM_ALERT_ON_ENTRY || '').trim().toLowerCase() === 'true';

// Logging detallado
const VERBOSE_LOGGING =
  (process.env.VERBOSE_LOGGING || '').trim().toLowerCase() === 'true';

// Intervalo del loop de riesgo (ms)
const RISK_TICK_INTERVAL = parseInt(
  process.env.RISK_TICK_INTERVAL || '5000',
  10,
);

// 🔥 CONFIGURACIÓN DE SALIDA POR ESTANCAMIENTO (STAGNATION EXIT) 🔥
// Si pasan X segundos y el PnL es menor a Y%, vender automáticamente.
const STAGNATION_TIME_SEC = parseInt(
  process.env.STAGNATION_TIME_SEC || '300', // 5 minutos por defecto
  10,
);
const STAGNATION_PNL_THRESHOLD = parseFloat(
  process.env.STAGNATION_PNL_THRESHOLD || '5', // Si en 5 min no llevas +5%, vende
);

// Mapa para cooldown por mint
const lastEntryByMint = new Map();

// Instancias compartidas
const priceService = getPriceService();
let tradeExecutor = null;
let riskManager = null;
let positionManager = null;

/**
 * Inicializa TradeExecutor, RiskManager y PositionManager
 */
function initCore(redis) {
  if (!tradeExecutor) {
    const rpcUrl = process.env.RPC_URL;
    const pk = process.env.PRIVATE_KEY;

    tradeExecutor = new TradeExecutor(pk, rpcUrl, DRY_RUN);
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
      maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS_SOL || '2'),
      enableRiskManagerLogs: VERBOSE_LOGGING,
    };

    riskManager = new RiskManager(riskConfig, redis);
  }

  if (!positionManager) {
    positionManager = new PositionManager(redis);
  }
}

/**
 * Marca token como graduado (para PriceService / graduación)
 */
async function handleGraduationEvent(redis, signal) {
  try {
    const mint = signal?.data?.mint;
    if (!mint) return;

    await redis.set(`graduated:${mint}`, 'true', 'EX', 3 * 24 * 60 * 60);
    if (VERBOSE_LOGGING) {
      console.log(`🎓 Flintr: token graduated ${mint.slice(0, 8)}`);
    }
  } catch (error) {
    console.error(
      '⚠️ Error handling Flintr graduation:',
      error?.message || String(error),
    );
  }
}

/**
 * Lógica principal para eventos "mint" de Flintr (Pump.fun)
 */
async function handleMintEvent(redis, signal) {
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
        console.log('⚠️ Flintr mint sin mint válido / sin sufijo pump:', mint);
      }
      return;
    }

    const symbol = metaData.symbol || 'UNKNOWN';
    const name = metaData.name || symbol;
    const decimals = tokenData.decimals ?? 6;
    const creator = tokenData.creator || 'N/A';
    const isBundled = !!tokenData.isBundled;
    const bundleAmount = Number(tokenData.bundleAmount || 0);
    const flintrLatestPrice = tokenData.latestPrice
      ? Number(tokenData.latestPrice)
      : null;

    const now = Date.now();

    // Cooldown por mint
    const lastEntry = lastEntryByMint.get(mint);
    if (lastEntry && now - lastEntry < MIN_TIME_BETWEEN_SAME_TOKEN * 1000) {
      if (VERBOSE_LOGGING) {
        console.log(
          `⏳ Cooldown activo para ${mint.slice(0, 8)} (${(
            (now - lastEntry) /
            1000
          ).toFixed(0)}s desde última entrada)`,
        );
      }
      return;
    }

    // Filtro por volumen inicial (bundle)
    if (MIN_INITIAL_VOLUME_SOL > 0 && bundleAmount < MIN_INITIAL_VOLUME_SOL) {
      if (VERBOSE_LOGGING) {
        console.log(
          `⚠️ Bundle pequeño para ${symbol} (${mint.slice(
            0,
            8,
          )}) - bundle: ${bundleAmount.toFixed(
            4,
          )} SOL (mín: ${MIN_INITIAL_VOLUME_SOL} SOL)`,
        );
      }
      return;
    }

    console.log(`\n🚀 [FLINTR] Nuevo Pump.fun token: ${name} (${symbol})`);
    console.log(`   Mint: ${mint}`);
    console.log(`   Creator: ${creator}`);
    console.log(`   Decimals: ${decimals}`);
    console.log(
      `   Bundle: ${bundleAmount.toFixed(4)} SOL | Bundled: ${
        isBundled ? '✅' : '❌'
      }`,
    );
    if (flintrLatestPrice) {
      console.log(`   Flintr latestPrice: ${flintrLatestPrice}`);
    }

    // 1) Precio on-chain usando PriceService (SDK/bonding curve)
    const pumpPrice = await priceService.getPrice(mint, true);
    if (!pumpPrice || !pumpPrice.price || pumpPrice.graduated) {
      console.log(
        '   ⚠️ No se pudo obtener precio inicial válido (o ya graduado)',
      );
      return;
    }

    const entryPrice = pumpPrice.price;
    const virtualSolReserves = pumpPrice.virtualSolReserves || 0;

    console.log(
      `   💰 Precio inicial (SDK): ${entryPrice.toFixed(12)} SOL/token`,
    );
    console.log(
      `   💧 Liquidez virtual: ${virtualSolReserves.toFixed(
        3,
      )} SOL (mín: ${MIN_LIQUIDITY_SOL} SOL)`,
    );

    // 2) Chequeo de slots / daily loss / liquidez via RiskManager
    const signals = {
      source: 'flintr',
      bundleAmount,
      latestPrice: flintrLatestPrice,
      virtualSolReserves,
      isBundled,
      creator,
      bondingCurve: ammData.bondingCurve,
      associatedBondingCurve: ammData.associatedBondingCurve,
      onlyKingOfHill: ONLY_KING_OF_HILL,
    };

    const riskDecision = await riskManager.shouldEnterTrade(
      mint,
      entryPrice,
      signals,
    );

    if (!riskDecision.allowed) {
      if (VERBOSE_LOGGING) {
        console.log(
          `   🛑 Entrada bloqueada por RiskManager (razón: ${riskDecision.reason})`,
        );
      }
      return;
    }

    const solSize = riskDecision.size || POSITION_SIZE_SOL;

    console.log(
      `   ✅ Entrada permitida (slot: ${
        riskDecision.slotType || 'generic'
      }) - Tamaño: ${solSize} SOL`,
    );

    // 3) Si AUTO_TRADING está apagado → solo señal / log
    if (!AUTO_TRADING) {
      console.log(
        '   ⚠️ ENABLE_AUTO_TRADING=false → Solo señal, no se ejecuta BUY.',
      );

      if (TELEGRAM_ALERT_ON_ENTRY && TELEGRAM_CHAT_ID) {
        await sendTelegramAlert(
          TELEGRAM_CHAT_ID,
          `📡 [SIGNAL] Nuevo token Pump.fun (solo señal)\n\n` +
            `Token: ${name} (${symbol})\n` +
            `Mint: \`${mint}\`\n` +
            `Precio (SDK): ${entryPrice.toFixed(12)} SOL\n` +
            `Bundle: ${bundleAmount.toFixed(4)} SOL\n` +
            `Liquidez virtual: ${virtualSolReserves.toFixed(3)} SOL\n\n` +
            `Auto trading: OFF`,
        );
      }

      lastEntryByMint.set(mint, now);
      return;
    }

    // 4) Ejecutar BUY (DRY_RUN o LIVE usando TradeExecutor)
    console.log(
      `   🛒 Ejecutando BUY ${DRY_RUN ? '[PAPER]' : '[LIVE]'}: ${solSize} SOL en ${symbol} (${mint.slice(0, 8)})`,
    );

    const buyResult = await tradeExecutor.buyToken(mint, solSize);

    if (!buyResult || !buyResult.success) {
      console.log(
        `   ❌ Falló BUY para ${mint.slice(0, 8)}: ${
          buyResult?.error || 'unknown error'
        }`,
      );
      return;
    }

    const tokensReceived = Number(
      buyResult.tokensReceived || buyResult.tokensOut || 0,
    );
    const solSpent = Number(buyResult.solSpent || solSize);

    if (!tokensReceived || tokensReceived <= 0) {
      console.log(
        `   ⚠️ BUY sin tokensReceived válidos para ${mint.slice(0, 8)}`,
      );
      return;
    }

    const storedEntryPrice =
      buyResult.entryPrice || entryPrice || solSpent / tokensReceived || 0;

    // 5) Guardar posición en Redis via PositionManager
    const position = await positionManager.openPosition(
      mint,
      symbol,
      storedEntryPrice,
      solSpent,
      tokensReceived,
      buyResult.signature || 'unknown',
    );

    // Marcar que la entrada viene del sniper Flintr
    try {
      await redis.hset(`position:${mint}`, 'entry_strategy', 'flintr');
    } catch (e) {
      console.error(
        '⚠️ No se pudo marcar entry_strategy=flintr:',
        e?.message || String(e),
      );
    }

    lastEntryByMint.set(mint, now);

    console.log(
      `   ✅ Posición abierta: ${position.symbol} (${mint.slice(
        0,
        8,
      )}) - ${solSpent.toFixed(4)} SOL → ${tokensReceived.toLocaleString()} tokens`,
    );

    if (TELEGRAM_ALERT_ON_ENTRY && TELEGRAM_CHAT_ID) {
      await sendTelegramAlert(
        TELEGRAM_CHAT_ID,
        `🚀 [ENTRY ${DRY_RUN ? 'PAPER' : 'LIVE'}]\n\n` +
          `Token: ${name} (${symbol})\n` +
          `Mint: \`${mint}\`\n` +
          `Spent: ${solSpent.toFixed(4)} SOL\n` +
          `Received: ${tokensReceived.toLocaleString()} tokens\n` +
          `Entry Price: ${storedEntryPrice.toFixed(12)} SOL\n` +
          `Bundle: ${bundleAmount.toFixed(4)} SOL\n` +
          `Liquidez virtual: ${virtualSolReserves.toFixed(3)} SOL`,
      );
    }
  } catch (error) {
    console.error('❌ Error en handleMintEvent:', error?.message || String(error));
  }
}

/**
 * 🔥 LOOP DE RIESGO MEJORADO CON STAGNATION EXIT 🔥
 * 
 * Revisa posiciones abiertas cada RISK_TICK_INTERVAL y ejecuta:
 * 1. Stop Loss (-X%)
 * 2. Take Profit (+Y%)
 * 3. Trailing Stop (caída desde peak)
 * 4. 💀 STAGNATION EXIT: Si llevamos mucho tiempo sin ganancias significativas
 */
function startRiskLoop(redis) {
  if (!RISK_TICK_INTERVAL || RISK_TICK_INTERVAL <= 0) return;

  console.log(`🛡️ Iniciando Monitor de Riesgo (Tick: ${RISK_TICK_INTERVAL}ms)`);
  console.log(`   💀 Stagnation Exit: >${STAGNATION_TIME_SEC}s sin >= +${STAGNATION_PNL_THRESHOLD}%`);
  console.log('');

  setInterval(async () => {
    try {
      if (!positionManager) return;
      const positions = await positionManager.getOpenPositions();
      
      if (positions.length === 0) {
        await redis.set('sniper:last_risk_tick', Date.now().toString());
        return;
      }

      // Leer configuración de porcentajes de salida
      const stopLossPct = parseFloat(process.env.STOP_LOSS_PERCENT || '13');
      const takeProfitPct = parseFloat(process.env.TAKE_PROFIT_PERCENT || '30');
      const trailingStopPct = parseFloat(process.env.TRAILING_STOP_PERCENT || '15');

      if (VERBOSE_LOGGING) {
        console.log(`🔍 Monitor de Riesgo: Revisando ${positions.length} posiciones...`);
      }

      for (const pos of positions) {
        // Validar datos mínimos de la posición
        if (!pos.mint || !pos.entryPrice || !pos.tokensAmount) continue;

        // Obtener precio actual REAL (con fallback al entry si falla RPC)
        const priceData = await priceService.getPriceWithFallback(pos.mint);
        
        if (!priceData || !priceData.price) continue;

        const currentPrice = priceData.price;
        const entryPrice = parseFloat(pos.entryPrice);
        const maxPrice = parseFloat(pos.maxPrice || entryPrice); // Precio máximo histórico
        const tokensAmount = parseFloat(pos.tokensAmount);
        const entryTime = parseInt(pos.entryTime || Date.now());

        // Cálculos de rendimiento
        const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
        const drawdownFromPeak = ((currentPrice - maxPrice) / maxPrice) * 100; // Caída desde pico
        const holdTimeSec = (Date.now() - entryTime) / 1000; // Tiempo sosteniendo posición

        // Actualizar precio máximo alcanzado si es mayor
        if (currentPrice > maxPrice) {
          await positionManager.updateMaxPrice(pos.mint, currentPrice);
        }

        let triggerSell = false;
        let sellReason = '';

        // ═══════════════════════════════════════════════════════
        // 1️⃣ STOP LOSS: Pérdida máxima aceptable
        // ═══════════════════════════════════════════════════════
        if (pnlPercent <= -stopLossPct) {
          triggerSell = true;
          sellReason = `🛑 STOP LOSS (${pnlPercent.toFixed(2)}% <= -${stopLossPct}%)`;
        } 
        // ═══════════════════════════════════════════════════════
        // 2️⃣ TAKE PROFIT: Objetivo de ganancia alcanzado
        // ═══════════════════════════════════════════════════════
        else if (pnlPercent >= takeProfitPct) {
          triggerSell = true;
          sellReason = `✅ TAKE PROFIT (${pnlPercent.toFixed(2)}% >= ${takeProfitPct}%)`;
        }
        // ═══════════════════════════════════════════════════════
        // 3️⃣ TRAILING STOP: Caída significativa desde el pico
        // ═══════════════════════════════════════════════════════
        else if (drawdownFromPeak <= -trailingStopPct) {
          triggerSell = true;
          sellReason = `📉 TRAILING STOP (Peak: ${maxPrice.toFixed(9)} → Curr: ${currentPrice.toFixed(9)} | Drop: ${drawdownFromPeak.toFixed(2)}%)`;
        }
        // ═══════════════════════════════════════════════════════
        // 4️⃣ 💀 STAGNATION EXIT: Mucho tiempo sin ganancias suficientes
        // Si llevamos más de STAGNATION_TIME_SEC segundos y no hemos
        // alcanzado al menos STAGNATION_PNL_THRESHOLD% de ganancia,
        // cortamos pérdidas y liberamos capital.
        // ═══════════════════════════════════════════════════════
        else if (holdTimeSec > STAGNATION_TIME_SEC && pnlPercent < STAGNATION_PNL_THRESHOLD) {
          triggerSell = true;
          sellReason = `💀 STAGNATION EXIT (Hold: ${Math.floor(holdTimeSec)}s > ${STAGNATION_TIME_SEC}s & PnL: ${pnlPercent.toFixed(2)}% < ${STAGNATION_PNL_THRESHOLD}%)`;
        }

        // ═══════════════════════════════════════════════════════
        // EJECUTAR VENTA AUTOMÁTICA
        // ═══════════════════════════════════════════════════════
        if (triggerSell && tradeExecutor) {
          console.log(`⚡ AUTO-SELL: ${sellReason} para ${pos.symbol} (${pos.mint.slice(0, 8)})...`);
          
          // Ejecutar venta (tradeExecutor maneja si es DRY_RUN o LIVE)
          const sellResult = await tradeExecutor.sellToken(pos.mint, tokensAmount);

          if (sellResult && sellResult.success) {
            const solReceived = parseFloat(sellResult.solReceived || '0');
            
            // Cerrar posición en Base de Datos (Redis)
            await positionManager.closePosition(
              pos.mint,
              currentPrice,
              tokensAmount,
              solReceived,
              sellReason,
              sellResult.signature || 'AUTO_SELL_BOT'
            );

            // Enviar alerta a Telegram
            if (TELEGRAM_CHAT_ID) {
              const modeTxt = DRY_RUN ? '[PAPER]' : '[LIVE]';
              const emoji = pnlPercent > 0 ? '🤑' : '🔻';
              const solProfit = solReceived - parseFloat(pos.solAmount || '0');
              
              await sendTelegramAlert(
                TELEGRAM_CHAT_ID,
                `${emoji} **AUTO SELL ${modeTxt}**\n\n` +
                `Token: ${pos.symbol}\n` +
                `Reason: ${sellReason}\n` +
                `PnL: ${pnlPercent.toFixed(2)}%\n` +
                `Entry: ${entryPrice.toFixed(10)}\n` +
                `Exit: ${currentPrice.toFixed(10)}\n` +
                `Hold Time: ${Math.floor(holdTimeSec)}s\n` +
                `Profit: ${solProfit.toFixed(4)} SOL`
              );
            }
          } else {
            console.error(`❌ Error ejecutando auto-sell para ${pos.symbol}: ${sellResult?.error}`);
          }
        }
      }

      // Marcar tick como completado en Redis
      await redis.set('sniper:last_risk_tick', Date.now().toString());

    } catch (error) {
      console.error('⚠️ Error en risk loop:', error?.message || String(error));
    }
  }, RISK_TICK_INTERVAL);
}

/**
 * WebSocket de Flintr + reconexión automática
 */
function startFlintrWebSocket(redis) {
  if (!FLINTR_API_KEY) {
    console.log('❌ FLINTR_API_KEY no configurada - Sniper deshabilitado');
    return;
  }

  let ws = null;
  let reconnectDelay = 5000;

  const connect = () => {
    const url = `wss://api-v1.flintr.io/sub?token=${FLINTR_API_KEY}`;
    console.log(`\n🌐 Conectando a Flintr WebSocket: ${url}`);

    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log('✅ Flintr WebSocket conectado');
      reconnectDelay = 5000;
    });

    ws.on('message', (raw) => {
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
            console.log('📡 Flintr ping recibido');
          }
          await redis.set('flintr:last_ping', Date.now().toString());
          return;
        }

        if (eventClass !== 'token') return;

        const eventType = signal?.event?.type;

        if (eventType === 'graduation') {
          await handleGraduationEvent(redis, signal);
          return;
        }

        if (eventType === 'mint') {
          await handleMintEvent(redis, signal);
          return;
        }
      })().catch((err) => {
        console.error(
          '⚠️ Error procesando mensaje Flintr:',
          err?.message || String(err),
        );
      });
    });

    ws.on('error', (err) => {
      console.error(
        '⚠️ Flintr WebSocket error:',
        err?.message || String(err),
      );
    });

    ws.on('close', (code, reason) => {
      console.log(
        `⚠️ Flintr WebSocket cerrado (code=${code}, reason=${
          reason?.toString?.() || ''
        })`,
      );
      console.log(`   Reintentando en ${reconnectDelay / 1000}s...`);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    });
  };

  connect();
}

/**
 * Punto de entrada público (lo llama worker.js)
 */
export async function startSniperEngine(redis) {
  initCore(redis);

  console.log('\n🎯 Pump.fun Sniper inicializado con Stagnation Exit');
  console.log(`   Modo: ${DRY_RUN ? '📄 PAPER' : '💰 LIVE'}`);
  console.log(`   Auto Trading: ${AUTO_TRADING ? 'ON' : 'OFF'}`);
  console.log(`   Tamaño posición: ${POSITION_SIZE_SOL} SOL`);
  console.log(`   Max posiciones: ${MAX_POSITIONS}`);
  console.log(
    `   Slots Flintr reservados: ${RESERVED_FLINTR_POSITIONS} / ${MAX_POSITIONS}`,
  );
  console.log(`   Min Liquidez (virtual): ${MIN_LIQUIDITY_SOL} SOL`);
  console.log(`   Min Bundle inicial: ${MIN_INITIAL_VOLUME_SOL} SOL`);
  console.log(
    `   Cooldown por token: ${MIN_TIME_BETWEEN_SAME_TOKEN} segundos`,
  );
  console.log(`   ONLY_KING_OF_HILL: ${ONLY_KING_OF_HILL ? 'ON' : 'OFF'}`);
  console.log(`   Risk loop: cada ${RISK_TICK_INTERVAL} ms`);
  console.log(`   💀 Stagnation: ${STAGNATION_TIME_SEC}s @ <${STAGNATION_PNL_THRESHOLD}%\n`);

  startFlintrWebSocket(redis);
  startRiskLoop(redis);
}
