// riskManager.js - Sistema de gestión de riesgo con PnL MEJORADO
import IORedis from 'ioredis';

export class RiskManager {
  constructor(config, redis) {
    this.redis = redis;
    this.maxPositionSize = parseFloat(config.maxPositionSize || '0.05');
    this.maxActivePositions = parseInt(config.maxActivePositions || '2');
    
    this.reservedFlintrPositions = parseInt(config.reservedFlintrPositions || '0');
    this.maxNormalPositions = this.maxActivePositions - this.reservedFlintrPositions;
    
    // Estos valores NO se usan en Copy Trading (usa copyStrategy.js)
    this.stopLossPercent = parseFloat(config.stopLoss || '3');
    this.takeProfitPercent = parseFloat(config.takeProfit || '6');
    this.minLiquiditySOL = parseFloat(config.minLiquidity || '8');
    this.minInitialVolumeSOL = parseFloat(config.minInitialVolume || '0.2');
    
    this.maxDailyLossSOL = parseFloat(config.maxDailyLossSOL || '1'); // Max pérdida diaria
    
    console.log('🔐 Risk Manager config:');
    console.log(`   Max position size: ${this.maxPositionSize} SOL`);
    console.log(`   Max active positions: ${this.maxActivePositions}`);
    console.log(`   Reserved Flintr positions: ${this.reservedFlintrPositions}`);
    console.log(`   Min Liquidity: ${this.minLiquiditySOL} SOL`);
    console.log(`   Min Initial Volume: ${this.minInitialVolumeSOL} SOL`);
    console.log(`   Max daily loss: ${this.maxDailyLossSOL} SOL`);
  }

  static fromEnv(redis) {
    const config = {
      maxPositionSize: process.env.POSITION_SIZE_SOL,
      maxActivePositions: process.env.MAX_POSITIONS,
      reservedFlintrPositions: process.env.RESERVED_FLINTR_POSITIONS,
      stopLoss: process.env.STOP_LOSS_PERCENT,
      takeProfit: process.env.TAKE_PROFIT_PERCENT,
      minLiquidity: process.env.MIN_LIQUIDITY_SOL,
      minInitialVolume: process.env.MIN_INITIAL_VOLUME_SOL,
      maxDailyLossSOL: process.env.MAX_DAILY_LOSS_SOL
    };

    return new RiskManager(config, redis);
  }

  async getOpenPositionsCount() {
    try {
      const mints = await this.redis.smembers('open_positions');
      return mints.length;
    } catch (error) {
      console.error('❌ Error getting open positions count:', error.message);
      return 0;
    }
  }

  async getOpenPositionsDetails() {
    try {
      const mints = await this.redis.smembers('open_positions');
      const positions = [];

      for (const mint of mints) {
        const position = await this.redis.hgetall(`position:${mint}`);
        if (position && position.status === 'open') {
          positions.push({ mint, ...position });
        }
      }

      return positions;
    } catch (error) {
      console.error('❌ Error getting open positions details:', error.message);
      return [];
    }
  }

  async getOpenPositionsByStrategy(strategy) {
    try {
      const positions = await this.getOpenPositionsDetails();
      return positions.filter(
        p =>
          p.entry_strategy === strategy ||
          p.strategy === strategy ||
          p.source === strategy
      );
    } catch (error) {
      console.error('❌ Error filtering positions by strategy:', error.message);
      return [];
    }
  }

  async getPositionsSummary() {
    try {
      const positions = await this.getOpenPositionsDetails();

      let totalSol = 0;
      let flintrPositions = 0;
      let normalPositions = 0;
      let flintrSol = 0;
      let normalSol = 0;

      for (const pos of positions) {
        const solAmount = parseFloat(pos.solAmount || '0');
        const isFlintr =
          pos.entry_strategy === 'flintr' ||
          pos.strategy === 'flintr' ||
          pos.source === 'flintr';

        totalSol += solAmount;
        if (isFlintr) {
          flintrPositions++;
          flintrSol += solAmount;
        } else {
          normalPositions++;
          normalSol += solAmount;
        }
      }

      return {
        totalPositions: positions.length,
        totalSol,
        flintrPositions,
        flintrSol,
        normalPositions,
        normalSol
      };
    } catch (error) {
      console.error('❌ Error getting positions summary:', error.message);
      return null;
    }
  }

  async shouldEnterTrade(mint, price, signals = {}) {
    try {
      const isFlintrToken =
        signals.source === 'flintr' ||
        signals.entry_strategy === 'flintr' ||
        signals.strategy === 'flintr';

      const [totalPositions, flintrPositions, normalPositions] =
        await Promise.all([
          this.getOpenPositionsCount(),
          this.getOpenPositionsByStrategy('flintr').then(p => p.length),
          this.getOpenPositionsByStrategy('normal').then(p => p.length)
        ]);

      const positions = {
        total: totalPositions,
        flintr: flintrPositions,
        normal: normalPositions
      };

      console.log('📊 Current positions:');
      console.log(`   Total: ${positions.total}/${this.maxActivePositions}`);
      console.log(
        `   Flintr: ${positions.flintr}/${this.reservedFlintrPositions}`
      );
      console.log(`   Normal: ${positions.normal}/${this.maxNormalPositions}`);

      if (isFlintrToken) {
        if (positions.flintr >= this.reservedFlintrPositions) {
          console.log(
            `🚫 Flintr slots full: ${positions.flintr}/${this.reservedFlintrPositions}`,
          );
          return { allowed: false, reason: 'flintr_slots_full' };
        }
      } else {
        if (positions.normal >= this.maxNormalPositions) {
          console.log(
            `🚫 Normal slots full: ${positions.normal}/${this.maxNormalPositions}`,
          );
          return { allowed: false, reason: 'normal_slots_full' };
        }
      }

      if (positions.total >= this.maxActivePositions) {
        console.log(
          `⚠️ Total max positions reached: ${positions.total}/${this.maxActivePositions}`,
        );
        return { allowed: false, reason: 'max_total_positions' };
      }

      const dailyPnL = await this.getDailyPnL();
      if (dailyPnL < -this.maxDailyLossSOL) {
        console.log(
          `🚫 Daily loss limit reached: ${dailyPnL.toFixed(4)} SOL`,
        );
        return { allowed: false, reason: 'daily_loss_limit' };
      }

      if (
        signals.virtualSolReserves &&
        signals.virtualSolReserves < this.minLiquiditySOL
      ) {
        console.log(
          `⚠️ Low liquidity: ${signals.virtualSolReserves.toFixed(2)} SOL`,
        );
        return { allowed: false, reason: 'low_liquidity' };
      }

      if (!price || price <= 0 || price > 1) {
        console.log(`⚠️ Invalid price: ${price}`);
        return { allowed: false, reason: 'invalid_price' };
      }

      return {
        allowed: true,
        size: this.maxPositionSize,
        stopLoss: price * (1 - this.stopLossPercent / 100),
        takeProfit: price * (1 + this.takeProfitPercent / 100),
        slotType: isFlintrToken ? 'flintr' : 'normal',
      };
    } catch (error) {
      console.error('❌ Error in shouldEnterTrade:', error.message);
      return { allowed: false, reason: 'error' };
    }
  }

  // ✅ PnL DIARIO
  async getDailyPnL() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const trades = await this.redis.lrange(`trades:${today}`, 0, -1);

      let totalPnL = 0;
      for (const tradeJson of trades) {
        const trade = JSON.parse(tradeJson);
        if (trade.pnlSOL) {
          totalPnL += parseFloat(trade.pnlSOL);
        }
      }

      return totalPnL;
    } catch (error) {
      console.error('❌ Error calculating daily PnL:', error.message);
      return 0;
    }
  }

  async getDailyStats() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const trades = await this.redis.lrange(`trades:${today}`, 0, -1);

      let wins = 0,
        losses = 0,
        totalPnL = 0;
      let flintrWins = 0,
        flintrTrades = 0;
      let normalWins = 0,
        normalTrades = 0;
      const pnls = [];

      for (const tradeJson of trades) {
        const trade = JSON.parse(tradeJson);
        const isFlintr = trade.entry_strategy === 'flintr';

        if (trade.pnlSOL) {
          const pnl = parseFloat(trade.pnlSOL);
          pnls.push(pnl);
          totalPnL += pnl;

          if (pnl > 0) {
            wins++;
            if (isFlintr) flintrWins++;
            else normalWins++;
          } else if (pnl < 0) {
            losses++;
          }

          if (isFlintr) flintrTrades++;
          else normalTrades++;
        }
      }

      const totalTrades = wins + losses;
      const winRate =
        totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(2) : '0.00';

      const avgPnL = pnls.length
        ? (totalPnL / pnls.length).toFixed(6)
        : '0.000000';

      const biggestWin = pnls.length
        ? Math.max(...pnls).toFixed(6)
        : '0.000000';
      const biggestLoss = pnls.length
        ? Math.min(...pnls).toFixed(6)
        : '0.000000';

      const flintrWinRate =
        flintrTrades > 0
          ? ((flintrWins / flintrTrades) * 100).toFixed(2)
          : '0.00';

      const normalWinRate =
        normalTrades > 0
          ? ((normalWins / normalTrades) * 100).toFixed(2)
          : '0.00';

      return {
        totalTrades,
        wins,
        losses,
        winRate: `${winRate}%`,
        totalPnL: totalPnL.toFixed(6),
        avgPnL,
        biggestWin,
        biggestLoss,
        flintr: {
          trades: flintrTrades,
          winRate: `${flintrWinRate}%`,
        },
        normal: {
          trades: normalTrades,
          winRate: `${normalWinRate}%`,
        },
      };
    } catch (error) {
      console.error('❌ Error getting daily stats:', error.message);
      return null;
    }
  }
}

export class PositionManager {
  constructor(redis) {
    this.redis = redis;
  }

  async openPosition(
    mint,
    symbol,
    entryPrice,
    solAmount,
    tokensReceived,
    signature,
  ) {
    try {
      const position = {
        mint,
        symbol,
        entryPrice: entryPrice.toString(),
        entryTime: Date.now().toString(),
        solAmount: solAmount.toString(),
        tokensAmount: tokensReceived.toString(),
        status: 'open',
        maxPrice: entryPrice.toString(),
        signature,
        entry_strategy: 'flintr',
        strategy: 'flintr',
      };

      await this.redis.hmset(`position:${mint}`, position);
      await this.redis.sadd('open_positions', mint);
      await this.redis.expire(`position:${mint}`, 3600);

      console.log(`✅ Position opened: ${symbol} @ $${entryPrice.toFixed(10)}`);
      return position;
    } catch (error) {
      console.error('❌ Error opening position:', error.message);
      throw error;
    }
  }

  async updateMaxPrice(mint, newPrice) {
    try {
      const position = await this.redis.hgetall(`position:${mint}`);
      if (!position || !position.maxPrice) return;

      const currentMax = parseFloat(position.maxPrice);
      if (newPrice > currentMax) {
        await this.redis.hset(`position:${mint}`, 'maxPrice', newPrice.toString());
        console.log(`📈 ${position.symbol} new max: $${newPrice.toFixed(10)}`);
      }
    } catch (error) {
      console.error('❌ Error updating max price:', error.message);
    }
  }

  async closePosition(
    mint,
    exitPrice,
    tokensAmount,
    solReceived,
    reason,
    signature,
  ) {
    try {
      const position = await this.redis.hgetall(`position:${mint}`);
      if (!position || !position.entryPrice) {
        console.error(`⚠️ Position not found: ${mint.slice(0, 8)}`);
        return null;
      }

      const entryPrice = parseFloat(position.entryPrice);
      const solSpent = parseFloat(position.solAmount);

      // ✅ MÉTODO 1: PnL en SOL (más preciso para paper trading)
      const pnlSOL = solReceived - solSpent;

      // ✅ MÉTODO 2: PnL porcentual basado en precios
      const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;

      // ✅ MÉTODO 3: PnL porcentual basado en valor en SOL
      const finalPnLPercent =
        solSpent > 0 ? ((solReceived - solSpent) / solSpent) * 100 : pnlPercent;

      const updatedPosition = {
        ...position,
        status: 'closed',
        exitPrice: exitPrice.toString(),
        exitTime: Date.now().toString(),
        solReceived: solReceived.toString(),
        pnlSOL: pnlSOL.toString(),
        pnlPercent: finalPnLPercent,
        pnlPercentPrice: pnlPercent,
        reason,
        closeSignature: signature,
      };

      await this.redis.hmset(`position:${mint}`, updatedPosition);
      await this.redis.srem('open_positions', mint);

      // Guardar trade en lista diaria
      const today = new Date().toISOString().split('T')[0];
      await this.redis.rpush(
        `trades:${today}`,
        JSON.stringify({
          ...updatedPosition,
          mint,
        }),
      );

      console.log(
        `✅ Position closed: ${position.symbol} @ $${exitPrice.toFixed(10)} | PnL: ${pnlSOL.toFixed(6)} SOL (${finalPnLPercent.toFixed(2)}%)`,
      );

      return updatedPosition;
    } catch (error) {
      console.error('❌ Error closing position:', error.message);
      throw error;
    }
  }

  async getOpenPositions() {
    try {
      const mints = await this.redis.smembers('open_positions');
      const positions = [];

      for (const mint of mints) {
        const position = await this.redis.hgetall(`position:${mint}`);
        if (position && position.status === 'open') {
          positions.push({ mint, ...position });
        }
      }

      return positions;
    } catch (error) {
      console.error('❌ Error getting open positions:', error.message);
      return [];
    }
  }

  // ✅ Comparar múltiples métodos de PnL (debug / análisis)
  async comparePnLMethods(mint, currentPrice) {
    try {
      const position = await this.redis.hgetall(`position:${mint}`);
      if (!position || !position.entryPrice) {
        return null;
      }

      const entryPrice = parseFloat(position.entryPrice);
      const solSpent = parseFloat(position.solAmount);
      const tokensAmount = parseFloat(position.tokensAmount);

      const method1 = solSpent > 0
        ? ((currentPrice - entryPrice) / entryPrice) * 100
        : 0;

      const currentSolValue = tokensAmount * currentPrice;
      const method2 = solSpent > 0
        ? ((currentSolValue - solSpent) / solSpent) * 100
        : 0;

      const method3 = solSpent > 0
        ? ((currentSolValue - solSpent) / solSpent) * 100
        : 0;

      return {
        method1,
        method2,
        method3,
        recommended: method2, // Método 2 es el más preciso
      };
    } catch (error) {
      console.error('❌ Error comparing PnL methods:', error.message);
      return null;
    }
  }
}
