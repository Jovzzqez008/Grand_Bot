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
    this.maxDailyLossSOL = parseFloat(config.maxDailyLoss || '0.3');
    
    if (config.enableRiskManagerLogs) {
      console.log(`🛡️ Risk Manager initialized:`);
      console.log(`   Max Position: ${this.maxPositionSize} SOL`);
      console.log(`   Total Positions: ${this.maxActivePositions}`);
      console.log(`   Stop Loss: -${this.stopLossPercent}%`);
      console.log(`   Take Profit: +${this.takeProfitPercent}%`);
    }
  }

  async getPositionsByType() {
    try {
      const openPositions = await this.redis.smembers('open_positions');
      
      let flintrPositions = 0;
      let normalPositions = 0;
      
      for (const mint of openPositions) {
        const position = await this.redis.hgetall(`position:${mint}`);
        
        if (position && position.entry_strategy === 'flintr') {
          flintrPositions++;
        } else {
          normalPositions++;
        }
      }
      
      return {
        total: openPositions.length,
        flintr: flintrPositions,
        normal: normalPositions,
        flintrAvailable: this.reservedFlintrPositions - flintrPositions,
        normalAvailable: this.maxNormalPositions - normalPositions
      };
    } catch (error) {
      console.error('Error getting positions by type:', error.message);
      return {
        total: 0,
        flintr: 0,
        normal: 0,
        flintrAvailable: this.reservedFlintrPositions,
        normalAvailable: this.maxNormalPositions
      };
    }
  }

  async shouldEnterTrade(mint, price, signals = {}) {
    try {
      const isFlintrToken = signals.source === 'flintr';
      const positions = await this.getPositionsByType();
      
      const openPositionsList = await this.redis.smembers('open_positions');
      if (openPositionsList.includes(mint)) {
        console.log(`⚠️ Already have position in ${mint.slice(0, 8)}`);
        return { allowed: false, reason: 'duplicate_position' };
      }
      
      if (isFlintrToken) {
        if (positions.flintrAvailable <= 0) {
          console.log(`🎯 Flintr slots full (${positions.flintr}/${this.reservedFlintrPositions})`);
          return { allowed: false, reason: 'flintr_slots_full' };
        }
        console.log(`🎯 Flintr slot available (${positions.flintr + 1}/${this.reservedFlintrPositions})`);
      } else {
        if (positions.normalAvailable <= 0) {
          console.log(`⚡ Normal slots full (${positions.normal}/${this.maxNormalPositions})`);
          return { allowed: false, reason: 'normal_slots_full' };
        }
        console.log(`⚡ Normal slot available (${positions.normal + 1}/${this.maxNormalPositions})`);
      }
      
      if (positions.total >= this.maxActivePositions) {
        console.log(`⚠️ Total max positions reached: ${positions.total}/${this.maxActivePositions}`);
        return { allowed: false, reason: 'max_total_positions' };
      }
      
      const dailyPnL = await this.getDailyPnL();
      if (dailyPnL < -this.maxDailyLossSOL) {
        console.log(`🚫 Daily loss limit reached: ${dailyPnL.toFixed(4)} SOL`);
        return { allowed: false, reason: 'daily_loss_limit' };
      }
      
      if (signals.virtualSolReserves && signals.virtualSolReserves < this.minLiquiditySOL) {
        console.log(`⚠️ Low liquidity: ${signals.virtualSolReserves.toFixed(2)} SOL`);
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
        slotType: isFlintrToken ? 'flintr' : 'normal'
      };
      
    } catch (error) {
      console.error('❌ Risk check error:', error.message);
      return { allowed: false, reason: 'error' };
    }
  }

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
      
      let wins = 0, losses = 0, totalPnL = 0;
      let flintrWins = 0, flintrTrades = 0;
      let normalWins = 0, normalTrades = 0;
      const pnls = [];
      
      for (const tradeJson of trades) {
        const trade = JSON.parse(tradeJson);
        const isFlintr = trade.entry_strategy === 'flintr';
        
        if (trade.pnlSOL) {
          const pnl = parseFloat(trade.pnlSOL);
          totalPnL += pnl;
          pnls.push(pnl);
          
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
      
      const winRate = trades.length > 0 ? (wins / trades.length * 100).toFixed(1) : '0';
      const flintrWinRate = flintrTrades > 0 ? (flintrWins / flintrTrades * 100).toFixed(1) : '0';
      const normalWinRate = normalTrades > 0 ? (normalWins / normalTrades * 100).toFixed(1) : '0';
      
      return {
        totalTrades: trades.length,
        wins,
        losses,
        winRate: `${winRate}%`,
        totalPnL: totalPnL.toFixed(4),
        avgPnL: trades.length > 0 ? (totalPnL / trades.length).toFixed(4) : '0',
        biggestWin: pnls.length > 0 ? Math.max(...pnls).toFixed(4) : '0',
        biggestLoss: pnls.length > 0 ? Math.min(...pnls).toFixed(4) : '0',
        flintr: {
          trades: flintrTrades,
          winRate: `${flintrWinRate}%`
        },
        normal: {
          trades: normalTrades,
          winRate: `${normalWinRate}%`
        }
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

  async openPosition(mint, symbol, entryPrice, solAmount, tokensReceived, signature) {
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
        signature
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

  // ✅ CÁLCULO DE PnL MEJORADO
  async closePosition(mint, exitPrice, tokensAmount, solReceived, reason, signature) {
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
      
      // ✅ MÉTODO 2: PnL en porcentaje basado en precio
      const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;
      
      // ✅ MÉTODO 3: PnL en porcentaje basado en SOL (más realista)
      const pnlPercentSOL = (pnlSOL / solSpent) * 100;
      
      // Determinar cuál usar (preferir el basado en SOL para paper trading)
      const finalPnLPercent = pnlPercentSOL;
      
      await this.redis.hmset(`position:${mint}`, {
        status: 'closed',
        exitPrice: exitPrice.toString(),
        exitTime: Date.now().toString(),
        pnlSOL: pnlSOL.toString(),
        pnlPercent: finalPnLPercent.toString(),
        pnlPercentPrice: pnlPercent.toString(), // Guardar ambos para comparación
        reason,
        exitSignature: signature
      });
      
      await this.redis.srem('open_positions', mint);
      await this.redis.persist(`position:${mint}`);
      
      const today = new Date().toISOString().split('T')[0];
      const tradeRecord = {
        ...position,
        exitPrice,
        pnlSOL,
        pnlPercent: finalPnLPercent,
        pnlPercentPrice: pnlPercent,
        reason,
        closedAt: Date.now()
      };
      
      await this.redis.rpush(`trades:${today}`, JSON.stringify(tradeRecord));
      await this.redis.expire(`trades:${today}`, 86400 * 30);
      
      const emoji = pnlSOL >= 0 ? '✅' : '❌';
      const stratEmoji = position.entry_strategy === 'flintr' ? '🎯' : '⚡';
      
      console.log(`${emoji} Position closed: ${position.symbol} [${stratEmoji}]`);
      console.log(`   Entry: $${entryPrice.toFixed(10)} | Exit: $${exitPrice.toFixed(10)}`);
      console.log(`   💰 SOL: ${solSpent.toFixed(4)} → ${solReceived.toFixed(4)}`);
      console.log(`   📊 PnL: ${pnlSOL >= 0 ? '+' : ''}${pnlSOL.toFixed(4)} SOL (${finalPnLPercent >= 0 ? '+' : ''}${finalPnLPercent.toFixed(2)}%)`);
      console.log(`   📈 Price Change: ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`);
      console.log(`   🏷️ Reason: ${reason}`);
      
      // ✅ VALIDACIÓN: Alertar si hay discrepancia grande
      const discrepancy = Math.abs(pnlPercent - finalPnLPercent);
      if (discrepancy > 5) {
        console.log(`   ⚠️ Warning: Large discrepancy detected!`);
        console.log(`      Price-based PnL: ${pnlPercent.toFixed(2)}%`);
        console.log(`      SOL-based PnL: ${finalPnLPercent.toFixed(2)}%`);
        console.log(`      This might indicate simulation accuracy issues`);
      }
      
      return {
        ...position,
        pnlSOL,
        pnlPercent: finalPnLPercent,
        pnlPercentPrice: pnlPercent,
        reason
      };
      
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

  // ✅ NUEVO: Calcular PnL actual de posición abierta
  async calculateCurrentPnL(mint, currentPrice) {
    try {
      const position = await this.redis.hgetall(`position:${mint}`);
      if (!position || !position.entryPrice) {
        return null;
      }

      const entryPrice = parseFloat(position.entryPrice);
      const solSpent = parseFloat(position.solAmount);
      const tokensAmount = parseFloat(position.tokensAmount);

      // Calcular SOL que recibirías ahora (considerando fees)
      const FEE_PERCENT = 0.01; // 1% Pump.fun
      const solBeforeFee = tokensAmount * currentPrice;
      const solAfterFee = solBeforeFee * (1 - FEE_PERCENT);

      // PnL real en SOL
      const pnlSOL = solAfterFee - solSpent;
      const pnlPercent = (pnlSOL / solSpent) * 100;

      // PnL basado en precio (referencia)
      const pnlPercentPrice = ((currentPrice - entryPrice) / entryPrice) * 100;

      return {
        currentPrice,
        entryPrice,
        solSpent,
        solCurrent: solAfterFee,
        pnlSOL,
        pnlPercent,
        pnlPercentPrice,
        tokensAmount,
        holdTime: Date.now() - parseInt(position.entryTime)
      };

    } catch (error) {
      console.error('❌ Error calculating current PnL:', error.message);
      return null;
    }
  }

  // ✅ NUEVO: Comparar múltiples métodos de PnL
  async comparePnLMethods(mint, currentPrice) {
    try {
      const position = await this.redis.hgetall(`position:${mint}`);
      if (!position || !position.entryPrice) {
        return null;
      }

      const entryPrice = parseFloat(position.entryPrice);
      const solSpent = parseFloat(position.solAmount);
      const tokensAmount = parseFloat(position.tokensAmount);

      // Método 1: Precio simple (sin fees)
      const method1 = {
        name: 'Price Change (no fees)',
        pnlPercent: ((currentPrice - entryPrice) / entryPrice) * 100
      };

      // Método 2: SOL inicial vs SOL final (con fees)
      const FEE_PERCENT = 0.01;
      const solBeforeFee = tokensAmount * currentPrice;
      const solAfterFee = solBeforeFee * (1 - FEE_PERCENT);
      const pnlSOL = solAfterFee - solSpent;
      
      const method2 = {
        name: 'SOL-based (with fees)',
        pnlSOL: pnlSOL,
        pnlPercent: (pnlSOL / solSpent) * 100
      };

      // Método 3: Tokens valorados al precio actual
      const method3 = {
        name: 'Token valuation',
        tokenValue: tokensAmount * currentPrice,
        pnlPercent: ((tokensAmount * currentPrice - solSpent) / solSpent) * 100
      };

      console.log(`\n📊 PnL Comparison for ${mint.slice(0, 8)}:`);
      console.log(`   Entry: $${entryPrice.toFixed(10)} | Current: $${currentPrice.toFixed(10)}`);
      console.log(`   ${method1.name}: ${method1.pnlPercent.toFixed(2)}%`);
      console.log(`   ${method2.name}: ${method2.pnlPercent.toFixed(2)}% (${method2.pnlSOL.toFixed(4)} SOL)`);
      console.log(`   ${method3.name}: ${method3.pnlPercent.toFixed(2)}%\n`);

      return {
        method1,
        method2,
        method3,
        recommended: method2 // Método 2 es el más preciso
      };

    } catch (error) {
      console.error('❌ Error comparing PnL methods:', error.message);
      return null;
    }
  }
}
