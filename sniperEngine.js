// sniperEngine.js - Flintr-based Pump.fun Sniper Core (DRY_RUN + PnL correcto)

import WebSocket from 'ws';
import { getPriceService } from './priceService.js';
import { RiskManager, PositionManager } from './riskManager.js';
import { TradeExecutor } from './tradeExecutor.js';
import { sendTelegramAlert } from './telegram.js';

const FLINTR_API_KEY = process.env.FLINTR_API_KEY;

// DRY_RUN: por defecto PAPER salvo que pongas DRY_RUN="false"
const DRY_RUN =
  (process.env.DRY_RUN || '').trim().toLowerCase() !== 'false';

// Trading automático
const AUTO_TRADING =
  (process.env.ENABLE_AUTO_TRADING || '').trim().toLowerCase() === 'true';

// Tamaños / slots
const POSITION_SIZE_SOL = parseFloat(process.env.POSITION_SIZE_SOL || '0.05');
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '2', 10);

// Liquidez mínima sobre bonding curve (virtualSolReserves)
const MIN_LIQUIDITY_SOL = parseFloat(process.env.MIN_LIQUIDITY_SOL || '2');

// Volumen inicial mínimo (bundleAmount de Flintr) en SOL
const MIN_INITIAL_VOLUME_SOL = parseFloat(process.env.MIN_INITIAL_VOLUME_SOL || '0');

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
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_ALERT_ON_ENTRY =
  (process.env.TELEGRAM_ALERT_ON_ENTRY || '').trim().toLowerCase() === 'true';

// Logging detallado
const VERBOSE_LOGGING =
  (process.env.VERBOSE_LOGGING || '').trim().toLowerCase() === 'true';

// Intervalo del loop de riesgo (ms)
const RISK_TICK_INTERVAL = parseInt(process.env.RISK_TICK_INTERVAL || '5000', 10);

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
      maxDailyLoss: process.env.MAX_DAILY_LOSS_SOL || '0.5',
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
    console.error('⚠️ Error handling Flintr graduation:', error.message);
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
      if ( VERBOSE_LOGGING ) {
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
      `   🛒 Ejecutando BUY ${DRY_RUN ? '[PAPER]' : '[LIVE]'}: ${
        solSize
      } SOL en ${symbol} (${mint.slice(0, 8)})`,
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
      buyResult.entryPrice ||
      entryPrice ||
      solSpent / tokensReceived ||
      0;

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
      console.error('⚠️ No se pudo marcar entry_strategy=flintr:', e.message);
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
    console.error('❌ Error en handleMintEvent:', error.message);
  }
}

/**
 * Loop de riesgo sencillo:
 * - Usa getDailyPnL() para respetar maxDailyLossSOL
 * - Más adelante se puede extender para auto-sell
 */
function startRiskLoop(redis) {
  if (!RISK_TICK_INTERVAL || RISK_TICK_INTERVAL <= 0) return;

  setInterval(async () => {
    try {
      const dailyPnL = await riskManager.getDailyPnL();
      if (VERBOSE_LOGGING) {
        console.log(`📊 Daily PnL (Risk Loop): ${dailyPnL.toFixed(4)} SOL`);
      }

      await redis.set('sniper:last_risk_tick', Date.now().toString());
    } catch (error) {
      console.error('⚠️ Error en risk loop:', error.message);
    }
  }, RISK_TICK_INTERVAL);
}

/**
 * WebSocket de Flintr + reconexión
 */
function startFlintrWebSocket(redis) {
  if (!FLINTR_API_KEY) {
    console.log('❌ FLINTR_API_KEY no configurada - Sniper deshabilitado');
    return;
  }

  let ws = null;
  let reconnectDelay = 5000;

  const connect = () => {
    const url = `wss://api-v1.flintr.io/?token=${FLINTR_API_KEY}`;
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
        console.error('⚠️ Error procesando mensaje Flintr:', err.message);
      });
    });

    ws.on('error', (err) => {
      console.error('⚠️ Flintr WebSocket error:', err.message);
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

  console.log('\n🎯 Pump.fun Sniper inicializado');
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
  console.log(`   Risk loop: cada ${RISK_TICK_INTERVAL} ms\n`);

  startFlintrWebSocket(redis);
  startRiskLoop(redis);
}
