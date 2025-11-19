// priceService.js - MEJORADO con retry, cache inteligente y fallbacks
// ✅ Retry automático en fallos de RPC
// ✅ Cache multi-nivel (memoria + Redis)
// ✅ Fallback a múltiples fuentes
// ✅ Detección de precios anómalos

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const RPC_FALLBACK_URL = process.env.RPC_FALLBACK_URL; // Opcional
const PUMP_PROGRAM_ID_STR = process.env.PUMP_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const PUMP_PROGRAM_ID = new PublicKey(PUMP_PROGRAM_ID_STR);
const PUMP_TOKEN_DECIMALS = 6;

// Cache TTL
const PRICE_CACHE_TTL_MS = 3000; // 3s en memoria
const REDIS_CACHE_TTL_SEC = 10; // 10s en Redis

// Retry config
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

// Redis
let redis = null;
if (REDIS_URL) {
  redis = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    retryDelayOnFailover: 100,
  });
  redis.on('error', (err) => {
    console.log('⚠️ Redis error (priceService):', err?.message);
  });
}

// Conexión principal y fallback
const connection = new Connection(RPC_URL, 'confirmed');
let fallbackConnection = null;
if (RPC_FALLBACK_URL) {
  fallbackConnection = new Connection(RPC_FALLBACK_URL, 'confirmed');
}

// Cache en memoria
const priceCache = new Map();

// Stats
let cacheHits = 0;
let cacheMisses = 0;
let rpcErrors = 0;

export class PriceService {
  constructor() {
    this.programId = PUMP_PROGRAM_ID;
    console.log(`💰 PriceService MEJORADO inicializado`);
    console.log(`   RPC: ${RPC_URL}`);
    console.log(`   Fallback: ${RPC_FALLBACK_URL || 'None'}`);
    console.log(`   Program: ${this.programId.toBase58()}`);
  }

  /**
   * Obtener precio con cache multi-nivel
   */
  async getPrice(mintStr, forceFresh = false) {
    if (!mintStr) return null;

    const mint = new PublicKey(mintStr);
    const now = Date.now();

    // 1. Cache en memoria (más rápido)
    if (!forceFresh) {
      const cached = priceCache.get(mintStr);
      if (cached && cached.expiresAt > now) {
        cacheHits++;
        if (process.env.VERBOSE_LOGGING === 'true') {
          console.log(`   💾 Cache hit (memoria): ${mintStr.slice(0, 8)}`);
        }
        return cached.value;
      }
    }

    // 2. Cache en Redis (medio)
    if (!forceFresh && redis) {
      try {
        const redisKey = `price:${mintStr}`;
        const cached = await redis.get(redisKey);
        
        if (cached) {
          cacheHits++;
          const data = JSON.parse(cached);
          
          // Guardar en memoria también
          priceCache.set(mintStr, {
            value: data,
            expiresAt: now + PRICE_CACHE_TTL_MS
          });
          
          if (process.env.VERBOSE_LOGGING === 'true') {
            console.log(`   💾 Cache hit (Redis): ${mintStr.slice(0, 8)}`);
          }
          return data;
        }
      } catch (e) {
        // Silencioso, continuar con RPC
      }
    }

    cacheMisses++;

    // 3. Fetch desde RPC con retry
    try {
      const curveState = await this._fetchBondingCurveStateWithRetry(mint);
      
      if (!curveState) return null;

      const {
        virtualTokenReserves,
        virtualSolReserves,
        realTokenReserves,
        realSolReserves,
        tokenTotalSupply,
        complete,
      } = curveState;

      // Validar datos
      if (virtualTokenReserves <= 0n || virtualSolReserves <= 0n || tokenTotalSupply <= 0n) {
        throw new Error('invalid_curve_state');
      }

      // Calcular precio
      const price = this._calculatePriceFromCurve(curveState);

      // Detectar precios anómalos
      if (!this._isPriceReasonable(price, curveState)) {
        console.log(`⚠️ Precio anómalo detectado para ${mintStr.slice(0, 8)}: ${price}`);
      }

      const result = {
        mint: mintStr,
        price,
        virtualSolReserves: Number(virtualSolReserves) / LAMPORTS_PER_SOL,
        virtualTokenReserves: Number(virtualTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS,
        realSolReserves: Number(realSolReserves) / LAMPORTS_PER_SOL,
        realTokenReserves: Number(realTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS,
        tokenTotalSupply: Number(tokenTotalSupply) / 10 ** PUMP_TOKEN_DECIMALS,
        graduated: complete,
        source: 'pumpfun_bonding_curve',
        fetchedAt: now,
      };

      // 4. Guardar en cache (memoria + Redis)
      priceCache.set(mintStr, {
        value: result,
        expiresAt: now + PRICE_CACHE_TTL_MS
      });

      if (redis) {
        try {
          await redis.setex(
            `price:${mintStr}`,
            REDIS_CACHE_TTL_SEC,
            JSON.stringify(result)
          );
        } catch (e) {
          // No crítico
        }
      }

      // 5. Marcar graduación
      if (complete && redis) {
        await redis.setex(`pump:graduated:${mintStr}`, 24 * 60 * 60, '1');
      }

      return result;

    } catch (error) {
      rpcErrors++;
      console.log(`⚠️ getPrice error para ${mintStr.slice(0, 8)}:`, error?.message);
      return null;
    }
  }

  /**
   * Fetch con retry automático
   */
  async _fetchBondingCurveStateWithRetry(mint, retries = MAX_RETRIES) {
    let lastError = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // Intentar con conexión principal
        const result = await this._fetchBondingCurveState(mint, connection);
        return result;
        
      } catch (error) {
        lastError = error;
        
        // Si hay fallback y es el último intento, intentar con fallback
        if (fallbackConnection && attempt === retries - 1) {
          try {
            console.log(`   🔄 Intentando RPC fallback...`);
            return await this._fetchBondingCurveState(mint, fallbackConnection);
          } catch (fallbackError) {
            lastError = fallbackError;
          }
        }

        // Esperar antes del siguiente retry
        if (attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
        }
      }
    }

    throw lastError;
  }

  /**
   * Fetch cuenta bonding curve
   */
  async _fetchBondingCurveState(mint, conn = connection) {
    const [bondingCurvePda] = await PublicKey.findProgramAddress(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      this.programId
    );

    const accountInfo = await conn.getAccountInfo(bondingCurvePda);
    
    if (!accountInfo || !accountInfo.data || accountInfo.data.length < 49) {
      throw new Error('bonding_curve_not_found');
    }

    const data = accountInfo.data;

    const virtualTokenReserves = data.readBigUInt64LE(8);
    const virtualSolReserves = data.readBigUInt64LE(16);
    const realTokenReserves = data.readBigUInt64LE(24);
    const realSolReserves = data.readBigUInt64LE(32);
    const tokenTotalSupply = data.readBigUInt64LE(40);
    const complete = data.readUInt8(48) === 1;

    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
    };
  }

  /**
   * Calcular precio desde curve
   */
  _calculatePriceFromCurve(curveState) {
    const { virtualTokenReserves, virtualSolReserves } = curveState;

    const solReserves = Number(virtualSolReserves) / LAMPORTS_PER_SOL;
    const tokenReserves = Number(virtualTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS;

    if (tokenReserves <= 0 || solReserves <= 0) {
      throw new Error('invalid_reserves');
    }

    return solReserves / tokenReserves;
  }

  /**
   * Validar que el precio sea razonable
   */
  _isPriceReasonable(price, curveState) {
    // Precio demasiado bajo (< 0.000000001)
    if (price < 1e-9) return false;

    // Precio demasiado alto (> 1 SOL por token)
    if (price > 1) return false;

    // Liquidez sospechosamente baja
    const liquidity = Number(curveState.virtualSolReserves) / LAMPORTS_PER_SOL;
    if (liquidity < 0.1) return false;

    return true;
  }

  /**
   * Precio con fallback a entryPrice
   */
  async getPriceWithFallback(mintStr) {
    const primary = await this.getPrice(mintStr, true);
    
    if (primary && primary.price && primary.price > 0) {
      return primary;
    }

    // Fallback a entryPrice de Redis
    if (!redis) return primary;

    try {
      const positionKey = `position:${mintStr}`;
      const entryPriceStr = await redis.hget(positionKey, 'entryPrice');
      
      if (!entryPriceStr) return primary;

      const entryPrice = Number(entryPriceStr);
      
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        return primary;
      }

      return {
        mint: mintStr,
        price: entryPrice,
        virtualSolReserves: primary?.virtualSolReserves ?? 0,
        virtualTokenReserves: primary?.virtualTokenReserves ?? 0,
        realSolReserves: primary?.realSolReserves ?? 0,
        realTokenReserves: primary?.realTokenReserves ?? 0,
        tokenTotalSupply: primary?.tokenTotalSupply ?? 0,
        graduated: primary?.graduated ?? false,
        source: 'fallback_entry_price',
        fetchedAt: Date.now(),
      };
    } catch (error) {
      return primary;
    }
  }

  /**
   * Calcular valor actual de tokens
   */
  async calculateCurrentValue(mintStr, tokenAmount) {
    if (!mintStr || !tokenAmount || tokenAmount <= 0) {
      return null;
    }

    const priceData = await this.getPriceWithFallback(mintStr);
    
    if (!priceData || !priceData.price || priceData.price <= 0) {
      return null;
    }

    const solValue = tokenAmount * priceData.price;

    return {
      mint: mintStr,
      tokens: tokenAmount,
      solValue,
      marketPrice: priceData.price,
      graduated: !!priceData.graduated,
      source: priceData.source || 'pumpfun_bonding_curve',
    };
  }

  /**
   * Obtener stats del cache
   */
  getCacheStats() {
    const total = cacheHits + cacheMisses;
    const hitRate = total > 0 ? ((cacheHits / total) * 100).toFixed(2) : '0.00';

    return {
      hits: cacheHits,
      misses: cacheMisses,
      hitRate: `${hitRate}%`,
      rpcErrors,
      cacheSize: priceCache.size
    };
  }

  /**
   * Limpiar cache viejo
   */
  cleanOldCache() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of priceCache.entries()) {
      if (value.expiresAt < now) {
        priceCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 Cache limpiado: ${cleaned} entradas`);
    }
  }
}

// Singleton
let priceServiceInstance = null;

export function getPriceService() {
  if (!priceServiceInstance) {
    priceServiceInstance = new PriceService();
    
    // Limpiar cache cada 5 minutos
    setInterval(() => {
      priceServiceInstance.cleanOldCache();
    }, 5 * 60 * 1000);
  }
  return priceServiceInstance;
}

// Helpers de compatibilidad
export async function getPriceFromBondingCurve(mint, forceFresh = false) {
  const ps = getPriceService();
  return await ps.getPrice(mint, forceFresh);
}

export async function getPriceWithFallback(mint) {
  const ps = getPriceService();
  return await ps.getPriceWithFallback(mint);
}

console.log('💰 PriceService MEJORADO loaded');
