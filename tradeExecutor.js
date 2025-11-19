// tradeExecutor.js - Simplified Pump.fun executor focused on DRY_RUN (paper)
// ✅ Diseñado para el Pump.fun Sniper (Flintr)
// ✅ PnL correcto usando priceService
// ⚠️ LIVE trading aún NO implementado (seguro por defecto)

import { getPriceService } from './priceService.js';

const priceService = getPriceService();

export class TradeExecutor {
  /**
   * @param {string} privateKey - clave privada base58 (cuando se implemente LIVE)
   * @param {string} rpcUrl - RPC URL (para futuro LIVE / diagnósticos)
   * @param {boolean} dryRun - true = PAPER (simulado), false = LIVE (no implementado)
   */
  constructor(privateKey, rpcUrl, dryRun = true) {
    this.privateKey = privateKey;
    this.rpcUrl = rpcUrl;
    this.dryRun = !!dryRun;
  }

  /**
   * BUY token (Pump.fun)
   * En DRY_RUN:
   *  - Usa priceService.getPrice(mint, true) para obtener precio de bonding curve
   *  - Calcula tokens = solAmount / price
   *  - No llama a RPC para enviar transacciones
   *
   * @param {string} mint
   * @param {number} solAmount
   * @param {string} dex - ignorado de momento, por compatibilidad
   * @param {number} slippage - ignorado de momento, por compatibilidad
   */
  async buyToken(mint, solAmount, _dex = 'pump', _slippage = 0.15) {
    if (!mint || !solAmount || solAmount <= 0) {
      return {
        success: false,
        error: 'invalid_parameters',
      };
    }

    // 🔐 Por seguridad: LIVE aún no implementado
    if (!this.dryRun) {
      console.log('⚠️ TradeExecutor.buyToken LIVE solicitado, pero no está implementado.');
      console.log('   Mantén DRY_RUN=true hasta integrar PumpPortal o Pump.fun program.');
      return {
        success: false,
        error: 'live_trading_not_implemented',
      };
    }

    try {
      console.log(`\n📝 [DRY_RUN] Simulando BUY: ${solAmount} SOL en mint ${mint.slice(0, 8)}...`);

      // 1) Obtener precio desde bonding curve / SDK
      let entryPrice = 0;
      try {
        const priceData = await priceService.getPrice(mint, true);
        if (priceData && priceData.price && !isNaN(priceData.price)) {
          entryPrice = Number(priceData.price);
        }
      } catch (e) {
        console.log('⚠️ priceService.getPrice falló en buyToken:', e.message);
      }

      // 2) Fallback si no hay precio (caso raro)
      if (!entryPrice || entryPrice <= 0) {
        // Valor arbitrario muy pequeño solo para que haya alguna cantidad de tokens
        entryPrice = 0.00000001;
        console.log(
          `   ⚠️ No se pudo obtener precio real, usando fallback entryPrice=${entryPrice}`,
        );
      }

      const tokensReceived = solAmount / entryPrice;

      const result = {
        success: true,
        simulated: true,
        dryRun: true,
        mint,
        solSpent: solAmount,
        tokensReceived,
        entryPrice,
        signature: `simulated_buy_${Date.now()}`,
      };

      console.log(
        `   ✅ [DRY_RUN] BUY simulado → ${tokensReceived.toLocaleString()} tokens @ ${entryPrice.toFixed(
          12,
        )} SOL (mint ${mint.slice(0, 8)})`,
      );

      return result;
    } catch (error) {
      console.error('❌ Error en buyToken (DRY_RUN):', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * SELL token (Pump.fun)
   * En DRY_RUN:
   *  - Usa priceService.calculateCurrentValue(mint, tokens) para el valor actual
   *  - Calcula PnL en SOL
   *  - No llama a RPC para enviar transacciones
   *
   * @param {string} mint
   * @param {number} tokenAmount
   * @param {string} dex - ignorado por ahora
   * @param {number} slippage - ignorado por ahora
   */
  async sellToken(mint, tokenAmount, _dex = 'pump', _slippage = 0.15) {
    if (!mint || !tokenAmount || tokenAmount <= 0) {
      return {
        success: false,
        error: 'invalid_parameters',
      };
    }

    // 🔐 LIVE aún no implementado
    if (!this.dryRun) {
      console.log('⚠️ TradeExecutor.sellToken LIVE solicitado, pero no está implementado.');
      console.log('   Mantén DRY_RUN=true hasta integrar PumpPortal o Pump.fun program.');
      return {
        success: false,
        error: 'live_trading_not_implemented',
      };
    }

    try {
      console.log(
        `\n📝 [DRY_RUN] Simulando SELL: ${tokenAmount.toLocaleString()} tokens de ${mint.slice(
          0,
          8,
        )}...`,
      );

      let solReceived = 0;
      let exitPrice = 0;
      let source = 'fallback';

      try {
        const valueData = await priceService.calculateCurrentValue(
          mint,
          tokenAmount,
        );

        if (valueData && valueData.solValue && valueData.marketPrice) {
          solReceived = Number(valueData.solValue);
          exitPrice = Number(valueData.marketPrice);
          source = valueData.source || 'market';
        }
      } catch (e) {
        console.log(
          '⚠️ priceService.calculateCurrentValue falló en sellToken:',
          e.message,
        );
      }

      if (!solReceived || solReceived <= 0) {
        // Fallback mínimo: asumir precio simbólico (no afectará demasiado si se usa solo para stats)
        exitPrice = 0.00000001;
        solReceived = tokenAmount * exitPrice;
        source = 'fallback_min_price';
        console.log(
          `   ⚠️ No se pudo obtener valor real, usando fallback exitPrice=${exitPrice}`,
        );
      }

      const result = {
        success: true,
        simulated: true,
        dryRun: true,
        mint,
        tokensSold: tokenAmount,
        solReceived,
        exitPrice,
        source,
        signature: `simulated_sell_${Date.now()}`,
      };

      console.log(
        `   ✅ [DRY_RUN] SELL simulado → ${solReceived.toFixed(6)} SOL @ ${exitPrice.toFixed(
          12,
        )} (source=${source})`,
      );

      return result;
    } catch (error) {
      console.error('❌ Error en sellToken (DRY_RUN):', error.message);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * getBalance (solo para futuro LIVE / diagnósticos)
   * En DRY_RUN devolvemos un valor grande artificial para que no bloquee.
   */
  async getBalance() {
    if (this.dryRun) {
      // Simulamos que siempre hay suficiente saldo en paper mode
      return 999999;
    }

    // TODO: cuando implementemos LIVE:
    //  - Crear Connection con this.rpcUrl
    //  - Obtener balance real de la wallet
    console.log(
      '⚠️ getBalance LIVE no implementado todavía, devuelve 0 por seguridad.',
    );
    return 0;
  }
}
