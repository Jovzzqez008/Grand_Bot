// priceService.js - Pump.fun Bonding Curve Price Service (Sniper-friendly)
// - Lee la cuenta BondingCurve on-chain usando RPC público (no Helius)
// - Calcula precio en SOL por token a partir de virtual reserves
// - Soporta DRY_RUN para PnL y simulaciones

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const PUMP_PROGRAM_ID_STR =
  process.env.PUMP_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const PUMP_PROGRAM_ID = new PublicKey(PUMP_PROGRAM_ID_STR);

// Redis opcional (cache y graduación)
let redis = null;
if (REDIS_URL) {
  redis = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    retryDelayOnFailover: 100,
  });

  redis.on('error', (err) => {
    console.log('⚠️ Redis error in priceService:', err?.message ?? String(err));
  });
}

// Conexión única a Solana
const connection = new Connection(RPC_URL, 'confirmed');

// Cache en memoria para evitar spamear RPC
// key: mint → { value: PriceResult, expiresAt: number }
const priceCache = new Map();

// Asumimos 6 decimales para la mayoría de tokens de Pump.fun
const PUMP_TOKEN_DECIMALS = 6;

// TTL del cache de precios (ms)
const PRICE_CACHE_TTL_MS = 3000;

// ---- Tipos (doc) ----
//
// PriceResult:
// {
//   mint: string,
//   price: number,                 // SOL por token
//   virtualSolReserves: number,    // en SOL
//   virtualTokenReserves: number,  // en tokens (10^decimals)
//   realSolReserves: number,       // en SOL
//   realTokenReserves: number,     // en tokens
//   tokenTotalSupply: number,
//   graduated: boolean,
//   source: 'pumpfun_bonding_curve' | 'fallback_entry_price',
//   fetchedAt: number
// }
//
// ValueResult:
// {
//   mint: string,
//   tokens: number,
//   solValue: number,
//   marketPrice: number,
//   graduated: boolean,
//   source: string
// }

export class PriceService {
  constructor() {
    this.programId = PUMP_PROGRAM_ID;
    console.log(
      `💰 PriceService inicializado (RPC=${RPC_URL}, programId=${this.programId.toBase58()})`,
    );
  }

  /**
   * Devuelve un precio fresco o desde cache para un mint.
   * @param {string} mintStr
   * @param {boolean} forceFresh - si true, ignora cache en memoria
   * @returns {Promise<PriceResult | null>}
   */
  async getPrice(mintStr, forceFresh = false) {
    if (!mintStr) return null;

    const mint = new PublicKey(mintStr);

    // 1) Cache en memoria
    const cached = priceCache.get(mintStr);
    const now = Date.now();
    if (cached && !forceFresh && cached.expiresAt > now) {
      return cached.value;
    }

    try {
      // 2) Obtener estado del bonding curve on-chain
      const curveState = await this._fetchBondingCurveState(mint);
      if (!curveState) return null;

      const {
        virtualTokenReserves,
        virtualSolReserves,
        realTokenReserves,
        realSolReserves,
        tokenTotalSupply,
        complete,
      } = curveState;

      if (
        virtualTokenReserves <= 0n ||
        virtualSolReserves <= 0n ||
        tokenTotalSupply <= 0n
      ) {
        throw new Error('invalid_bonding_curve_state');
      }

      // 3) Calcular precio (SOL por token)
      const price = this._calculatePriceFromCurve(curveState);

      const result = {
        mint: mintStr,
        price,
        virtualSolReserves: Number(virtualSolReserves) / LAMPORTS_PER_SOL,
        virtualTokenReserves:
          Number(virtualTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS,
        realSolReserves: Number(realSolReserves) / LAMPORTS_PER_SOL,
        realTokenReserves:
          Number(realTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS,
        tokenTotalSupply:
          Number(tokenTotalSupply) / 10 ** PUMP_TOKEN_DECIMALS,
        graduated: complete,
        source: 'pumpfun_bonding_curve',
        fetchedAt: now,
      };

      // 4) Cache en memoria
      priceCache.set(mintStr, {
        value: result,
        expiresAt: now + PRICE_CACHE_TTL_MS,
      });

      // 5) Marcar graduación en Redis si aplica
      if (complete && redis) {
        await redis.setex(
          `pump:graduated:${mintStr}`,
          24 * 60 * 60, // 1 día
          '1',
        );
      }

      return result;
    } catch (error) {
      console.log(
        `⚠️ PriceService.getPrice error para mint ${mintStr}:`,
        error?.message ?? String(error),
      );
      return null;
    }
  }

  /**
   * Igual que getPrice pero con fallback a entryPrice guardado en Redis.
   * @param {string} mintStr
   * @returns {Promise<PriceResult | null>}
   */
  async getPriceWithFallback(mintStr) {
    const primary = await this.getPrice(mintStr, true);
    if (primary && primary.price && primary.price > 0) {
      return primary;
    }

    // Fallback: usar entryPrice de la posición en Redis
    if (!redis) return primary;

    try {
      const positionKey = `position:${mintStr}`;
      const entryPriceStr = await redis.hget(positionKey, 'entryPrice');
      if (!entryPriceStr) {
        return primary;
      }

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
      console.log(
        `⚠️ PriceService.getPriceWithFallback error para mint ${mintStr}:`,
        error?.message ?? String(error),
      );
      return primary;
    }
  }

  /**
   * Calcula el valor actual (en SOL) de una cantidad de tokens.
   * Usado por DRY_RUN sell / PnL.
   *
   * @param {string} mintStr
   * @param {number} tokenAmount
   * @returns {Promise<ValueResult | null>}
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

  // ----------------- Internals -----------------

  /**
   * Deriva el PDA del bonding curve y lee la cuenta on-chain.
   *
   * @param {PublicKey} mint
   */
  async _fetchBondingCurveState(mint) {
    // seeds = ["bonding-curve", mint]
    const [bondingCurvePda] = await PublicKey.findProgramAddress(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      this.programId,
    );

    const accountInfo = await connection.getAccountInfo(bondingCurvePda);
    if (!accountInfo || !accountInfo.data || accountInfo.data.length < 49) {
      throw new Error('bonding_curve_account_not_found_or_invalid');
    }

    const data = accountInfo.data;

    // Saltamos 8 bytes de discriminator Anchor
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
   * Calcula el precio (SOL por token) a partir de virtual reserves.
   *
   * @param {{virtualTokenReserves: bigint, virtualSolReserves: bigint}} curveState
   * @returns {number}
   */
  _calculatePriceFromCurve(curveState) {
    const { virtualTokenReserves, virtualSolReserves } = curveState;

    const solReserves = Number(virtualSolReserves) / LAMPORTS_PER_SOL;
    const tokenReserves =
      Number(virtualTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS;

    if (tokenReserves <= 0 || solReserves <= 0) {
      throw new Error('invalid_curve_reserves');
    }

    return solReserves / tokenReserves;
  }
}

// Singleton
let priceServiceInstance = null;

export function getPriceService() {
  if (!priceServiceInstance) {
    priceServiceInstance = new PriceService();
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

console.log('💰 PriceService module loaded (Pump.fun Bonding Curve)');
